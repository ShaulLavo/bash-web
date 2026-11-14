import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, cpus, freemem, loadavg, totalmem } from "node:os";

const root = process.cwd();
const out = `${root}/measurement-output`;
const source = "fdf57864daf92d32d7416131561e1177beca2c33";
const originalHead = "53d40423fb998530e87b6b89275e5a78b91e1112";
const owned = ["node_modules", ".sources", ".build", "dist", ".measurement", "public/programs", "public/THIRD_PARTY_NOTICES.txt"];
mkdirSync(out, { recursive: true });

function run(command: string, args: string[], name: string) {
  const value = spawnSync(command, args, { encoding: "utf8", maxBuffer: 32 * 1024 ** 2 });
  writeFileSync(`${out}/${name}.log`, value.stdout + value.stderr);
  process.stdout.write(`${name}: ${value.status}\n`);
  assert.equal(value.status, 0, `${name} failed: ${value.stderr.slice(-4000)}`);
  return value.stdout.trim();
}
function hash(path: string) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function read(path: string) {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}
function processes() {
  return spawnSync("ps", ["-eo", "pid,ppid,pcpu,pmem,comm,args"], { encoding: "utf8" }).stdout;
}
function allowedCpus() {
  const list = /^Cpus_allowed_list:\s+(.*)$/m.exec(readFileSync("/proc/self/status", "utf8"));
  assert.ok(list);
  return list[1].split(",").flatMap(range => {
    const [first, last = first] = range.split("-").map(Number);
    return Array.from({ length: last - first + 1 }, (_, at) => first + at);
  });
}
function ownProcesses() {
  return readdirSync("/proc").filter(name => /^\d+$/.test(name)).flatMap(name => {
    if (Number(name) === process.pid || Number(name) === process.ppid) return [];
    try {
      const cwd = readlinkSync(`/proc/${name}/cwd`);
      const cmd = readFileSync(`/proc/${name}/cmdline`, "utf8").replaceAll("\0", " ");
      return cwd === root && /playwright|dist\/serve|MiniBrowser|WebKit/.test(cmd) ? [{ pid: Number(name), cmd }] : [];
    } catch { return []; }
  });
}
function cleanup() {
  const active = ownProcesses();
  for (const item of active) process.kill(item.pid, "SIGTERM");
  for (const path of owned) rmSync(path, { recursive: true, force: true });
  for (const path of ["javascript", "native"]) rmSync(`${process.env.RUNNER_TEMP}/${path}`, { recursive: true, force: true });
  const remaining = owned.filter(existsSync);
  const listeners = spawnSync("ss", ["-ltnp", "( sport = :4198 )"], { encoding: "utf8" }).stdout;
  writeFileSync(`${out}/cleanup.json`, JSON.stringify({ active, remaining, listeners, processes: processes() }, null, 2));
  assert.deepEqual(remaining, []);
  assert.deepEqual(ownProcesses(), []);
  assert.equal(listeners.trim().split("\n").length, 1);
}
if (process.argv[2] === "cleanup") {
  cleanup();
} else {
  writeFileSync(`${out}/inventory-before.json`, JSON.stringify({ preexisting: owned.filter(existsSync), processes: processes() }, null, 2));
  try {
    const allowed = allowedCpus();
    assert.ok(allowed.length >= 2, "Two available CPUs required");
    const affinity = allowed.slice(0, 2).join(",");
    const hardware = {
      cpus: cpus(), actualLogicalCpus: cpus().length, availableCpus: availableParallelism(), allowed,
      effectiveCpus: affinity, effectiveCount: 2, totalmem: totalmem(), freemem: freemem(), loadavg: loadavg(),
      meminfo: read("/proc/meminfo"), cpuMax: read("/sys/fs/cgroup/cpu.max"), osRelease: read("/etc/os-release"),
      lscpu: run("lscpu", [], "lscpu"), nproc: run("nproc", [], "nproc"),
      descendants: run("taskset", ["-c", affinity, "node", "-e", "console.log(JSON.stringify({available:require('node:os').availableParallelism(),status:require('node:fs').readFileSync('/proc/self/status','utf8')}))"], "effective-affinity"),
      source: run("git", ["rev-parse", "HEAD"], "source"), diagnostic: process.env.DIAGNOSTIC_HEAD,
    };
    writeFileSync(`${out}/hardware.json`, JSON.stringify(hardware, null, 2));
    assert.equal(JSON.parse(hardware.descendants).available, 2);
    assert.equal(hardware.source, source);
    assert.equal(run("git", ["rev-parse", `${source}^{tree}`], "source-tree"), run("git", ["rev-parse", `${originalHead}^{tree}`], "head-tree"));
    run("tar", ["-xzf", `${process.env.RUNNER_TEMP}/javascript/javascript.tar.gz`], "javascript-restore");
    run("node", ["scripts/ci-artifacts.ts", "stage", ".build/ci-native"], "native-stage");
    const identities = {
      run: 43600965576, nativeArtifact: 14116672244, javascriptArtifact: 14116108165, source, originalHead,
      javascriptTar: hash(`${process.env.RUNNER_TEMP}/javascript/javascript.tar.gz`),
      inputs: read(".build/ci-native/inputs"), nativeSums: read(".build/ci-native/SHA256SUMS"),
      testGuest: hash("public/programs/test-guest.wasm"), shellGuest: hash("public/programs/shell-engine.wasm"),
      shellWorker: hash(".build/browser/shell-worker.js"), fsWorker: hash(".build/browser/fs-worker.js"),
      playwright: JSON.parse(readFileSync("node_modules/playwright/package.json", "utf8")).version,
      browsers: JSON.parse(readFileSync("node_modules/playwright-core/browsers.json", "utf8")),
    };
    writeFileSync(`${out}/identities.json`, JSON.stringify(identities, null, 2));
    assert.equal(identities.playwright, "1.64.0");
    run("node", ["node_modules/playwright/cli.js", "install", "--with-deps", "webkit"], "webkit-install");
    run("npm", ["run", "build:browser:assets:ci"], "browser-assets");
    cpSync(".diagnostic/.measurement", ".measurement", { recursive: true });
    process.env.BASH_WEB_MEASURE = "1";
    process.env.BASH_WEB_TEST_PORT = "4198";
    const args = ["node", "node_modules/playwright/cli.js", "test", "--config", ".measurement/playwright.measure.config.ts", "--project=webkit", "--workers=1"];
    const listed = run("taskset", ["-c", affinity].concat(args, ["--list", "--reporter=json"]), "selected-list");
    const listing = JSON.parse(listed);
    const selected = listing.suites.flatMap((suite: { specs: { title: string; tests: { projectName: string }[] }[] }) => suite.specs.flatMap(spec => spec.tests.map(test => ({ title: spec.title, project: test.projectName }))));
    assert.equal(selected.length, 10);
    const expected = ["slow downstream", "builtin to builtin"].flatMap(name => Array.from({ length: 5 }, (_, at) => `${name} completion sample ${at + 1}`));
    assert.deepEqual(selected.map((test: { title: string }) => test.title).sort(), expected.sort());
    assert.ok(selected.every((test: { project: string }) => test.project === "webkit"));
    writeFileSync(`${out}/selected.json`, JSON.stringify(selected, null, 2));
    writeFileSync(`${out}/before-run.json`, JSON.stringify({ loadavg: loadavg(), freemem: freemem(), processes: processes() }, null, 2));
    run("taskset", ["-c", affinity].concat(args), "ten-samples");
    const summary = ["drained", "count"].map(kind => {
      const marker = kind === "drained" ? "DRAINED:5242880:1" : "COUNT:2688895:400001";
      const samples = Array.from({ length: 5 }, (_, at) => {
        const sample = JSON.parse(readFileSync(`${out}/${kind}-${at + 1}.json`, "utf8"));
        assert.equal(sample.kind, kind);
        assert.equal(sample.sample, at + 1);
        assert.equal(sample.status, "passed");
        assert.equal(sample.finalWorkers, sample.baselineWorkers);
        const timing = sample.observation.timing;
        assert.ok(timing.phaseStart !== null && timing.hits[marker]);
        const upper = timing.hits[marker].upper - timing.phaseStart;
        assert.ok(upper > 0 && upper < 60000);
        return { sample: at + 1, lower: timing.hits[marker].lower - timing.phaseStart, upper };
      });
      return { kind, marker, samples, allowanceMs: Math.ceil(Math.max(...samples.map(sample => sample.upper)) * 1.125) };
    });
    writeFileSync(`${out}/summary.json`, JSON.stringify(summary, null, 2));
  } finally {
    cleanup();
  }
}
