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

test("native artifact consumers install the pinned SDK before verifying guests", () => {
  const action = object(
    parse(readFileSync(new URL("../.github/actions/native/action.yml", import.meta.url), "utf8")),
  );
  const steps = object(action.runs).steps;
  assert.ok(Array.isArray(steps));
  const entries = steps.map(object);
  const setup = entries.findIndex((step) => step.uses === "./.github/actions/wasi-sdk");
  const stage = entries.findIndex(
    (step) =>
      typeof step.run === "string" && step.run.includes("node scripts/ci-artifacts.ts stage"),
  );
  assert.ok(setup >= 0 && setup < stage, "WASI SDK must be installed before artifact staging");
  assert.equal(entries[setup].if, undefined, "SDK setup must not be conditional");
  for (const job of Object.values(jobs())) {
    const jobSteps = object(job).steps;
    assert.ok(Array.isArray(jobSteps));
    const uses = jobSteps.map(object).map((step) => step.uses);
    if (!uses.includes("./.github/actions/native")) continue;
    assert.ok(!uses.includes("./.github/actions/wasi-sdk"), "restore owns its SDK prerequisite");
  }
});

function object(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function assertPreStepEnv(env: unknown, scope: string) {
  if (!env) return;
  for (const [key, value] of Object.entries(object(env))) {
    if (typeof value !== "string") continue;
    for (const expression of value.matchAll(/\$\{\{(.*?)\}\}/gs))
      assert.doesNotMatch(
        expression[1].replace(/'(?:[^']|'')*'/g, ""),
        /\brunner\s*(?:\.|\[)/,
        `${scope}.${key}: runner context is unavailable before steps`,
      );
  }
}

test("runner context is rejected in workflow/job env rather than step env", () => {
  const expression = "${{ runner.temp }}/engine-layers.json";
  assert.throws(
    () => assertPreStepEnv({ OUTPUT: expression }, "jobs.fixture.env"),
    /jobs\.fixture\.env\.OUTPUT: runner context is unavailable before steps/,
  );
  assert.doesNotThrow(() =>
    assertPreStepEnv({ LITERAL: "runner.temp", QUOTED: "${{ 'runner.temp' }}" }, "env"),
  );
  const workflow = object(
    parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8")),
  );
  assertPreStepEnv(workflow.env, "env");
  for (const [id, job] of Object.entries(object(workflow.jobs)))
    assertPreStepEnv(object(job).env, `jobs.${id}.env`);
});

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
    prepare: ["sources:browser", "build:worker", "build:node-harness"],
    layers: ["test:check-layers", "check:layers", "typecheck:layers"],
    quality: ["quality:js", "test:ci", "test:guest-build", "typecheck:guest-build", "typecheck:ci"],
    native: [
      "check:rust",
      "build:shell",
      "build:test-guest",
      "build:rg",
      "prepare:wasi-tests",
      "check:capabilities",
    ],
    wasi: ["test:shell:wasi", "test:rg:wasi"],
    browser: ["build:browser:assets:ci", "test:runtime:terminal", "test:browser"],
    "own-shell-scoreboard": ["test:shell:scoreboard:prebuilt"],
    "own-shell-observation": ["compat:shell:prebuilt"],
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
    "node --test scripts/test-rg-source.ts scripts/test-utility-artifacts.ts scripts/test-wasi-build.ts scripts/test-verify-wasi-guests.ts scripts/test-build-compat-control.ts scripts/test-sed-source.ts scripts/test-python-build.ts",
  );
  assert.match(String(scripts["test:shell:scoreboard"]), /build:node-harness/);
  assert.match(
    expanded(String(scripts["test:shell:scoreboard"])),
    /node scripts\/scoreboard-tests\.mjs/,
  );
  assert.doesNotMatch(expanded(String(scripts["test:shell:scoreboard"])), /scripts\/test-/);
});

test("Python browser coverage consumes one cached producer and remains blocking", () => {
  const workflowJobs = jobs();
  const producer = object(workflowJobs.python);
  const browser = object(workflowJobs.browser);
  assert.ok(Array.isArray(browser.needs) && browser.needs.includes("python"));
  const steps = producer.steps;
  assert.ok(Array.isArray(steps));
  const entries = steps.map(object);
  const cache = entries.find((step) => step.id === "python-assets");
  assert.ok(cache);
  const key = String(object(cache.with).key);
  for (const input of [
    "scripts/python-source.ts",
    "scripts/build-python.ts",
    "scripts/wasi-build.ts",
    "scripts/verify-wasi-guests.ts",
    "patches/cpython-wasi-cwd.patch",
    "third-party/cpython/**",
    "package-lock.json",
  ])
    assert.ok(key.includes(input), input);
  const compile = entries.filter(
    (step) => step.run === "npm run build:python -- --output .build/python-assets",
  );
  assert.equal(compile.length, 1);
  assert.equal(compile[0].if, "steps.python-assets.outputs.cache-hit != 'true'");
  assert.match(commands(producer), /--stage \.build\/python-assets/);
  assert.doesNotMatch(commands(browser), /build:python -- --output/);
  const prepare = commands(browser);
  assert.ok(prepare.indexOf("prepare:python:browser") < prepare.indexOf("npm run test:browser"));
  assert.match(prepare, /build:python -- --stage \.build\/python-assets --output dist/);
});

test("compatibility keeps frozen identity, diagnostics, echo and target baseline wiring", () => {
  const compat = object(jobs()["own-shell-observation"]);
  const env = object(compat.env);
  for (const [key, value] of Object.entries({
    BASH_COMPAT_MODE: "frozen",
    BASH_COMPAT_ENGINES: "own-shell",
    BASH_COMPAT_JOBS: 4,
    BASH_COMPAT_SKIP_BUILD: "1",
    BASH_COMPAT_RECORD: "0",
  }))
    assert.equal(env[key], value);
  const run = commands(compat);
  assert.equal(env.BASH_COMPAT_BASE_REF, undefined);
  assert.match(run, /node scripts\/scoreboard-ci\.mjs baseline BASH_COMPAT_BASE_REF/);
  assert.match(
    commands(jobs().layers),
    /node scripts\/scoreboard-ci\.mjs baseline LAYERS_BASE_REF/,
  );
  assert.doesNotMatch(
    readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
    /github\.event\.pull_request\.base\.sha/,
  );
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

test("compatibility reuses the shared node build while standalone commands still build fresh", () => {
  const observation = expanded(commands(jobs()["own-shell-observation"]));
  assert.doesNotMatch(observation, /node scripts\/build-node-harness\.ts/);
  assert.equal(observation.match(/node scripts\/bash-compat\.mjs/g)?.length, 1);
  const run = commands(jobs()["own-shell-observation"]);
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
  assert.equal(
    expanded("npm run test:shell:scoreboard:prebuilt"),
    "node scripts/scoreboard-tests.mjs",
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

test("main concurrency is isolated by source while PRs retain latest-head cancellation", () => {
  const workflow = object(
    parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8")),
  );
  const concurrency = object(workflow.concurrency);
  assert.match(String(concurrency.group), /github\.event\.pull_request\.number \|\| github\.sha/);
  assert.equal(concurrency["cancel-in-progress"], "${{ github.event_name == 'pull_request' }}");
});

test("raw publication and the blocking cheap fold have no dependency cycle or whole-run wait", () => {
  const workflowJobs = jobs();
  const raw = object(workflowJobs["own-shell-compatibility"]);
  const floor = object(workflowJobs["score-floor"]);
  assert.deepEqual(raw.needs, ["prepare", "own-shell-scoreboard", "own-shell-observation"]);
  assert.deepEqual(floor.needs, ["prepare", "own-shell-compatibility"]);
  assert.ok(!raw.env || !("BASH_COMPAT_RAW" in object(raw.env)));
  assert.equal(
    object(raw.outputs)["raw-artifact-id"],
    "${{ steps.raw-upload.outputs.artifact-id }}",
  );
  assert.ok(Array.isArray(floor.steps));
  const download = floor.steps
    .map(object)
    .find((step) => step.uses === "actions/download-artifact@v4");
  assert.ok(download);
  assert.equal(
    object(download.with)["artifact-ids"],
    "${{ needs.own-shell-compatibility.outputs.raw-artifact-id }}",
  );
  const names = floor.steps.map((step: unknown) => object(step).name);
  assert.ok(names.indexOf("Upload cumulative main floor") < names.indexOf("Enforce qualification"));
  assert.doesNotMatch(
    commands(floor),
    /bash-compat\.mjs|compat:shell|build:|run.*status.*completed/,
  );
  assert.match(commands(floor), /scoreboard-ci\.mjs fold/);
  assert.match(commands(floor), /scoreboard-ci\.mjs enforce/);
  const producer = readFileSync(new URL("./bash-compat.mjs", import.meta.url), "utf8");
  assert.match(producer, /BASH_COMPAT_RAW !== "1"/);
  assert.doesNotMatch(producer, /requireMembership: true/);
});

test("raw mode belongs only to observation, never scorer or lifecycle test environments", () => {
  const workflow = object(
    parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8")),
  );
  assert.ok(!workflow.env || !("BASH_COMPAT_RAW" in object(workflow.env)));
  const workflowJobs = object(workflow.jobs);
  for (const [id, value] of Object.entries(workflowJobs)) {
    const job = object(value);
    assert.ok(!job.env || !("BASH_COMPAT_RAW" in object(job.env)), `${id} leaks raw mode`);
  }
  const raw = object(workflowJobs["own-shell-observation"]);
  assert.ok(Array.isArray(raw.steps));
  const owners = raw.steps
    .map(object)
    .filter((step) => step.env && "BASH_COMPAT_RAW" in object(step.env));
  assert.equal(owners.length, 1);
  assert.equal(owners[0].name, "Observe compatibility with the shared node build");
  assert.equal(object(owners[0].env).BASH_COMPAT_RAW, "1");
});

test("read tokens stay out of the replay environment and layer graphs are artifact-only", () => {
  for (const key of ["own-shell-compatibility", "own-shell-observation", "score-floor"]) {
    const job = object(jobs()[key]);
    assert.equal(object(job.permissions).actions, "read");
    assert.ok(!job.env || !("GH_TOKEN" in object(job.env)));
  }
  for (const key of ["own-shell-compatibility", "own-shell-observation"]) {
    const job = object(jobs()[key]);
    assert.ok(Array.isArray(job.steps));
    const tokens = job.steps
      .map(object)
      .filter((step) => step.env && "GH_TOKEN" in object(step.env));
    for (const step of tokens) {
      assert.equal(key, "own-shell-observation");
      assert.equal(step.name, "Bind qualification and resolve PR main floor");
    }
  }
  const layer = object(jobs().layers);
  assert.doesNotMatch(commands(layer), /--record/);
  assert.ok(Array.isArray(layer.steps));
  const check = layer.steps
    .map(object)
    .find((step) => typeof step.run === "string" && step.run.includes("npm run check:layers"));
  assert.ok(check);
  assert.equal(object(check.env).LAYERS_OUTPUT, "${{ runner.temp }}/engine-layers.json");
  const upload = layer.steps.map(object).find((step) => step.uses === "actions/upload-artifact@v4");
  assert.ok(upload);
  assert.equal(object(upload.with).path, object(check.env).LAYERS_OUTPUT);
  assert.equal(upload.if, "always()");
  assert.equal(object(upload.with)["retention-days"], 90);
});

test("browser stages ripgrep at its public-entry URL before bundling", () => {
  const browser = commands(jobs().browser);
  const staging = "cp public/programs/rg.wasm dist/rg.wasm";
  assert.ok(browser.includes(staging), "downloaded ripgrep must also reach the Vite input URL");
  assert.ok(browser.indexOf(staging) < browser.indexOf("npm run build:browser:assets:ci"));
});

test("scoreboard and observation run independently using one shared node build", () => {
  const workflowJobs = jobs();
  const scoreboard = object(workflowJobs["own-shell-scoreboard"]);
  const observation = object(workflowJobs["own-shell-observation"]);
  const publisher = object(workflowJobs["own-shell-compatibility"]);
  assert.deepEqual(scoreboard.needs, ["prepare", "native"]);
  assert.deepEqual(observation.needs, ["prepare", "native"]);
  assert.deepEqual(publisher.needs, ["prepare", "own-shell-scoreboard", "own-shell-observation"]);
  for (const job of [scoreboard, observation, publisher]) {
    assert.ok(!("if" in job), "failed or skipped prerequisites must block publication");
    assert.ok(!("continue-on-error" in job));
    assert.ok(Array.isArray(job.steps));
    const checked = job.steps.map(object).filter((step) => typeof step.run === "string");
    assert.ok(checked.every((step) => !("if" in step) && !("continue-on-error" in step)));
  }
  const buildOwners = Object.entries(workflowJobs).flatMap(([owner, job]) =>
    Array.from(
      expanded(commands(job)).matchAll(/node scripts\/build-node-harness\.ts/g),
      () => owner,
    ),
  );
  assert.deepEqual(buildOwners, ["prepare"]);
  const prepare = commands(workflowJobs.prepare);
  assert.ok(prepare.indexOf("npm run build:node-harness") < prepare.indexOf("tar -czf"));
  assert.match(prepare, /tar -czf .* \.build\/node /);
  assert.equal(
    expanded(commands(scoreboard)).match(/node scripts\/scoreboard-tests\.mjs/g)?.length,
    1,
  );
  assert.doesNotMatch(expanded(commands(observation)), /scoreboard-tests\.mjs/);
  assert.ok(Array.isArray(scoreboard.steps));
  for (const action of ["javascript", "native"])
    assert.equal(
      scoreboard.steps.map(object).filter((step) => step.uses === `./.github/actions/${action}`)
        .length,
      1,
    );
  assert.deepEqual(object(scoreboard.env), object(observation.env));
  assert.ok(Array.isArray(publisher.steps));
  const download = publisher.steps
    .map(object)
    .find((step) => step.uses === "actions/download-artifact@v4");
  assert.ok(download);
  assert.equal(
    object(download.with)["artifact-ids"],
    "${{ needs.own-shell-observation.outputs.current-artifact-id }}",
  );
  assert.equal(object(download.with).path, "${{ runner.temp }}");
  const current = object(observation.outputs);
  assert.equal(current["current-artifact-id"], "${{ steps.current-upload.outputs.artifact-id }}");
  assert.ok(Array.isArray(observation.steps));
  const upload = observation.steps.map(object).find((step) => step.id === "current-upload");
  assert.ok(upload);
  assert.equal(
    object(upload.with).name,
    "own-shell-current-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}",
  );
  assert.match(
    String(object(upload.with).path),
    /\$\{\{ runner.temp \}\}\/own-shell-current\.json/,
  );
  assert.match(String(object(upload.with).path), /\$\{\{ runner.temp \}\}\/scoreboard-input\.json/);
  const observe = commands(observation);
  assert.ok(observe.indexOf("scoreboard-ci.mjs prepare") < observe.indexOf("diagnose-compat.ts"));
  assert.doesNotMatch(commands(publisher), /scoreboard-ci\.mjs prepare/);
});

test("layer and split compatibility producers select immutable baselines after JavaScript restore", () => {
  for (const { id, variable, consumer } of [
    { id: "layers", variable: "LAYERS_BASE_REF", consumer: "npm run test:check-layers" },
    {
      id: "own-shell-scoreboard",
      variable: "BASH_COMPAT_BASE_REF",
      consumer: "npm run test:shell:scoreboard:prebuilt",
    },
    {
      id: "own-shell-observation",
      variable: "BASH_COMPAT_BASE_REF",
      consumer: "scoreboard-ci.mjs prepare",
    },
  ]) {
    const job = object(jobs()[id]);
    assert.ok(!job.env || !(variable in object(job.env)));
    assert.ok(Array.isArray(job.steps));
    const steps = job.steps.map(object);
    const restore = steps.findIndex((step) => step.uses === "./.github/actions/javascript");
    const command = `node scripts/scoreboard-ci.mjs baseline ${variable}`;
    const baseline = steps.findIndex((step) => step.run === command);
    assert.equal(steps.filter((step) => step.run === command).length, 1);
    assert.ok(restore >= 0 && restore < baseline, `${id} restores dependencies before selection`);
    assert.ok(!("if" in steps[baseline]) && !("continue-on-error" in steps[baseline]));
    const stage = steps.findIndex((step) => step.uses === "./.github/actions/native");
    if (stage >= 0) assert.ok(baseline < stage, `${id} selects before native staging`);
    const run = commands(job);
    assert.ok(run.indexOf(command) < run.indexOf(consumer), `${id} selects before consuming`);
  }
});
