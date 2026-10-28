import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { boundaryEscapes, originalEscapes, utf8Escapes, execute } from "./fuzz-shell-printf.ts";
import { run, healthy, matches, outputLimit } from "./fuzz-shell-control-flow.mjs";
import {
  decode,
  encode,
  type RecordedCase,
  type FuzzOptions,
  validateResultBytes,
} from "./fuzz-shell-results.ts";
import { createWaffleRunner } from "./waffle-compat.ts";

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
export function cases() {
  const result: { id: string; family: string; script: string }[] = [];
  const add = (family: string, script: string) =>
    result.push({ id: `echo-${result.length}`, family, script });
  for (const prefix of [
    "",
    "-n",
    "-e",
    "-E",
    "-ne",
    "-en",
    "-nE",
    "-Een",
    "-eEn",
    "-neE",
    "-n -e",
    "-e -E",
    "-E -e",
    "-n -n",
    "-e -n -E -e",
  ])
    for (const operands of ["", "''", "'' '' tail", "'a\\nb' tail", "'a\\cb' later"])
      add("options", `echo ${prefix} ${operands}`);
  for (const operand of ["-", "--", "-z", "-neZ", "-eZ", "-e-", "-n=", "ordinary", "", "-é"])
    for (const prefix of ["", "-e", "-n"])
      add("option-end", `echo ${prefix} ${quote(operand)} -n -e 'a\\nb'`);
  for (const escape of originalEscapes.concat(boundaryEscapes, utf8Escapes))
    for (const locale of ["C", "C.UTF-8"])
      add("escapes", `LC_ALL=${locale} echo -ne ${quote(escape)} tail`);
  for (const value of ["a\nb", "a\\\nb", "\\c", "a\\cb", "\\0\\xff", "\\uZ\\U", "\\\\\\q\\"])
    add("sequences", `echo -e ${quote(value)} later; echo recovered`);
  for (const script of [
    "echo -e lost >&-",
    "echo -ne '\\c' >&-",
    "echo -n >&-",
    "echo -e 'a\\cb' later; echo -E 'a\\nb'",
    "(echo -ne a); echo b",
    "echo -ne 'a\\0b\\xff' | cat",
  ])
    add("descriptors-state", script);
  return result;
}
type Case = ReturnType<typeof cases>[number];
type Options = FuzzOptions & { replays: string[]; oracle: string };
export function fingerprint() {
  const hash = createHash("sha256");
  for (const name of [
    "fuzz-shell-echo.ts",
    "fuzz-shell-printf.ts",
    "fuzz-shell-control-flow.mjs",
    "fuzz-shell-results.ts",
  ])
    hash.update(readFileSync(new URL(name, import.meta.url)));
  return hash.digest("hex");
}
export function validateFixture(fixture: { sourceHash: string; cases: RecordedCase<Case>[] }) {
  assert.equal(fixture.sourceHash, fingerprint());
  assert.deepEqual(
    fixture.cases.map((entry) => entry.case),
    cases(),
  );
  for (const [index, entry] of fixture.cases.entries()) {
    validateResultBytes(entry.bash, outputLimit, index);
    assert.ok(healthy(decode(entry.bash)), entry.case.id);
  }
  return fixture.cases;
}
async function main() {
  const { values } = parseArgs({
    options: {
      waffle: { type: "boolean", default: false },
      shell: { type: "string" },
      replay: { type: "string" },
      record: { type: "string" },
      oracle: { type: "string" },
      output: { type: "string" },
    },
  });
  const waffle = values.waffle;
  const options: Options = {
    seed: 1,
    count: 0,
    timeoutMs: 2000,
    replays: values.replay ? [resolve(values.replay)] : [],
    shell: values.shell,
    record: values.record,
    oracle: values.oracle ?? "/usr/bin/bash",
    output: values.output,
  };
  const scratch = mkdtempSync(resolve(process.env.TMPDIR ?? "/work/tmp", "echo-"));
  options.cwd = scratch;
  const interrupt = () => {
    options.interrupted = true;
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    const report = await measure(options, waffle);
    if (options.output) writeFileSync(options.output, JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report));
    if (report.counts.MISMATCH) process.exitCode = 1;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    rmSync(scratch, { recursive: true, force: true });
  }
}
async function measure(options: Options, waffle: boolean) {
  const fixturePath = options.replays[0];
  const recorded = fixturePath
    ? validateFixture(JSON.parse(readFileSync(fixturePath, "utf8")))
    : undefined;
  if (!recorded)
    assert.match(
      execFileSync(options.oracle, ["--version"], { encoding: "utf8" }),
      /version 5\.3\.15\(1\)-release/,
    );
  const selected = cases();
  const shell =
    options.shell ?? resolve(process.env.CARGO_TARGET_DIR ?? ".build/shell", "release/shell-cli");
  if (!waffle)
    assert.notEqual(
      realpathSync(shell),
      realpathSync(options.oracle),
      "candidate must not be Bash itself",
    );
  // A qualified scratch oracle keeps the original invocation name in diagnostics.
  const result = waffle
    ? await measureWaffle(options, shell, recorded)
    : await execute(selected, options, shell, recorded);
  const report = {
    sourceHash: fingerprint(),
    instrument: waffle ? "production real-Waffle shell-runtime" : "native shell-engine",
    ...result,
  };
  if (options.record) {
    assert.equal(result.counts.MISMATCH, 0, "refuse recording mismatched echo observations");
    writeFileSync(
      options.record,
      JSON.stringify(
        { schema: 1, sourceHash: fingerprint(), bash: "5.3.15(1)-release", cases: result.results },
        null,
        2,
      ) + "\n",
    );
  }
  return report;
}
async function measureWaffle(
  options: Options,
  modulePath: string,
  recorded?: RecordedCase<Case>[],
) {
  const directory = resolve(
    process.env.CARGO_TARGET_DIR ?? ".build/shell",
    "wasm32-wasip1/release",
  );
  const runner = await createWaffleRunner({
    modulePath,
    fixtureDirectory: directory,
    tmp: "/tmp/echo",
    env: { PATH: "/usr/bin:/bin", HOME: "/tmp/echo", TMP: "/tmp/echo", LC_ALL: "C", LANG: "C" },
  });
  const counts = { MATCH: 0, MISMATCH: 0 };
  const mismatches = [];
  const results = [];
  for (const [index, item] of cases().entries()) {
    if (options.interrupted) throw new Error("interrupted");
    const bash = recorded
      ? decode(recorded[index].bash)
      : await run(options.oracle, item.script, { ...options, argv0: "/usr/bin/bash" });
    assert.ok(healthy(bash), item.id);
    const actual = await runner(item.script);
    const candidate = {
      ...actual,
      status: actual.status ?? null,
      signal: null,
      timedOut: false,
      error: actual.crash ?? null,
    };
    const outcome = matches(bash, candidate) ? "MATCH" : "MISMATCH";
    counts[outcome]++;
    results.push({ case: item, bash: encode(bash) });
    if (outcome === "MISMATCH")
      mismatches.push({ case: item, bash: encode(bash), candidate: encode(candidate) });
  }
  return { total: cases().length, counts, mismatches, results };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
