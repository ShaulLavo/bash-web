import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import test from "node:test";
import {
  classify,
  conditionKinds,
  coverage,
  defaultCount,
  defaultTimeoutMs,
  depths,
  errexitContexts,
  families,
  fingerprint,
  generateCases,
  healthy,
  matches,
  matrixCases,
  optionsFor,
  outputLimit,
  prerequisiteCases,
  prerequisiteControls,
  reductions,
  render,
  run,
  terminators,
  validateFixture,
  values,
} from "./fuzz-shell-control-flow.mjs";

const options = { seed: 1, count: 0, timeoutMs: defaultTimeoutMs };
const observation = (patch = {}) => ({
  status: 0,
  signal: null,
  timedOut: false,
  error: null,
  stdout: Buffer.from("ok\n"),
  stderr: Buffer.alloc(0),
  ...patch,
});
function fixtureFor(count = 0) {
  const cases = generateCases(1, count);
  return {
    schema: 1,
    sourceHash: fingerprint(),
    seed: 1,
    count,
    timeoutMs: defaultTimeoutMs,
    bash: "GNU bash, version 5.3.15(1)-release (test)",
    oraclePath: "/usr/bin/bash",
    oracleArgs: ["-c", "SCRIPT"],
    provenance: "oracle-only",
    coverage: coverage(cases),
    cases: cases.map((item) => ({
      case: item,
      bash: {
        status: 0,
        signal: null,
        timedOut: false,
        error: null,
        stdoutBase64: "",
        stderrBase64: "",
      },
    })),
  };
}
const path = "shell-control-flow-seed-1.json";

test("generator is deterministic, count-bounded and independently seeded", () => {
  for (const seed of [0, 1, 42, 0xffffffff]) {
    const cases = generateCases(seed, defaultCount);
    assert.deepEqual(cases, generateCases(seed, defaultCount));
    assert.equal(cases.length, matrixCases().length + defaultCount);
    assert.equal(new Set(cases.map((item) => item.id)).size, cases.length);
    assert.ok(cases.length < 2500);
    for (const item of cases) {
      assert.equal(item.script, render(item));
      assert.ok(item.script.length < 4096, item.id);
      assert.ok(item.depth >= 0 && item.depth <= 3);
      assert.ok(!item.script.includes("set -f"), "no incidental unsupported set flags");
    }
  }
  assert.notDeepEqual(generateCases(1, 20), generateCases(42, 20));
  assert.notDeepEqual(generateCases(0, 20), generateCases(1, 20));
  assert.deepEqual(generateCases(42, 20).slice(0, matrixCases().length), matrixCases());
});

test("fixed matrix covers every control family and requested dimension at depths 0..3", () => {
  const cases = matrixCases();
  const found = coverage(cases);
  assert.deepEqual(found.families, families.toSorted());
  assert.deepEqual(found.depths, depths);
  assert.deepEqual(found.conditions, conditionKinds.toSorted());
  assert.deepEqual(found.terminators, terminators.toSorted());
  assert.deepEqual(found.contexts, errexitContexts.toSorted());
  for (const value of values) assert.ok(found.values.includes(value));
  for (const family of families.filter((item) => item !== "loop-control"))
    for (const depth of depths)
      assert.ok(
        cases.some((item) => item.family === family && item.depth === depth),
        family + " " + depth,
      );
  const combinations = errexitContexts.flatMap((context) =>
    depths.map((depth) => ({ context, depth })),
  );
  for (const { context, depth } of combinations)
    for (const failure of ["false", "return7"])
      for (const finalFailure of [false, true])
        assert.ok(
          cases.some(
            (item) =>
              item.family === "errexit" &&
              item.context === context &&
              item.depth === depth &&
              item.failure === failure &&
              item.finalFailure === finalFailure,
          ),
        );
  for (const verb of ["break", "continue"])
    for (const loops of [1, 2, 3])
      for (const level of ["1", "2", "3", "4", "0", "-1", "bad", "1 2"])
        assert.ok(
          cases.some((item) => item.verb === verb && item.loops === loops && item.level === level),
        );
  assert.ok(cases.some((item) => item.empty));
  assert.ok(cases.some((item) => item.omitted));
  assert.ok(cases.some((item) => item.family === "syntax-failure"));
  assert.ok(cases.some((item) => item.family === "runtime-failure"));
});

test("status observation preserves rather than masks failing final commands", () => {
  for (const item of generateCases(42, 30).filter((item) => item.control === undefined)) {
    assert.ok(
      item.script.endsWith('cf_status=$?; printf "status=%s\\n" "$cf_status"; exit "$cf_status"\n'),
    );
    if (item.family === "errexit") assert.ok(item.script.includes("set -e;"));
  }
  const list = matrixCases().find((item) => item.family === "for-list" && !item.empty);
  assert.ok(list.script.includes("'' 'a b' '*' \"$v\""));
  const quotedCase = matrixCases().find((item) => item.family === "case");
  assert.ok(quotedCase.script.includes('(a|"a b")'));
  assert.ok(quotedCase.script.includes('("*")'));
  assert.ok(matrixCases().some((item) => item.script.includes('[[ $v == "a*" ]]')));
});

test("prerequisite matrix preserves no-loss provenance and bounded semantic scope", () => {
  assert.equal(
    new Set(prerequisiteControls.map((item) => item.name)).size,
    prerequisiteControls.length,
  );
  assert.equal(prerequisiteCases().length, prerequisiteControls.length * depths.length);
  for (const control of prerequisiteControls) {
    assert.ok(Number.isInteger(control.expected.status));
    assert.equal(typeof control.expected.stdout, "string");
    for (const depth of depths) {
      const item = prerequisiteCases().find(
        (item) => item.control === control.name && item.depth === depth,
      );
      assert.ok(item, control.name);
      assert.ok(item.tags.includes("control=" + control.name));
      assert.deepEqual(item.origins, control.origins);
      assert.equal(item.script, render(item));
    }
    if (control.family === "regex")
      assert.ok(!control.script.includes("("), "capture groups are explicitly outside this gate");
    if (control.family === "time-format") {
      assert.equal(control.expected.stdout, "done\n");
      assert.ok(control.script.includes("[0-9]{6}"));
      assert.ok(!control.script.includes("printf '%s' \"$EPOCHREALTIME\""));
    }
  }
  const origins = Array.from(
    new Set(prerequisiteControls.flatMap((control) => control.origins)),
  ).sort();
  const wanted = [
    "oils:parse-errors:93",
    "brush-suite:options/set-e:140",
    "brush-suite:options/shopt-nullglob:12",
    "brush-suite:well_known_vars:27",
    "bashkit-suite:glob-options:64",
    "bashkit-suite:variables:640",
  ].concat(
    [66, 67, 68, 69].map((id) => "brush-suite:extended_tests:" + id),
    [2, 4, 5, 8, 10].map((id) => "brush-suite:options/inherit-errexit:" + id),
  );
  wanted.sort();
  assert.deepEqual(origins, wanted);
  for (const setting of ["default", "off", "on"])
    for (const kind of [
      "assignment",
      "backtick",
      "nested-echo",
      "nested-assignment",
      "local-declaration",
      "local-assignment",
      "multiple",
    ])
      assert.ok(
        prerequisiteControls.some((control) => control.name === `inherit-${setting}-${kind}`),
      );
  for (const mode of ["on", "off"])
    for (const kind of [
      "unmatched",
      "matches",
      "quoted-matches",
      "variable",
      "quoted-variable",
      "partial-quote",
      "question",
      "bracket",
    ])
      assert.ok(
        prerequisiteControls.some((control) => control.name === `nullglob-${mode}-${kind}`),
      );
  const extglob = prerequisiteCases().find(
    (item) => item.control === "extglob-no-match" && item.depth === 3,
  );
  assert.ok(
    extglob.script.startsWith("set -e\nshopt -s extglob\n"),
    "parse-affecting option precedes the compound read unit",
  );
});

test("only successful Bash plus explicitly unsupported syntax earns UNSUPPORTED", () => {
  const candidate = observation({
    status: 2,
    stdout: Buffer.alloc(0),
    stderr: Buffer.from("shell-engine: unsupported syntax: compound command\n"),
  });
  assert.equal(classify(observation(), candidate), "UNSUPPORTED");
  assert.equal(classify(observation(), candidate, true), "MISMATCH");
  for (const status of [1, 2, 7, 127]) {
    assert.equal(classify(observation({ status }), candidate), "MISMATCH");
    assert.equal(
      classify(
        observation({ status, stdout: Buffer.alloc(0) }),
        observation({ stdout: Buffer.alloc(0) }),
      ),
      "MISMATCH",
      "a failed Bash script cannot silently succeed",
    );
  }
  for (const patch of [
    { status: 127 },
    { stdout: Buffer.from("partial") },
    { timedOut: true },
    { error: "ENOBUFS" },
    { signal: "SIGKILL" },
  ])
    assert.equal(classify(observation(), { ...candidate, ...patch }), "MISMATCH");
  for (const stderr of [
    "",
    "parse error: unsupported syntax\n",
    "unsupported option: -e\n",
    "unsupported feature: set flag -e\n",
    "unsupported predicate\n",
    "syntax error\n",
    "command not found\n",
  ])
    assert.equal(
      classify(observation(), { ...candidate, stderr: Buffer.from(stderr) }),
      "MISMATCH",
      stderr,
    );
  assert.equal(classify(observation({ status: 2, stdout: Buffer.alloc(0) }), candidate), "MATCH");
});

test("matching compares status and exact stdout bytes, not diagnostic wording", () => {
  assert.ok(matches(observation({ stderr: Buffer.from("warning") }), observation()));
  assert.ok(!matches(observation(), observation({ stdout: Buffer.from("ok\r\n") })));
  assert.ok(!matches(observation(), observation({ stdout: Buffer.from([0xff]) })));
  assert.ok(!matches(observation(), observation({ status: 1 })));
  for (const patch of [
    { status: null },
    { status: -1 },
    { status: 256 },
    { status: 1.5 },
    { signal: "SIGTERM" },
    { timedOut: true },
    { error: "ENOENT" },
  ]) {
    assert.ok(!healthy(observation(patch)));
    assert.ok(!matches(observation(patch), observation(patch)));
  }
});

test("structural shrinking keeps the control-flow family and failure context", () => {
  for (const item of matrixCases()
    .filter((item) => item.depth === 3)
    .slice(0, 250)) {
    const candidates = reductions(item);
    assert.ok(candidates.length > 0);
    for (const candidate of candidates) {
      assert.ok(candidate.script.length < item.script.length);
      assert.equal(candidate.family, item.family);
      assert.equal(candidate.context, item.context);
      assert.equal(candidate.failure, item.failure);
      assert.equal(candidate.condition, item.condition);
      assert.equal(candidate.terminator, item.terminator);
      assert.equal(candidate.level, item.level);
    }
  }
});

test("fixture validation regenerates all scripts and rejects altered provenance and bytes", () => {
  const fixture = fixtureFor();
  assert.equal(validateFixture(path, fixture, options).length, fixture.cases.length);
  const mutations = [
    (value) => {
      value.schema++;
    },
    (value) => {
      value.sourceHash = "0".repeat(64);
    },
    (value) => {
      value.bash = "GNU bash, version 5.3.150(1)-release";
    },
    (value) => {
      value.bash = "GNU bash, version 5.2.0(1)-release";
    },
    (value) => {
      value.oraclePath = "/bin/bash";
    },
    (value) => {
      value.oracleArgs.unshift("--noprofile");
    },
    (value) => {
      value.provenance = "matched-with-unsupported-options";
    },
    (value) => {
      value.count++;
    },
    (value) => {
      value.timeoutMs++;
    },
    (value) => {
      value.seed = -1;
    },
    (value) => {
      value.seed = 42;
    },
    (value) => {
      value.seed = "1";
    },
    (value) => {
      value.cases.pop();
    },
    (value) => {
      value.cases.reverse();
    },
    (value) => {
      value.coverage.depths.pop();
    },
    (value) => {
      value.cases[0].case.script += "\nprintf injected";
    },
    (value) => {
      value.cases[0].case.id = "changed";
    },
    (value) => {
      value.cases[0].case.tags.push("changed");
    },
    (value) => {
      value.cases[0].bash.status = null;
    },
    (value) => {
      value.cases[0].bash.status = 256;
    },
    (value) => {
      value.cases[0].bash.signal = "SIGKILL";
    },
    (value) => {
      value.cases[0].bash.timedOut = true;
    },
    (value) => {
      value.cases[0].bash.error = "ENOENT";
    },
    (value) => {
      value.cases[0].bash.stdoutBase64 = "not base64";
    },
    (value) => {
      value.cases[0].bash.stderrBase64 = "YQ";
    },
    (value) => {
      value.cases[0].bash.stdoutBase64 = Buffer.alloc(outputLimit + 1).toString("base64");
    },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(fixture);
    mutate(changed);
    assert.throws(() => validateFixture(path, changed, options));
  }
  assert.throws(
    () => validateFixture("shell-control-flow-seed-42.json", fixture, options),
    /filename seed/,
  );
  assert.throws(() => validateFixture("arbitrary.json", fixture, options), /filename seed/);
  assert.throws(
    () => validateFixture(path, fixture, { ...options, seed: 42, explicitSeed: true }),
    /seed differs/,
  );
});

test("CLI rejects malformed or unbounded options and misleading capture modes", () => {
  assert.equal(optionsFor(["--seed=4294967295", "--count", "0"]).seed, 0xffffffff);
  for (const args of [
    ["--seed", "-1"],
    ["--seed", "1.5"],
    ["--seed", "4294967296"],
    ["--count", "10001"],
    ["--count", "NaN"],
    ["--timeout-ms", "0"],
    ["--timeout-ms", "30001"],
    ["--shell"],
    ["--unknown", "x"],
    ["--record", path, "--replay", path],
    ["--record-oracle", path, "--self-control"],
    ["--record-oracle", path, "--shell", "/bin/anything"],
    ["--self-control", "--shell", "/bin/anything"],
  ])
    assert.throws(() => optionsFor(args), args.join(" "));
});

test("process runner caps output/time and kills owned descendants before teardown", async (context) => {
  const scratch = mkdtempSync(
    resolve(process.env.RUNNER_TEMP ?? "/work/tmp", "bash-web-control-flow-source-test-"),
  );
  context.after(() => rmSync(scratch, { recursive: true, force: true }));
  const config = { cwd: scratch, timeoutMs: 1500 };
  const wrapper = resolve(scratch, "candidate.cjs");
  writeFileSync(wrapper, `#!${process.execPath}\neval(process.argv[3]);\n`);
  chmodSync(wrapper, 0o700);
  const success = await run(wrapper, "process.stdout.write('ok\\n')", config);
  assert.ok(matches(observation(), success));
  const inherited = await run(
    wrapper,
    "process.stdout.write(JSON.stringify({bash:process.env.BASH_ENV,path:process.env.PATH,home:process.env.HOME,lc:process.env.LC_ALL}))",
    config,
  );
  const environment = JSON.parse(inherited.stdout.toString());
  assert.ok(environment.home.startsWith(scratch + "/process-"));
  assert.deepEqual(
    { ...environment, home: "SANDBOX" },
    {
      path: "/usr/bin:/bin",
      home: "SANDBOX",
      lc: "C",
    },
  );
  const writer = await run(
    wrapper,
    "require('node:fs').writeFileSync('saved','oracle-only');",
    config,
  );
  assert.equal(writer.status, 0);
  const reader = await run(
    wrapper,
    "process.stdout.write(String(require('node:fs').existsSync('saved')));",
    config,
  );
  assert.equal(reader.stdout.toString(), "false", "candidate cannot read an oracle's saved file");
  const timeout = await run(wrapper, "while(true) {}", { ...config, timeoutMs: 150 });
  assert.equal(timeout.timedOut, true);
  assert.equal(timeout.error, "ETIMEDOUT");
  assert.equal(classify(timeout, timeout), "MISMATCH");
  const overflow = await run(wrapper, "process.stdout.write('x'.repeat(1000000))", config);
  assert.equal(overflow.error, "ENOBUFS");
  assert.ok(overflow.stdout.length <= outputLimit);
  const missing = await run(resolve(scratch, "not-a-binary"), ":", config);
  assert.equal(missing.error, "ENOENT");
  const childSource =
    "const {spawn}=require('node:child_process');const p=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(p.pid);p.unref();";
  const descendant = await run(wrapper, childSource, config);
  assert.equal(descendant.status, 0);
  const pid = Number(descendant.stdout.toString().trim());
  assert.ok(pid > 0);
  if (existsSync("/proc/" + pid + "/stat")) {
    const stat = readFileSync("/proc/" + pid + "/stat", "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
    assert.ok(["Z", "X"].includes(state), "descendant must not consume scratch");
  }
  assert.deepEqual(readdirSync(scratch), ["candidate.cjs"]);
});

test("checked-in oracles pin the default count, timeout and generator source", () => {
  for (const seed of [1, 42]) {
    const fixturePath = new URL(`./fixtures/shell-control-flow-seed-${seed}.json`, import.meta.url);
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
    const cases = validateFixture(fileURLToPath(fixturePath), fixture, {
      seed,
      count: defaultCount,
      timeoutMs: defaultTimeoutMs,
      explicitSeed: true,
    });
    assert.equal(cases.length, matrixCases().length + defaultCount);
    assert.ok(fixture.cases.some((entry) => entry.bash.status === 0));
    assert.ok(fixture.cases.some((entry) => entry.bash.status === 1));
    assert.ok(fixture.cases.some((entry) => entry.bash.status === 2));
    assert.ok(fixture.cases.some((entry) => entry.bash.status === 7));
    assert.ok(fixture.cases.some((entry) => entry.bash.status === 127));
    for (const entry of fixture.cases) {
      if (entry.case.family === "syntax-failure") {
        assert.equal(entry.bash.status, 2, entry.case.id);
        assert.equal(entry.bash.stdoutBase64, "", entry.case.id);
      } else if (
        ["condition", "if", "while", "until", "for-list", "for-arithmetic", "case"].includes(
          entry.case.family,
        )
      ) {
        assert.ok(
          [0, 1].includes(entry.bash.status),
          "valid grammar must not accidentally record a parse/flag rejection: " + entry.case.id,
        );
      }
      if (entry.case.failure === "invalid-regex") assert.equal(entry.bash.status, 2, entry.case.id);
      if (entry.case.control !== undefined) {
        const control = prerequisiteControls.find((control) => control.name === entry.case.control);
        assert.ok(control, entry.case.id);
        assert.equal(entry.bash.status, control.expected.status, entry.case.id);
        assert.equal(
          Buffer.from(entry.bash.stdoutBase64, "base64").toString(),
          control.expected.stdout,
          entry.case.id,
        );
      }
    }
    for (const failure of ["exec-for-persists", "exec-if-persists", "redirected-for-restores"]) {
      const entry = fixture.cases.find(
        (entry) =>
          entry.case.family === "redirection" &&
          entry.case.depth === 0 &&
          entry.case.failure === failure,
      );
      assert.ok(entry, failure);
      assert.equal(entry.bash.status, 0);
      assert.equal(
        Buffer.from(entry.bash.stdoutBase64, "base64").toString(),
        failure === "redirected-for-restores" ? "restored\ninner\nstatus=0\n" : "saved:body\n",
      );
    }
  }
});
