import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
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

test("known inline root layers own their paths instead of borrowing composition-root allowances", () => {
  const evidence = scan({
    "lib.rs": `
crate::process::composition();
mod state {
  crate::process::forbidden();
  use super::{io::Endpoint, exec::Frame};
  self::State::same_owner();
  mod nested { super::super::interpreter::forbidden(); }
}
mod runtime { #[cfg(test)] fn fixture() { crate::interpreter::fixture(); } }
`,
    "runtime_main.rs":
      "mod guest { crate::terminal::helper(); mod nested { super::super::runtime::helper(); } }",
  });
  assert.deepEqual(keys(evidence), [
    "production:lib->process",
    "production:runtime_main->runtime",
    "production:runtime_main->terminal",
    "production:state->exec",
    "production:state->interpreter",
    "production:state->io",
    "production:state->process",
    "testOnly:runtime->interpreter",
  ]);
  assert.deepEqual(evidence.issues, []);
  assert.equal(evidence.counts.production.violations, 3);
  assert.equal(evidence.counts.testOnly.violations, 0);
  assert.throws(
    () =>
      assertRatchet(
        scan({ "lib.rs": "mod state { crate::process::forbidden(); }" }),
        scan({ "state.rs": "" }),
        "inline layer",
      ),
    /production violations increased/,
  );
  const unknown = scan({ "lib.rs": "mod unlisted { crate::process::forbidden(); }" });
  assert.equal(unknown.issues[0]?.kind, "unknown-module");
});

test("test guards survive generic and where item headers without covering following items or variants", () => {
  const evidence = scan({
    "runtime.rs": `
#[cfg(test)] fn fixture<A, B>() { crate::interpreter::fixture(); }
#[cfg(test)] pub(crate) async unsafe fn constants<const N: usize = { 1 }, A: Fn() -> crate::parse::Ast, B>() { crate::interpreter::fixture(); }
#[cfg(test)] fn bounded<A, B>() where A: crate::expand::Bound, B: crate::arithmetic::Bound { crate::commands::fixture(); }
fn production() { crate::state::ordinary(); }
#[cfg(test)] struct Guarded<A, B> where A: crate::parse::Bound, B: crate::exec::Bound { a: A, b: B }
struct Ordinary { field: crate::io::Endpoint }
struct FunctionFields { #[cfg(test)] callback: fn(crate::arithmetic::Value), normal: crate::arithmetic::Value }
#[cfg(test)] type GuardedAlias<A, B> = (crate::ast_copy::Copy, A, B);
type OrdinaryAlias = crate::process::Process;
enum Variants {
  #[cfg(test)] Fixture(crate::builtins::Context),
  Ordinary(crate::executor::Executor),
  #[cfg(test)] Named { field: crate::terminal::Editor },
  Last(crate::compat::Host),
}
`,
  });
  assert.deepEqual(keys(evidence), [
    "production:runtime->arithmetic",
    "production:runtime->compat",
    "production:runtime->executor",
    "production:runtime->io",
    "production:runtime->process",
    "production:runtime->state",
    "testOnly:runtime->arithmetic",
    "testOnly:runtime->ast_copy",
    "testOnly:runtime->builtins",
    "testOnly:runtime->commands",
    "testOnly:runtime->exec",
    "testOnly:runtime->expand",
    "testOnly:runtime->interpreter",
    "testOnly:runtime->parse",
    "testOnly:runtime->terminal",
  ]);
});

test("guarded tuple function-pointer fields do not guard following production fields or items", () => {
  for (const pointer of ["fn", "unsafe fn", 'extern "C" fn', 'unsafe extern "C" fn']) {
    for (const source of [
      `struct Functions(#[cfg(test)] ${pointer}(crate::io::Endpoint), crate::interpreter::Session);
       fn following() { crate::process::ordinary(); }`,
      `enum Functions {
         Tuple(#[cfg(test)] ${pointer}(crate::io::Endpoint), crate::interpreter::Session),
         Following(crate::process::Process),
       }`,
    ]) {
      const evidence = scan({ "runtime.rs": source });
      assert.deepEqual(
        keys(evidence),
        ["production:runtime->interpreter", "production:runtime->process", "testOnly:runtime->io"],
        source,
      );
      assert.equal(evidence.counts.production.violations, 1);
      assert.equal(evidence.counts.testOnly.violations, 0);
    }
  }
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

// No servers or build outputs. Each test owns one tiny temporary Git repository;
// teardown is installed before setup, on success and every exception. Automatic
// maintenance must not detach writers that outlive execFileSync and race teardown.
function withRepo(
  body: (
    root: string,
    git: (args: string[], env?: NodeJS.ProcessEnv) => string,
    put: (path: string, contents: string) => void,
  ) => void,
) {
  const temporaryRoot = process.env.TMPDIR || (existsSync("/work/tmp") ? "/work/tmp" : tmpdir());
  const root = mkdtempSync(resolve(temporaryRoot, "bash-web-layer-tests-"));
  try {
    const git = (args: string[], env?: NodeJS.ProcessEnv) =>
      execFileSync("git", ["-c", "maintenance.auto=false"].concat(args), {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      }).trim();
    const put = (path: string, contents: string) => {
      mkdirSync(resolve(root, path, ".."), { recursive: true });
      writeFileSync(resolve(root, path), contents);
    };
    git(["init", "-q"]);
    git(["config", "user.name", "Layer fixture"]);
    git(["config", "user.email", "layer-fixture@example.invalid"]);
    put(
      "scripts/check-layers.ts",
      readFileSync(new URL("./check-layers.ts", import.meta.url), "utf8"),
    );
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

test("repository fixtures honor an explicit temporary root", () => {
  withRepo((root) => {
    const expected = process.env.TMPDIR || (existsSync("/work/tmp") ? "/work/tmp" : tmpdir());
    assert.equal(dirname(root), resolve(expected));
  });
});

test("fixture commits do not start automatic maintenance writers", () => {
  withRepo((root, git) => {
    // Keep this regression's pre-fix maintenance synchronous, so a failing test
    // cannot leave the very background writer it is checking for.
    git(["config", "maintenance.autoDetach", "false"]);
    git(["config", "gc.autoDetach", "false"]);
    git(["add", "."]);
    const tracePath = resolve(root, "git-trace.json");
    git(["-c", "commit.gpgsign=false", "commit", "-qm", "fixture"], {
      GIT_TRACE2_EVENT: tracePath,
    });
    const events: { event: string; argv?: string[] }[] = readFileSync(tracePath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.ok(
      events.some((event) => event.event === "start"),
      "commit trace was captured",
    );
    const maintenance = events.filter(
      (event) =>
        event.event === "child_start" &&
        (event.argv?.[1] === "maintenance" || event.argv?.[1] === "gc"),
    );
    assert.deepEqual(maintenance, [], "fixture commits must not launch automatic maintenance");
  });
});

test("actual sources ignore absent, stale and fabricated JSON without writing it", () => {
  withRepo((root, git, put) => {
    const baseRef = commit(git);
    const before = checkLayers(root, { baseRef });
    put(evidencePath, '{"counts":{"violations":999}}');
    put("shell/engine/src/state.rs", "// harmless source edit\nuse crate::exec::Frame;\n");
    const next = checkLayers(root, { baseRef });
    assert.equal(next.counts.violations, before.counts.violations);
    assert.equal(
      readFileSync(resolve(root, evidencePath), "utf8"),
      '{"counts":{"violations":999}}',
    );
    assert.notEqual(next.identity.engineSourceSha256, before.identity.engineSourceSha256);
  });
});

test("candidate scanner/policy edits cannot hide source growth, with failure evidence", () => {
  withRepo((root, git, put) => {
    const baseRef = commit(git);
    put(
      "scripts/check-layers.ts",
      "export function scanSources() { throw new Error('candidate scanner ran') }",
    );
    put("shell/engine/src/state.rs", "crate::expand::run();");
    put(evidencePath, "{}");
    assert.throws(
      () => checkLayers(root, { baseRef, output: "layers.json" }),
      /immutable target: production violations increased/,
    );
    const evidence = JSON.parse(readFileSync(resolve(root, "layers.json"), "utf8"));
    assert.equal(evidence.ok, false);
    assert.equal(evidence.base.counts.violations, 0);
    assert.equal(evidence.candidate.counts.violations, 1);
    assert.equal(evidence.baseRef, baseRef);
  });
});

test("committed sources and merges are scanned without inherited snapshot repair", () => {
  withRepo((root, git, put) => {
    const baseRef = commit(git);
    put("shell/engine/src/state.rs", "// source commit without JSON\nuse crate::exec::Frame;");
    const target = commit(git);
    assert.equal(checkLayers(root, { baseRef: target }).counts.violations, 0);
    put("shell/engine/src/state.rs", "crate::expand::run();");
    commit(git);
    assert.throws(() => checkLayers(root, { baseRef }), /increased/);
  });
});

test("inventory and immutable references fail closed", () => {
  withRepo((root, git, put) => {
    const baseRef = commit(git);
    put("shell/engine/src/state.rs", "crate::new_feature::run();");
    assert.throws(() => checkLayers(root, { baseRef }), /unknown rooted target/);
    put("shell/engine/src/new_feature.rs", "");
    assert.throws(() => checkLayers(root, { baseRef }), /inventory\/scanner issues/);
    assert.throws(() => checkLayers(root, { baseRef: "a".repeat(40) }), /Command failed/);
    assert.throws(() => checkLayers(root, { baseRef: "HEAD" }), /full commit SHA/);
  });
});

test("CLI accepts immutable base and artifact path, never source-tree recording", () => {
  const baseRef = "a".repeat(40);
  assert.deepEqual(optionsFor(["--base-ref", baseRef, "--output", "layers.json"], {}), {
    baseRef,
    output: "layers.json",
  });
  assert.deepEqual(optionsFor([], { LAYERS_BASE_REF: baseRef }), { baseRef, output: undefined });
  for (const args of [["--record"], ["--base-ref"], ["--output"], ["--base-ref", "HEAD"]])
    assert.throws(() => optionsFor(args, {}));
});
