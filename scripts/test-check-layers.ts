import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  allowedGraph,
  assertRatchet,
  checkLayers,
  compositionRoots,
  evidencePath,
  optionsFor,
  scanSources,
  testFixtureEdges,
} from "./check-layers.ts";

function scan(sources: Record<string, string>) {
  return scanSources(
    Object.entries(sources).map(([path, source]) => ({ path: `shell/engine/src/${path}`, source })),
  );
}
function keys(evidence: ReturnType<typeof scan>) {
  return evidence.edges.map((edge) => `${edge.scope}:${edge.source}->${edge.target}`);
}

test("the approved graph stays precise; foundation and composition roots are distinct", () => {
  assert.deepEqual(allowedGraph.executor, []);
  assert.deepEqual(allowedGraph.io, ["executor"]);
  assert.deepEqual(allowedGraph.process, ["executor", "io"]);
  assert.deepEqual(allowedGraph.runtime, ["executor", "io", "process"]);
  assert.deepEqual(allowedGraph.state, ["executor", "exec"]);
  assert.deepEqual(allowedGraph.exec, ["executor"]);
  assert.deepEqual(allowedGraph.parse, ["executor", "exec"]);
  assert.deepEqual(allowedGraph.commands, ["parse", "exec"]);
  assert.deepEqual(allowedGraph.ast_copy, ["executor", "exec", "parse"]);
  assert.deepEqual(allowedGraph.arithmetic, ["executor", "exec", "state", "expand", "parse"]);
  assert.deepEqual(allowedGraph.expand, [
    "executor",
    "exec",
    "state",
    "parse",
    "arithmetic",
    "ast_copy",
    "io",
    "interpreter",
  ]);
  assert.deepEqual(allowedGraph.builtins, [
    "executor",
    "exec",
    "state",
    "parse",
    "commands",
    "expand",
    "interpreter",
    "io",
  ]);
  assert.deepEqual(allowedGraph.interpreter, [
    "executor",
    "exec",
    "state",
    "parse",
    "commands",
    "arithmetic",
    "expand",
    "builtins",
    "io",
    "process",
    "ast_copy",
  ]);
  assert.deepEqual(Object.keys(compositionRoots).sort(), [
    "compat",
    "lib",
    "main",
    "runtime_main",
    "terminal",
  ]);
});

test("only four explicit fixture edges are legal in test-only code, never in production", () => {
  assert.deepEqual(testFixtureEdges, {
    builtins: ["process"],
    expand: ["process"],
    process: ["interpreter"],
    runtime: ["interpreter"],
  });
  const sources = Object.fromEntries(
    Object.entries(testFixtureEdges).map(([source, targets]) => {
      const calls = targets.map((target) => `crate::${target}::fixture();`).join(" ");
      return [
        `${source}.rs`,
        `fn production() { ${calls} } #[cfg(test)] fn fixture() { ${calls} }`,
      ];
    }),
  );
  const evidence = scan(sources);
  assert.equal(evidence.counts.production.edges, 4);
  assert.equal(evidence.counts.production.violations, 4);
  assert.equal(evidence.counts.testOnly.edges, 4);
  assert.equal(evidence.counts.testOnly.violations, 0);
  assert.deepEqual(evidence.testFixtureEdges, testFixtureEdges);
  const instrumentation = scan({
    "executor.rs": "#[cfg(test)] fn measure() { crate::interpreter::measure(); }",
    "state.rs": "#[cfg(test)] fn measure() { crate::interpreter::measure(); }",
  });
  assert.equal(instrumentation.counts.testOnly.violations, 2);
  assert.deepEqual(
    instrumentation.violations.map((edge) => `${edge.source}->${edge.target}`),
    ["executor->interpreter", "state->interpreter"],
  );
});

test("comments, doc comments, strings, raw strings, byte/C strings and chars are opaque", () => {
  const evidence = scan({
    "state.rs": String.raw`
//! crate::interpreter::Fake
/// use crate::{expand, process};
// crate::runtime::Fake
/* crate::io::Fake /* crate::process::Fake */ crate::builtins::Fake */
const NORMAL: &str = "quote: \" crate::expand::Fake";
const RAW: &str = r###"crate::expand::Fake "## not the end"###;
const BYTE: &[u8] = b"crate::interpreter::Fake";
const RAW_BYTE: &[u8] = br#"crate::io::Fake"#;
const C = c"crate::process::Fake";
const RAW_C = cr##"crate::runtime::Fake"##;
const QUOTE: char = '\'';
const BYTE_QUOTE: u8 = b'\'';
const CRAB: char = '🦀';
fn lifetime<'a>(x: &'a crate::exec::Frame) -> &'a crate::exec::Frame { x }
`,
  });
  assert.deepEqual(keys(evidence), ["production:state->exec"]);
  assert.deepEqual(evidence.issues, []);
});

test("multiline grouped use trees include nested braces, self, glob imports, aliases and raw identifiers", () => {
  const evidence = scan({
    "state.rs": `
use crate::{
  r#expand::{self as expansion, Error, nested::{Thing as Renamed}},
  r#interpreter::{eval::{StorageBudget as Budget}, self},
  executor::*, exec::{self, Frame},
};
use { crate::io::{self, Endpoint}, crate::process as host };
use ::crate::parse::{Ast, self};
fn example() { crate::r#expand::run(); }
`,
  });
  assert.deepEqual(keys(evidence), [
    "production:state->exec",
    "production:state->executor",
    "production:state->expand",
    "production:state->interpreter",
    "production:state->io",
    "production:state->parse",
    "production:state->process",
  ]);
  assert.equal(evidence.counts.production.edges, 7);
  assert.equal(evidence.counts.production.violations, 5);
});

test("raw keyword identifiers do not become use/mod/as syntax or hide dependencies", () => {
  const evidence = scan({
    "state.rs": `
fn r#use() { crate::expand::run(); }
fn ordinary() { let r#use = crate::interpreter::run(); let r#mod = crate::io::run(); }
use crate::exec::{r#as, Frame as r#use};
`,
  });
  assert.deepEqual(keys(evidence), [
    "production:state->exec",
    "production:state->expand",
    "production:state->interpreter",
    "production:state->io",
  ]);
  assert.deepEqual(evidence.issues, []);
});

test("inline rooted paths, qualified types and macro bodies count without macro expansion", () => {
  const evidence = scan({
    "state.rs": String.raw`
macro_rules! use_it { () => { $crate::interpreter::run(); crate::expand::run(); } }
fn f() { let _: <crate::exec::Frame as Trait>::Output; }
let _ = stringify!(crate::io::Endpoint);
let _ = "crate::runtime::not_a_path";
`,
  });
  assert.deepEqual(keys(evidence), [
    "production:state->exec",
    "production:state->expand",
    "production:state->interpreter",
    "production:state->io",
  ]);
});

test("self and repeated super resolve across file modules and inline modules; same owner edges disappear", () => {
  const evidence = scan({
    "state.rs": `use self::State; use super::exec::Frame; mod nested { use super::State; use super::super::interpreter::Limits; }`,
    "expand/operand.rs": `use super::Work; use super::super::{exec::Frame, state::State}; mod nested { use super::super::super::parse::Ast; self::same(); }`,
    "expand/mod.rs": `use self::operand::run; use super::state::State;`,
  });
  assert.deepEqual(keys(evidence), [
    "production:expand->exec",
    "production:expand->parse",
    "production:expand->state",
    "production:state->exec",
    "production:state->interpreter",
  ]);
  assert.deepEqual(evidence.issues, []);
});

test("production and test-only edges are deduplicated separately with stable source locations", () => {
  const evidence = scan({
    "state/z.rs": "fn z() { crate::expand::other(); }",
    "state.rs": `use crate::expand::Error;
fn first() { crate::expand::work(); }
#[cfg(test)] mod tests { use crate::expand::{Error, Work}; crate::expand::run(); }
#[cfg(test)] fn also_test() { crate::expand::run(); }`,
  });
  assert.deepEqual(keys(evidence), ["production:state->expand", "testOnly:state->expand"]);
  assert.deepEqual(evidence.edges[0].location, {
    path: "shell/engine/src/state.rs",
    line: 1,
    column: 5,
  });
  assert.equal(evidence.counts.production.violations, 1);
  assert.equal(evidence.counts.testOnly.violations, 1);
  const reordered = scanSources([
    { path: "shell/engine/src/state.rs", source: "use crate::exec::A;" },
    { path: "shell/engine/src/exec.rs", source: "use crate::executor::B;" },
  ]);
  assert.deepEqual(
    reordered,
    scanSources([
      { path: "shell/engine/src/exec.rs", source: "use crate::executor::B;" },
      { path: "shell/engine/src/state.rs", source: "use crate::exec::A;" },
    ]),
  );
});

test("cfg(test) scopes cover inline statements, fields, functions and nested modules without leaking", () => {
  const evidence = scan({
    "executor.rs": `
fn outer() {
  #[cfg(test)] crate::interpreter::measurement();
  crate::io::ordinary();
  #[cfg(test)] { crate::expand::run(); }
  crate::process::ordinary();
}
#[test] fn a_test() { crate::state::run(); }
#[cfg(all(test, feature = "measure"))] fn also_test() { crate::exec::run(); }
#[cfg(not(not(test)))] mod tests { fn nested() { crate::parse::run(); } }
#[cfg(any(test, feature = "shipping"))] fn not_test_only() { crate::runtime::run(); }
#[cfg(not(test))] fn production() { crate::commands::run(); }
#[cfg_attr(test, inline)] fn both() { crate::builtins::run(); }
struct Fields { #[cfg(test)] test_field: crate::ast_copy::Copy, normal: crate::arithmetic::Value }
`,
  });
  assert.deepEqual(keys(evidence), [
    "production:executor->arithmetic",
    "production:executor->builtins",
    "production:executor->commands",
    "production:executor->io",
    "production:executor->process",
    "production:executor->runtime",
    "testOnly:executor->ast_copy",
    "testOnly:executor->exec",
    "testOnly:executor->expand",
    "testOnly:executor->interpreter",
    "testOnly:executor->parse",
    "testOnly:executor->state",
  ]);
});

test("inner cfg and external test module declarations propagate test-only scope", () => {
  const evidence = scan({
    "runtime.rs": "#[cfg(test)] mod tests; #[cfg(test)] mod controls;",
    "runtime/tests.rs": "use crate::interpreter::Session; mod nested;",
    "runtime/tests/nested.rs": "crate::expand::run();",
    "runtime/controls/mod.rs": "#![cfg(test)] use crate::state::State;",
    "executor.rs":
      "mod measure { #![cfg(test)] use crate::interpreter::Session; } crate::io::run();",
  });
  assert.deepEqual(keys(evidence), [
    "production:executor->io",
    "testOnly:executor->interpreter",
    "testOnly:runtime->expand",
    "testOnly:runtime->interpreter",
    "testOnly:runtime->state",
  ]);
});

test("unknown unused source owners, root declarations and rooted targets fail closed", () => {
  const evidence = scan({
    "lib.rs": "mod new_feature; mod inline_unknown {}",
    "new_feature.rs": "",
    "state.rs": "crate::unknown::run(); crate::UnknownUppercase::run();",
  });
  assert.equal(evidence.issues.filter((issue) => issue.kind === "unknown-module").length, 3);
  assert.deepEqual(
    evidence.violations.map((edge) => edge.target),
    ["UnknownUppercase", "unknown"],
  );
  assert.equal(
    evidence.modules.some((module) => module.name === "new_feature"),
    false,
  );
  const known = scan({
    "runtime_main.rs": "mod guest { use super::terminal::Editor; }",
    "terminal.rs": "#[cfg(test)] mod tests {}",
  });
  assert.deepEqual(known.issues, []);
  assert.deepEqual(keys(known), ["production:runtime_main->terminal"]);
});

test("unsupported dynamic module sources and escaping relative paths are reported, not silently ignored", () => {
  const evidence = scan({
    "state.rs":
      '#[path = "elsewhere.rs"] mod nested; #[cfg_attr(test, path = "other.rs")] mod another; include!("elsewhere.rs"); super::super::io::run();',
  });
  assert.equal(evidence.issues.length, 4);
  assert.ok(evidence.issues.every((issue) => issue.kind === "unsupported-source"));
});

test("scanner contract explicitly does not resolve bare aliases or expand macros", () => {
  const evidence = scan({
    "state.rs":
      'use crate::exec as execution; execution::Frame; shell_parser::Ast; shell_engine::Session; alias::run(); concat!("crate::expand");',
  });
  assert.deepEqual(keys(evidence), ["production:state->exec"]);
  assert.match(evidence.contract.exclusions, /no alias\/re-export resolution/);
  assert.equal(evidence.identity.binaryBuild, null);
  assert.deepEqual(evidence.sizes, {
    full: { rawBytes: null, gzipBytes: null },
    lite: { rawBytes: null, gzipBytes: null },
  });
  assert.equal(evidence.capabilities.status, "not-measured");
});

test("broken lexical input fails instead of producing misleading evidence", () => {
  for (const source of ['r##"unterminated', '"unterminated', "/* unterminated", "fn f() {"]) {
    assert.throws(() => scan({ "state.rs": source }), /unterminated|unclosed/);
  }
  assert.throws(() => scanSources([]), /no engine/);
});

test("ratchet rejects count growth, identity swaps and test-to-production promotion", () => {
  const base = scan({ "state.rs": "crate::expand::run();" });
  assertRatchet(scan({ "state.rs": "" }), base, "test");
  assert.throws(
    () => assertRatchet(scan({ "state.rs": "crate::interpreter::run();" }), base, "test"),
    /new violation/,
  );
  assert.throws(
    () =>
      assertRatchet(
        scan({ "state.rs": "crate::interpreter::run(); crate::expand::run();" }),
        base,
        "test",
      ),
    /increased/,
  );
  const testOnly = scan({ "state.rs": "#[cfg(test)] fn t() { crate::expand::run(); }" });
  assert.throws(() => assertRatchet(base, testOnly, "test"), /production violations increased/);
});

// No processes, servers or build outputs. Each test owns one tiny temporary Git
// repository; teardown is installed before setup, on success and every exception.
function withRepo(
  body: (
    root: string,
    git: (args: string[]) => string,
    put: (path: string, contents: string) => void,
  ) => void,
) {
  const root = mkdtempSync("/work/tmp/bash-web-layer-tests-");
  try {
    const git = (args: string[]) =>
      execFileSync("git", args, {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      }).trim();
    const put = (path: string, contents: string) => {
      mkdirSync(resolve(root, path, ".."), { recursive: true });
      writeFileSync(resolve(root, path), contents);
    };
    git(["init", "-q"]);
    git(["config", "user.name", "Layer fixture"]);
    git(["config", "user.email", "layer-fixture@example.invalid"]);
    put("shell/engine/src/state.rs", "use crate::exec::Frame;\n");
    mkdirSync(resolve(root, "docs/evidence"), { recursive: true });
    body(root, git, put);
  } finally {
    rmSync(root, { recursive: true, force: true });
    assert.equal(existsSync(root), false, "fixture repository cleanup");
  }
}
function commit(git: (args: string[]) => string) {
  git(["add", "."]);
  git(["-c", "commit.gpgsign=false", "commit", "-qm", "fixture"]);
  return git(["rev-parse", "HEAD"]);
}

test("record is explicit, evidence is exact, source digest is stable across commits", () => {
  withRepo((root, git, put) => {
    const initial = commit(git);
    assert.throws(() => checkLayers(root), /missing layer evidence/);
    const recorded = checkLayers(root, { record: true, baseRef: initial });
    assert.deepEqual(checkLayers(root), recorded);
    commit(git);
    assert.deepEqual(checkLayers(root), recorded);
    put("shell/engine/src/state.rs", "// source-only edit\nuse crate::exec::Frame;\n");
    assert.throws(() => checkLayers(root), /stale or edited/);
    const refreshed = checkLayers(root, { record: true });
    assert.notEqual(refreshed.identity.engineSourceSha256, recorded.identity.engineSourceSha256);
    assert.deepEqual(checkLayers(root), refreshed);
  });
});

function mergeSourceChange(
  git: (args: string[]) => string,
  put: (path: string, contents: string) => void,
  source: string,
) {
  const fork = commit(git);
  git(["checkout", "-qb", "upstream"]);
  put("shell/engine/src/state.rs", source);
  const upstream = commit(git);
  git(["checkout", "-qb", "layers", fork]);
  return upstream;
}

test("normal merges refresh inherited evidence against verified parent and immutable target sources", () => {
  withRepo((root, git, put) => {
    const upstream = mergeSourceChange(git, put, "// merged source\nuse crate::exec::Frame;\n");
    const recorded = checkLayers(root, { record: true });
    const recordedRef = commit(git);
    git(["-c", "commit.gpgsign=false", "merge", "--no-edit", upstream]);
    assert.throws(() => checkLayers(root), /stale or edited/);
    const refreshed = checkLayers(root, { record: true, baseRef: upstream });
    assert.notEqual(refreshed.identity.engineSourceSha256, recorded.identity.engineSourceSha256);
    assert.deepEqual(checkLayers(root, { baseRef: recordedRef }), refreshed);
    // The same verified merge may be used as an immutable target before refresh is committed.
    const mergedRef = git(["rev-parse", "HEAD"]);
    assert.deepEqual(checkLayers(root, { baseRef: mergedRef }), refreshed);
    commit(git);
    assert.deepEqual(checkLayers(root, { baseRef: upstream }), refreshed);
  });
});

test("merged-source reductions ratchet HEAD and immutable merge targets, not stale parent counts", () => {
  withRepo((root, git, put) => {
    const violating = "crate::expand::run();\n";
    put("shell/engine/src/state.rs", violating);
    const upstream = mergeSourceChange(git, put, "use crate::exec::Frame;\n");
    const old = checkLayers(root, { record: true });
    assert.equal(old.counts.production.violations, 1);
    commit(git);
    git(["-c", "commit.gpgsign=false", "merge", "--no-edit", upstream]);
    const mergedRef = git(["rev-parse", "HEAD"]);
    const reduced = checkLayers(root, { record: true });
    assert.equal(reduced.counts.production.violations, 0);
    put("shell/engine/src/state.rs", violating);
    put(evidencePath, JSON.stringify(scan({ "state.rs": violating })));
    assert.throws(
      () => checkLayers(root, { record: true }),
      /committed HEAD: production violations increased/,
    );
    commit(git); // Candidate makes its raised evidence exact; immutable merge target must still reject it.
    assert.throws(
      () => checkLayers(root, { record: true, baseRef: mergedRef }),
      /immutable target: production violations increased/,
    );
  });
});

test("merge inheritance cannot hide new violations or edited evidence", () => {
  for (const tamper of ["source", "counts", "identity", "parent"]) {
    withRepo((root, git, put) => {
      const source =
        tamper === "source" ? "crate::expand::run();\n" : "// upstream\nuse crate::exec::Frame;\n";
      const upstream = mergeSourceChange(git, put, source);
      const evidence = checkLayers(root, { record: true });
      if (tamper === "parent") {
        evidence.counts.production.violations = 100;
        put(evidencePath, JSON.stringify(evidence));
      }
      commit(git);
      git(["-c", "commit.gpgsign=false", "merge", "--no-edit", upstream]);
      if (tamper === "counts" || tamper === "identity") {
        if (tamper === "counts") evidence.counts.production.violations = 100;
        else evidence.identity.engineSourceSha256 = "0".repeat(64);
        put(evidencePath, JSON.stringify(evidence));
        git(["add", evidencePath]);
        git(["-c", "commit.gpgsign=false", "commit", "--amend", "--no-edit", "-q"]);
      }
      for (const record of [false, true]) {
        assert.throws(
          () => checkLayers(root, { record, baseRef: upstream }),
          tamper === "source"
            ? /production violations increased/
            : /committed layer evidence does not match/,
        );
      }
    });
  }
});

test("ordinary source commits with stale evidence still fail closed", () => {
  withRepo((root, git, put) => {
    commit(git);
    checkLayers(root, { record: true });
    commit(git);
    put("shell/engine/src/state.rs", "// ordinary stale commit\nuse crate::exec::Frame;\n");
    const staleRef = commit(git);
    for (const record of [false, true])
      assert.throws(
        () => checkLayers(root, { record, baseRef: staleRef }),
        /committed layer evidence does not match/,
      );
  });
});

test("raising working evidence cannot hide growth against committed HEAD, even with --record", () => {
  withRepo((root, git, put) => {
    commit(git);
    checkLayers(root, { record: true });
    commit(git);
    put("shell/engine/src/state.rs", "crate::expand::run();\n");
    put(evidencePath, JSON.stringify(scan({ "state.rs": "crate::expand::run();\n" })));
    assert.throws(() => checkLayers(root), /committed HEAD: production violations increased/);
    assert.throws(
      () => checkLayers(root, { record: true }),
      /committed HEAD: production violations increased/,
    );
  });
});

test("immutable target rejects a committed raised candidate baseline; missing first-baseline JSON is not a bypass", () => {
  withRepo((root, git, put) => {
    const firstBase = commit(git); // Target intentionally has no evidence yet.
    checkLayers(root, { record: true });
    const recordedBase = commit(git);
    const changed = "crate::expand::run();\n";
    put("shell/engine/src/state.rs", changed);
    put(evidencePath, JSON.stringify(scan({ "state.rs": changed })));
    commit(git); // A malicious candidate raises both its source and current JSON.
    checkLayers(root); // Exact current evidence alone cannot protect the target.
    for (const baseRef of [firstBase, recordedBase]) {
      assert.throws(
        () => checkLayers(root, { baseRef }),
        /immutable target: production violations increased/,
      );
      assert.throws(
        () => checkLayers(root, { baseRef, record: true }),
        /immutable target: production violations increased/,
      );
    }
  });
});

test("deliberate policy evolution verifies older evidence using its own policy and permits real reductions", () => {
  withRepo((root, git, put) => {
    const standard = scan({ "state.rs": "use crate::exec::Frame;\n" });
    const prior = scanSources(
      [{ path: "shell/engine/src/state.rs", source: "use crate::exec::Frame;\n" }],
      {
        allowedGraph: { ...allowedGraph, state: [] },
        testFixtureEdges,
        compositionRoots,
        rootInlineModules: standard.rootInlineModules,
        rootReexports: standard.rootReexports,
      },
    );
    assert.equal(prior.counts.production.violations, 1);
    put(evidencePath, JSON.stringify(prior));
    const priorRef = commit(git);
    const current = checkLayers(root, { record: true, baseRef: priorRef });
    assert.equal(current.counts.violations, 0);
    assert.deepEqual(checkLayers(root, { baseRef: priorRef }), current);
  });
});

test("immutable evidence retains and verifies its explicit test fixture policy", () => {
  withRepo((root, git, put) => {
    const source = "#[cfg(test)] fn fixture() { crate::interpreter::fixture(); }\n";
    rmSync(resolve(root, "shell/engine/src/state.rs"));
    put("shell/engine/src/runtime.rs", source);
    const standard = scan({ "runtime.rs": source });
    const prior = scanSources([{ path: "shell/engine/src/runtime.rs", source }], {
      allowedGraph,
      testFixtureEdges: {},
      compositionRoots,
      rootInlineModules: standard.rootInlineModules,
      rootReexports: standard.rootReexports,
    });
    assert.equal(prior.counts.testOnly.violations, 1);
    put(evidencePath, JSON.stringify(prior));
    const priorRef = commit(git);
    const current = checkLayers(root, { record: true, baseRef: priorRef });
    assert.equal(current.counts.testOnly.edges, 1);
    assert.equal(current.counts.testOnly.violations, 0);
    assert.deepEqual(checkLayers(root, { baseRef: priorRef }), current);
    commit(git);
    const tampered = structuredClone(current);
    tampered.testFixtureEdges = {};
    put(evidencePath, JSON.stringify(tampered));
    const tamperedRef = commit(git);
    assert.throws(
      () => checkLayers(root, { baseRef: tamperedRef }),
      /committed layer evidence does not match/,
    );
  });
});

test("target JSON numbers are verified against immutable source, not trusted", () => {
  withRepo((root, git, put) => {
    commit(git);
    const evidence = checkLayers(root, { record: true });
    const tampered = structuredClone(evidence);
    tampered.counts.production.violations = 100;
    put(evidencePath, JSON.stringify(tampered));
    const badBase = commit(git);
    assert.throws(
      () => checkLayers(root, { baseRef: badBase }),
      /committed layer evidence does not match/,
    );
    // A valid candidate HEAD does not make a malformed older immutable target trustworthy.
    put(evidencePath, JSON.stringify(evidence));
    commit(git);
    for (const record of [false, true])
      assert.throws(
        () => checkLayers(root, { record, baseRef: badBase }),
        /LAYERS_BASE_REF: committed layer evidence does not match/,
      );
  });
});

test("record rejects unknown modules/targets; target references fail closed", () => {
  withRepo((root, git, put) => {
    commit(git);
    put("shell/engine/src/state.rs", "crate::new_feature::run();");
    assert.throws(() => checkLayers(root, { record: true }), /unknown rooted target/);
    put("shell/engine/src/new_feature.rs", "");
    assert.throws(() => checkLayers(root, { record: true }), /inventory\/scanner issues/);
    rmSync(resolve(root, "shell/engine/src/new_feature.rs"));
    put("shell/engine/src/state.rs", "");
    assert.throws(() => checkLayers(root, { baseRef: "a".repeat(40) }), /Command failed/);
    assert.throws(() => checkLayers(root, { baseRef: "HEAD" }), /full commit SHA/);
  });
});

test("CLI options accept an immutable flag/environment ref and reject ambiguous inputs", () => {
  const ref = "a".repeat(40);
  assert.deepEqual(optionsFor(["--record", "--base-ref", ref], {}), { record: true, baseRef: ref });
  assert.deepEqual(optionsFor([], { LAYERS_BASE_REF: ref }), { record: false, baseRef: ref });
  assert.deepEqual(optionsFor(["--base-ref", "b".repeat(40)], { LAYERS_BASE_REF: ref }), {
    record: false,
    baseRef: "b".repeat(40),
  });
  for (const args of [
    ["--base-ref"],
    ["--base-ref", "--record"],
    ["--wat"],
    ["--base-ref", "main"],
  ])
    assert.throws(() => optionsFor(args, {}));
  assert.throws(() => optionsFor([], { LAYERS_BASE_REF: "" }), /full commit SHA/);
});

test("the initial production baseline is three real unique edges, with tests counted separately", () => {
  const evidence = scan({
    "state.rs": "use crate::expand::{Error, Work}; crate::interpreter::eval::StorageBudget;",
    "ast_copy.rs": "use crate::expand::Work;",
    "executor.rs": "#[cfg(test)] crate::interpreter::eval::measure();",
  });
  assert.deepEqual(
    evidence.violations.map((edge) => `${edge.scope}:${edge.source}->${edge.target}`),
    [
      "production:ast_copy->expand",
      "production:state->expand",
      "production:state->interpreter",
      "testOnly:executor->interpreter",
    ],
  );
});

test("repository evidence matches its current source without requiring violations to remain", () => {
  const root = resolve(import.meta.dirname, "..");
  const evidence = checkLayers(root);
  const stored: unknown = JSON.parse(readFileSync(resolve(root, evidencePath), "utf8"));
  assert.deepEqual(stored, evidence);
});
