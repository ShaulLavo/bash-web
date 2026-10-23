import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

test("the existing shell check stays red if any producer or moved check fails or skips", () => {
  const workflow: unknown = parse(
    readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
  );
  assert.ok(workflow && typeof workflow === "object" && "jobs" in workflow);
  const jobs = workflow.jobs;
  assert.ok(jobs && typeof jobs === "object" && "shell" in jobs);
  const shell = jobs.shell;
  assert.ok(
    shell && typeof shell === "object" && "needs" in shell && "if" in shell && "steps" in shell,
  );
  assert.deepEqual(
    shell.needs,
    Object.keys(jobs).filter((key) => key !== "shell"),
  );
  assert.equal(shell.if, "always()");
  assert.ok(Array.isArray(shell.steps));
  assert.equal(shell.steps.length, 1);
  const gate: unknown = shell.steps[0];
  assert.ok(gate && typeof gate === "object" && "run" in gate && typeof gate.run === "string");
  assert.match(gate.run, /needs\.\*\.result/);
  assert.match(gate.run, /!= 'success'/);
  assert.match(gate.run, /exit 1/);
});

test("npm downloads use normalized dependency inputs rather than the root package version", () => {
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.doesNotMatch(workflow, /cache: npm/);
  assert.match(workflow, /key: npm-downloads-.*steps\.inputs\.outputs\.dependencies/);
  assert.match(
    workflow,
    /steps\.packages\.outputs\.cache-hit != 'true' \|\| steps\.downloads\.outputs\.cache-hit != 'true'/,
  );
});

test("native and WASI producers always execute instead of restoring successful results", () => {
  const text = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.doesNotMatch(
    text,
    /id: (binaries|checked)|wasi-checked-|key: native-|steps\.(binaries|checked)/,
  );
  assert.match(text, /npm run test:shell:wasi -- --prebuilt \.build\/ci-native/);
  assert.match(text, /-p shell-engine -p shell-compat-fixtures -j2/);
  assert.match(text, /node scripts\/ci-artifacts\.ts pack \.build\/ci-native/);
  const action = readFileSync(
    new URL("../.github/actions/native/action.yml", import.meta.url),
    "utf8",
  );
  assert.match(action, /node scripts\/ci-artifacts\.ts stage \.build\/ci-native/);
});

function object(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function jobs() {
  return object(
    object(parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8")))
      .jobs,
  );
}

function commands(job: unknown): string {
  const steps = object(job).steps;
  assert.ok(Array.isArray(steps));
  return steps
    .map((step: unknown) => object(step).run)
    .filter((run): run is string => typeof run === "string")
    .join("\n");
}

test("the actual aggregate shell command rejects each non-success result in every position", () => {
  const workflowJobs = jobs();
  const aggregate = object(workflowJobs.shell);
  assert.equal(aggregate.if, "always()");
  const needs = aggregate.needs;
  assert.ok(Array.isArray(needs));
  const command = commands(aggregate);
  const evaluate = (results: readonly string[]) =>
    spawnSync("bash", [
      "-euc",
      command.replace(/\$\{\{ join\(needs\.\*\.result, ' '\) \}\}/, results.join(" ")),
    ]).status;
  assert.equal(evaluate(needs.map(() => "success")), 0);
  for (const failure of ["failure", "skipped", "cancelled"]) {
    for (const position of needs.keys())
      assert.notEqual(
        evaluate(needs.map((_, index) => (index === position ? failure : "success"))),
        0,
      );
  }
});

test("each moved current-main gate has one owner", () => {
  const workflowJobs = jobs();
  const expected: Record<string, readonly string[]> = {
    prepare: ["sources:browser", "build:worker"],
    layers: ["test:check-layers", "check:layers", "typecheck:layers"],
    quality: ["quality:js", "test:ci", "test:guest-build", "typecheck:guest-build", "typecheck:ci"],
    native: [
      "check:rust",
      "build:shell",
      "build:test-guest",
      "prepare:wasi-tests",
      "check:capabilities",
    ],
    wasi: ["test:shell:wasi"],
    browser: ["build:browser:assets:ci", "test:runtime:terminal", "test:browser"],
    "own-shell-compatibility": ["test:shell:scoreboard", "compat:shell:prebuilt"],
  };
  const ownership = Object.entries(workflowJobs).flatMap(([owner, job]) =>
    Array.from(commands(job).matchAll(/npm run ([\w:-]+)/g), (match) => ({
      owner,
      command: match[1],
    })),
  );
  for (const [owner, gates] of Object.entries(expected)) {
    for (const command of gates)
      assert.deepEqual(
        ownership.filter((entry) => entry.command === command).map((entry) => entry.owner),
        [owner],
        command,
      );
  }
  const fuzz = commands(workflowJobs.fuzz);
  for (const family of [
    "braces",
    "words",
    "arithmetic",
    "readonly",
    "substitutions",
    "parse-boundaries",
    "control-flow",
    "job-lifetime",
    "functions",
    "path",
    "printf",
    "echo",
  ])
    assert.equal(
      fuzz.match(new RegExp(`npm run fuzz:shell-${family}:ci\\b`, "g"))?.length,
      1,
      family,
    );
  assert.doesNotMatch(fuzz, /--shell \.build\/shell\/release\/shell-engine/);
  const browser = commands(workflowJobs.browser);
  assert.doesNotMatch(browser, /--workers|--grep|--project|--retries|--timeout/);
});

test("quality package recipes preserve complete current selections", () => {
  const pkg = object(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")));
  const scripts = object(pkg.scripts);
  assert.equal(scripts["typecheck:browser"], scripts.typecheck);
  assert.equal(
    scripts["quality:js"],
    "npm run test:browser:package && npm run format:check && npm run lint && npm run typecheck && npm run check:unused && npm run check:duplicates && npm run test:quality-gates",
  );
  assert.equal(
    scripts["test:guest-build"],
    "node --test scripts/test-utility-artifacts.ts scripts/test-wasi-build.ts scripts/test-verify-wasi-guests.ts scripts/test-build-compat-control.ts",
  );
  assert.equal(
    scripts["test:shell:scoreboard"],
    "npm run build:node-harness && node --test scripts/test-shell-scoreboard*.mjs scripts/test-shell-scoreboard-instrument.ts scripts/test-compat-selection.mjs scripts/test-own-shell-runner.mjs scripts/test-own-shell-root.ts scripts/test-own-shell-permissions.ts scripts/test-own-shell-descriptors.ts scripts/test-own-shell-printf-assignment.ts scripts/test-own-shell-extglob.ts scripts/test-own-shell-pathname.ts scripts/test-own-shell-tilde.ts scripts/test-own-shell-regex-groups.ts scripts/test-own-shell-file-substitution.ts scripts/test-own-shell-read-scalar.ts scripts/test-own-shell-indirect-special.ts scripts/test-own-shell-select.ts scripts/test-own-shell-declarations.ts scripts/test-own-shell-index-names.ts scripts/test-own-shell-parameter-lists.ts scripts/test-own-shell-function-names.ts scripts/test-own-shell-trap-registration.ts scripts/test-own-shell-pipeline-broken-pipe.ts scripts/test-own-shell-nameref-invalid.ts scripts/test-bash-compat*.mjs",
  );
});

test("compatibility keeps frozen identity, diagnostics, echo and target baseline wiring", () => {
  const compat = object(jobs()["own-shell-compatibility"]);
  const env = object(compat.env);
  for (const [key, value] of Object.entries({
    BASH_COMPAT_MODE: "frozen",
    BASH_COMPAT_ENGINES: "own-shell",
    BASH_COMPAT_JOBS: 4,
    BASH_COMPAT_SKIP_BUILD: "1",
    BASH_COMPAT_RECORD: "0",
    BASH_COMPAT_BASE_REF: "${{ github.event.pull_request.base.sha || github.event.before }}",
  }))
    assert.equal(env[key], value);
  const run = commands(compat);
  assert.match(run, /node --test scripts\/test-diagnose-compat.ts/);
  assert.match(
    run,
    /node scripts\/diagnose-compat.ts "\$\{\{ runner.temp \}\}\/own-shell-diagnostics" -- npm run compat:shell:prebuilt/,
  );
  assert.match(
    run,
    /fuzz:shell-echo:ci -- --waffle --shell "\$GITHUB_WORKSPACE\/\.build\/shell\/wasm32-wasip1\/release\/shell-runtime.wasm"/,
  );
  const text = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.equal(text.match(/TMPDIR: \$\{\{ runner.temp \}\}/g)?.length, 2);
  const darwin = object(
    parse(readFileSync(new URL("../.github/workflows/printf-darwin.yml", import.meta.url), "utf8")),
  );
  assert.ok(object(darwin.jobs)["printf-darwin"]);
  assert.match(commands(object(darwin.jobs)["printf-darwin"]), /en_US.UTF-8/);
});

function recipes(): Record<string, unknown> {
  return object(
    object(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))).scripts,
  );
}

function expanded(command: string, ancestors: readonly string[] = []): string {
  return command.replace(/npm run ([\w:-]+)/g, (_, name: string) => {
    assert.ok(!ancestors.includes(name), `recursive npm recipe ${name}`);
    const recipe = recipes()[name];
    assert.equal(typeof recipe, "string", `missing npm recipe ${name}`);
    return expanded(String(recipe), ancestors.concat([name]));
  });
}

test("shell notices have exactly one native producer and a Cargo-free browser consumer", () => {
  const owners = Object.entries(jobs()).flatMap(([owner, job]) =>
    Array.from(expanded(commands(job)).matchAll(/node scripts\/notices\.mjs/g), () => owner),
  );
  assert.deepEqual(owners, ["native"]);
  const browser = expanded(commands(jobs().browser));
  assert.equal(browser.match(/node scripts\/browser-notices\.mjs/g)?.length, 1);
  assert.match(browser, /node scripts\/ci-artifacts\.ts notices \.build\/ci-native/);
  assert.doesNotMatch(browser, /\b(cargo|rustup)\b|scripts\/notices\.mjs/);
  const native = expanded(commands(jobs().native));
  assert.ok(
    native.indexOf("node scripts/notices.mjs") <
      native.indexOf("node scripts/ci-artifacts.ts pack"),
  );
  assert.match(expanded("npm run build:browser:assets"), /node scripts\/notices\.mjs/);
  assert.equal(browser.match(/vite build/g)?.length, 1);
});

test("compatibility reuses its same-job node build while standalone commands still build fresh", () => {
  const compat = expanded(commands(jobs()["own-shell-compatibility"]));
  assert.equal(compat.match(/node scripts\/build-node-harness\.ts/g)?.length, 1);
  assert.equal(compat.match(/node scripts\/bash-compat\.mjs/g)?.length, 1);
  const run = commands(jobs()["own-shell-compatibility"]);
  assert.ok(
    run.indexOf("npm run test:shell:scoreboard") < run.indexOf("npm run fuzz:shell-echo:ci"),
  );
  assert.ok(
    run.indexOf("npm run fuzz:shell-echo:ci") < run.indexOf("npm run compat:shell:prebuilt"),
  );
  assert.equal(
    expanded("npm run compat:shell"),
    "node scripts/build-node-harness.ts && BASH_COMPAT_MODE=frozen BASH_COMPAT_ENGINES=own-shell BASH_COMPAT_UTILITY_DIR=${CARGO_TARGET_DIR:-.build/shell}/wasm32-wasip1/release node scripts/bash-compat.mjs",
  );
  for (const name of ["test:shell:scoreboard", "compat:shell"])
    assert.equal(
      expanded(`npm run ${name}`).match(/node scripts\/build-node-harness\.ts/g)?.length,
      1,
    );
});

test("browser apt uses the runner's existing HTTPS fallbacks instead of the slow Azure archive", () => {
  const browser = object(jobs().browser);
  assert.equal(browser["timeout-minutes"], 20);
  assert.ok(Array.isArray(browser.steps));
  const step = browser.steps.find(
    (candidate: unknown) =>
      object(candidate).name === "Use Ubuntu HTTPS archives for browser dependencies",
  );
  assert.ok(step, "configure apt transport before installing browser dependencies");
  const command = commands({ steps: [step] });
  const install = commands(browser);
  assert.match(install, /npx playwright install --with-deps chromium firefox/);
  assert.ok(install.indexOf(command) < install.indexOf("npx playwright install"));
  assert.ok(command.includes("/etc/apt/apt-mirrors.txt"));
  const directory = mkdtempSync(join(tmpdir(), "browser-apt-"));
  try {
    const mirrors = join(directory, "apt-mirrors.txt");
    const fallbacks =
      "https://archive.ubuntu.com/ubuntu/\tpriority:2\nhttps://security.ubuntu.com/ubuntu/\tpriority:3\n";
    writeFileSync(mirrors, "http://azure.archive.ubuntu.com/ubuntu/\tpriority:1\n" + fallbacks);
    const run = command.replaceAll("sudo ", "").replaceAll("/etc/apt/apt-mirrors.txt", mirrors);
    const result = spawnSync("bash", ["-euc", run], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(mirrors, "utf8"), fallbacks);
    assert.equal(spawnSync("bash", ["-euc", run]).status, 0);
    assert.equal(readFileSync(mirrors, "utf8"), fallbacks);
    writeFileSync(mirrors, "http://azure.archive.ubuntu.com/ubuntu/\tpriority:1\n");
    assert.notEqual(spawnSync("bash", ["-euc", run]).status, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
