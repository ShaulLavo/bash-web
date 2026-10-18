import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

/**
 * Lexical contract (not a Rust parser or a capability/build check):
 * - Scan every .rs under shell/engine/src, regardless of platform/feature cfg.
 * - Count unique top-level source -> target edges separately for production and
 *   test-only code. Keep the first deterministic location for each edge/class.
 *   Test fixture allowances are a separate explicit policy, never production
 *   allowances or a reason to omit test edges from evidence.
 * - Recognize crate:: paths, rooted grouped use trees, raw identifiers, and
 *   self/super paths relative to file/inline module nesting. Bare names, imported
 *   aliases, external shell_engine paths, general re-export resolution and macro
 *   expansion are not resolved. lib.rs's Limits/Session re-exports have explicit
 *   ownership entries. Macro bodies ARE scanned, including literal $crate paths.
 * - Comments (nested block comments too), normal/byte/C/raw strings and character
 *   literals are opaque. Lifetimes remain tokens, not character literals.
 * - Only #[test] or cfg predicates provably false with test=false establish a
 *   test-only scope; uncertain cfgs stay production. cfg_attr is not a test guard.
 *   Outer attributes cover the next item/statement/field; inner cfg covers its
 *   enclosing group/file. External mod declarations pass test-only status to files.
 * - Conventional Rust file modules only. #[path] and include! fail closed rather
 *   than pretending their source was scanned. New top-level modules (even unused
 *   files or inline declarations) and unknown rooted targets fail closed.
 *
 * Usage: node scripts/check-layers.ts [--record] [--base-ref FULL_COMMIT_SHA]
 * LAYERS_BASE_REF is the equivalent environment setting. --record explicitly
 * refreshes evidence, but cannot increase violations against committed HEAD or
 * the optional immutable target. Normal checks require exact current evidence.
 * Step 6 owns real separate Full/Lite compile and size measurements.
 */
export const allowedGraph = {
  executor: [],
  io: ["executor"],
  process: ["executor", "io"],
  runtime: ["executor", "io", "process"],
  exec: ["executor"],
  state: ["executor", "exec"],
  parse: ["executor", "exec"],
  commands: ["parse", "exec"],
  ast_copy: ["executor", "exec", "parse"],
  arithmetic: ["executor", "exec", "state", "expand", "parse"],
  expand: ["executor", "exec", "state", "parse", "arithmetic", "ast_copy", "io", "interpreter"],
  builtins: ["executor", "exec", "state", "parse", "commands", "expand", "interpreter", "io"],
  interpreter: [
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
  ],
} satisfies Record<string, readonly string[]>;

// Integration fixtures can assemble higher-level components without making those
// dependencies legal in production. Measurement hooks in executor/state are not
// fixture allowances: they remain violations until shared execution types move.
export const testFixtureEdges = {
  builtins: ["process"],
  expand: ["process"],
  process: ["interpreter"],
  runtime: ["interpreter"],
} satisfies Record<string, readonly string[]>;

// Composition roots have deliberately enumerated allowances, never a wildcard.
export const compositionRoots = {
  lib: [
    "arithmetic",
    "ast_copy",
    "builtins",
    "executor",
    "expand",
    "interpreter",
    "io",
    "process",
    "runtime",
    "state",
    "exec",
    "parse",
    "commands",
  ],
  main: ["compat", "executor", "interpreter", "io", "process", "state"],
  runtime_main: ["terminal", "executor", "interpreter", "io", "runtime", "state"],
  compat: ["executor", "io", "process"],
  terminal: [],
} satisfies Record<string, readonly string[]>;

// Existing private helper nested inside the runtime binary's crate root.
const rootInlineModules: Readonly<Record<string, readonly string[]>> = { runtime_main: ["guest"] };
// The public re-exports in lib.rs are explicit, not an uppercase-name exemption.
const rootReexports: Readonly<Record<string, string>> = {
  Limits: "interpreter",
  Session: "interpreter",
};
type Policy = {
  allowedGraph: Readonly<Record<string, readonly string[]>>;
  testFixtureEdges: Readonly<Record<string, readonly string[]>>;
  compositionRoots: Readonly<Record<string, readonly string[]>>;
  rootInlineModules: Readonly<Record<string, readonly string[]>>;
  rootReexports: Readonly<Record<string, string>>;
};
const defaultPolicy: Policy = {
  allowedGraph,
  testFixtureEdges,
  compositionRoots,
  rootInlineModules,
  rootReexports,
};
const graph: Readonly<Record<string, readonly string[]>> = { ...allowedGraph, ...compositionRoots };
export const evidencePath = "docs/evidence/engine-layers.json";
const sourceRoot = "shell/engine/src/";
type Scope = "production" | "testOnly";
export type SourceFile = { path: string; source: string };
type Location = { path: string; line: number; column: number };
type Token = { text: string; offset: number };
type Edge = { source: string; target: string; scope: Scope; location: Location };
type Issue = {
  kind: "unknown-module" | "unsupported-source";
  module: string;
  location: Location;
  detail: string;
};
type Declaration = { name: string; testOnly: boolean; location: Location };
type FileScan = { edges: Edge[]; issues: Issue[]; declarations: Declaration[] };
const identifier = /^[_\p{ID_Start}][_\p{ID_Continue}]*$/u;
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const edgeKey = (edge: Edge) => `${edge.scope}:${edge.source}->${edge.target}`;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** Tokenize just enough Rust to keep literal/comment text out of dependency paths. */
function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const start = i;
    if (/\s/u.test(source[i])) {
      i++;
      continue;
    }
    if (source.startsWith("//", i)) {
      const end = source.indexOf("\n", i);
      i = end < 0 ? source.length : end;
      continue;
    }
    if (source.startsWith("/*", i)) {
      let depth = 1;
      i += 2;
      while (i < source.length && depth) {
        if (source.startsWith("/*", i)) {
          depth++;
          i += 2;
        } else if (source.startsWith("*/", i)) {
          depth--;
          i += 2;
        } else i++;
      }
      assert.equal(depth, 0, "unterminated Rust block comment");
      continue;
    }
    const raw = /^(?:br|cr|r)(#*)"/.exec(source.slice(i));
    if (raw) {
      const end = source.indexOf(`"${raw[1]}`, i + raw[0].length);
      assert.notEqual(end, -1, "unterminated Rust raw string");
      i = end + 1 + raw[1].length;
      tokens.push({ text: "<literal>", offset: start });
      continue;
    }
    const string = /^(?:b|c)?"/.exec(source.slice(i));
    if (string) {
      i += string[0].length;
      let closed = false;
      while (i < source.length) {
        if (source[i] === "\\") i += 2;
        else if (source[i++] === '"') {
          closed = true;
          break;
        }
      }
      assert.ok(closed, "unterminated Rust string");
      tokens.push({ text: "<literal>", offset: start });
      continue;
    }
    // A single scalar/escape followed by a quote is a char; 'a and 'static are lifetimes.
    const char = /^(?:b)?'(?:\\(?:u\{[0-9a-fA-F_]+\}|x[0-9a-fA-F]{2}|[^\r\n])|[^'\\\r\n])'/u.exec(
      source.slice(i),
    );
    if (char) {
      i += char[0].length;
      tokens.push({ text: "<literal>", offset: start });
      continue;
    }
    const name = /^(?:r#)?[_\p{ID_Start}][_\p{ID_Continue}]*/u.exec(source.slice(i));
    if (name) {
      i += name[0].length;
      tokens.push({ text: name[0].replace(/^r#/, ""), offset: start });
      continue;
    }
    const text = source.startsWith("::", i) ? "::" : source[i];
    tokens.push({ text, offset: start });
    i += text.length;
  }
  return tokens;
}

function pairsFor(tokens: readonly Token[]): Map<number, number> {
  const pairs = new Map<number, number>();
  const stack: number[] = [];
  const opening: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  for (let i = 0; i < tokens.length; i++) {
    const text = tokens[i].text;
    if (Object.hasOwn(opening, text)) stack.push(i);
    else if ([")", "]", "}"].includes(text)) {
      const start = stack.pop();
      assert.ok(
        start !== undefined && opening[tokens[start].text] === text,
        "unbalanced Rust token groups",
      );
      pairs.set(start, i);
    }
  }
  assert.equal(stack.length, 0, "unclosed Rust token group");
  return pairs;
}

type Truth = boolean | "unknown";
// Evaluate only enough cfg logic to prove a path cannot be compiled without test.
function cfgWithoutTest(tokens: readonly Token[]): Truth {
  if (tokens.length === 1 && tokens[0].text === "test") return false;
  const op = tokens[0]?.text;
  if (!["all", "any", "not"].includes(op) || tokens[1]?.text !== "(" || tokens.at(-1)?.text !== ")")
    return "unknown";
  const groups: Token[][] = [];
  let group: Token[] = [];
  let depth = 0;
  for (const token of tokens.slice(2, -1)) {
    if (token.text === "," && depth === 0) {
      if (group.length) groups.push(group);
      group = [];
    } else {
      group.push(token);
      if (token.text === "(") depth++;
      if (token.text === ")") depth--;
    }
  }
  if (group.length) groups.push(group);
  const values = groups.map(cfgWithoutTest);
  if (op === "not") return values.length === 1 && values[0] !== "unknown" ? !values[0] : "unknown";
  if (op === "all")
    return values.includes(false) ? false : values.includes("unknown") ? "unknown" : true;
  return values.includes(true) ? true : values.includes("unknown") ? "unknown" : false;
}

function modulePath(path: string): string[] {
  assert.ok(
    path.startsWith(sourceRoot) && path.endsWith(".rs"),
    `unexpected Rust source path ${path}`,
  );
  const parts = path.slice(sourceRoot.length, -3).split("/");
  if (parts.at(-1) === "mod") parts.pop();
  // Root files compose crates; their file stems are ownership labels, not Rust modules.
  return parts.length === 1 && ["lib", "main", "runtime_main"].includes(parts[0]) ? [] : parts;
}
function ownerFor(path: string): string {
  return path.slice(sourceRoot.length).split("/")[0].replace(/\.rs$/, "");
}

function scanFile(file: SourceFile, inheritedTestOnly: boolean, policy: Policy): FileScan {
  const graph: Readonly<Record<string, readonly string[]>> = {
    ...policy.allowedGraph,
    ...policy.compositionRoots,
  };
  const { rootInlineModules, rootReexports } = policy;
  const tokens = tokenize(file.source);
  const pairs = pairsFor(tokens);
  const source = ownerFor(file.path);
  const result: FileScan = { edges: [], issues: [], declarations: [] };
  // Normalized raw names may be path segments, but r#use/r#mod/r#as are
  // identifiers, not grammar keywords that can swallow the following code.
  function keyword(index: number, text: string): boolean {
    return tokens[index]?.text === text && !file.source.startsWith("r#", tokens[index].offset);
  }
  const lineStarts = [0];
  for (let i = 0; i < file.source.length; i++) if (file.source[i] === "\n") lineStarts.push(i + 1);
  function location(index: number): Location {
    const offset = tokens[index]?.offset ?? 0;
    let low = 0,
      high = lineStarts.length;
    while (low + 1 < high) {
      const mid = (low + high) >>> 1;
      if (lineStarts[mid] <= offset) low = mid;
      else high = mid;
    }
    return { path: file.path, line: low + 1, column: offset - lineStarts[low] + 1 };
  }
  function issue(index: number, detail: string) {
    result.issues.push({
      kind: "unsupported-source",
      module: source,
      location: location(index),
      detail,
    });
  }
  function addPath(
    path: readonly string[],
    context: readonly string[],
    testOnly: boolean,
    index: number,
  ) {
    let absolute: string[];
    if (path[0] === "crate") absolute = path.slice(1);
    else if (path[0] === "self" || path[0] === "super") {
      absolute = context.slice();
      let cursor = 0;
      if (path[0] === "self") cursor++;
      while (path[cursor] === "super") {
        if (!absolute.length) {
          issue(index, "relative path escapes its crate root");
          return;
        }
        absolute.pop();
        cursor++;
      }
      absolute = absolute.concat(path.slice(cursor));
    } else return; // External or bare paths require Rust name resolution.
    const target = Object.hasOwn(rootReexports, absolute[0])
      ? rootReexports[absolute[0]]
      : absolute[0];
    // Known top-level modules own their code even when declared inline in a
    // composition root. Explicit root helpers (runtime_main::guest) retain the
    // file owner's allowances; unknown root modules are reported by walk.
    const owner = context.length && Object.hasOwn(graph, context[0]) ? context[0] : source;
    if (!target || target === owner || target === "self" || target === "*") return;
    result.edges.push({
      source: owner,
      target,
      scope: testOnly ? "testOnly" : "production",
      location: location(index),
    });
  }
  function useTree(
    start: number,
    end: number,
    prefix: readonly string[],
    context: readonly string[],
    testOnly: boolean,
  ): void {
    let i = start;
    if (tokens[i]?.text === "::") i++;
    let path = prefix.slice();
    const first = i;
    while (i < end && (identifier.test(tokens[i].text) || tokens[i].text === "*")) {
      if (keyword(i, "as")) break;
      if (tokens[i].text !== "self" || !path.length) path.push(tokens[i].text);
      i++;
      if (tokens[i]?.text !== "::") break;
      i++;
    }
    if (tokens[i]?.text === "{") {
      const close = pairs.get(i);
      assert.ok(close !== undefined && close <= end, "invalid Rust use tree");
      i++;
      while (i < close) {
        const child = i;
        while (i < close && tokens[i].text !== ",") {
          const groupEnd = pairs.get(i);
          i = groupEnd === undefined ? i + 1 : groupEnd + 1;
        }
        useTree(child, i, path, context, testOnly);
        i++;
      }
    } else addPath(path, context, testOnly, first);
  }
  function walk(start: number, end: number, context: readonly string[], inherited: boolean) {
    let testOnly = inherited;
    let pendingTest = false;
    let itemStart = true;
    let itemHeader = false;
    let genericDepth = 0;
    for (let i = start; i < end; i++) {
      const text = tokens[i].text;
      // Attributes belong to the next item, not to the following item as well.
      if (text === "#" && ["[", "!"].includes(tokens[i + 1]?.text)) {
        const inner = tokens[i + 1]?.text === "!";
        const open = i + (inner ? 2 : 1);
        if (tokens[open]?.text !== "[") continue;
        const close = pairs.get(open);
        assert.ok(close !== undefined);
        const body = tokens.slice(open + 1, close);
        const guarded =
          body[0]?.text === "test" ||
          (body[0]?.text === "cfg" && cfgWithoutTest(body.slice(2, -1)) === false);
        if (
          body[0]?.text === "path" ||
          (body[0]?.text === "cfg_attr" && body.some((token) => token.text === "path"))
        )
          issue(i, "#[path] modules are outside the conventional file-module contract");
        if (inner) testOnly ||= guarded;
        else pendingTest ||= guarded;
        i = close;
        continue;
      }
      const activeTest = testOnly || pendingTest;
      // Commas separate fields/variants, but not the generic parameters or
      // where predicates in an item's header. Recognize items only at a fresh
      // boundary, not `fn` in a field's function-pointer type.
      if (
        itemStart &&
        ["fn", "struct", "enum", "union", "trait", "impl", "type", "const", "static"].some((name) =>
          keyword(i, name),
        )
      )
        itemHeader = true;
      if (
        !itemHeader &&
        !["pub", "unsafe", "async", "extern", "default"].some((name) => keyword(i, name)) &&
        !(text === "(" && keyword(i - 1, "pub")) &&
        !(text === "<literal>" && keyword(i - 1, "extern"))
      )
        itemStart = false;
      if (itemHeader) {
        if (text === "<") genericDepth++;
        else if (text === ">" && genericDepth > 0 && tokens[i - 1]?.text !== "-") genericDepth--;
      }
      if (text === "include" && tokens[i + 1]?.text === "!")
        issue(i, "include! source requires explicit scanner support");
      if (keyword(i, "mod") && identifier.test(tokens[i + 1]?.text ?? "")) {
        const name = tokens[i + 1].text;
        const nested = context.concat([name]);
        const locationAt = location(i + 1);
        result.declarations.push({
          name: nested.join("::"),
          testOnly: activeTest,
          location: locationAt,
        });
        if (
          !context.length &&
          !Object.hasOwn(graph, name) &&
          !rootInlineModules[source]?.includes(name)
        ) {
          result.issues.push({
            kind: "unknown-module",
            module: name,
            location: locationAt,
            detail: "top-level module is absent from the allowed graph",
          });
        }
        if (tokens[i + 2]?.text === "{") {
          const close = pairs.get(i + 2);
          assert.ok(close !== undefined);
          walk(i + 3, close, nested, activeTest);
          i = close;
          pendingTest = false;
          itemStart = true;
          continue;
        }
      }
      if (keyword(i, "use")) {
        let close = i + 1;
        while (close < end && tokens[close].text !== ";") close++;
        useTree(i + 1, close, [], context, activeTest);
        i = close;
        pendingTest = false;
        itemStart = true;
        continue;
      }
      if (
        ["crate", "self", "super"].includes(text) &&
        tokens[i + 1]?.text === "::" &&
        tokens[i - 1]?.text !== "::"
      ) {
        const path = [text];
        let cursor = i + 2;
        while (cursor < end && identifier.test(tokens[cursor].text)) {
          path.push(tokens[cursor].text);
          cursor++;
          if (tokens[cursor]?.text !== "::") break;
          cursor++;
        }
        addPath(path, context, activeTest, i);
      }
      const close = pairs.get(i);
      if (close !== undefined) {
        walk(i + 1, close, context, activeTest);
        if (text === "{" && genericDepth === 0) {
          pendingTest = false;
          itemHeader = false;
          itemStart = true;
        }
        i = close;
      } else if (text === ";" || (text === "," && !itemHeader)) {
        pendingTest = false;
        itemHeader = false;
        genericDepth = 0;
        itemStart = true;
      }
    }
  }
  walk(0, tokens.length, modulePath(file.path), inheritedTestOnly);
  return result;
}

export function scanSources(input: readonly SourceFile[], policy: Policy = defaultPolicy) {
  const { allowedGraph, testFixtureEdges, compositionRoots, rootInlineModules, rootReexports } =
    policy;
  const graph: Readonly<Record<string, readonly string[]>> = {
    ...allowedGraph,
    ...compositionRoots,
  };
  const files = input.toSorted((a, b) => compare(a.path, b.path));
  assert.ok(files.length > 0, "no engine Rust sources found");
  assert.equal(
    new Set(files.map((file) => file.path)).size,
    files.length,
    "duplicate source paths",
  );
  // Propagate cfg(test) on `mod tests;` into separately stored modules. Production
  // declarations win if a file is shared by both production and test-only paths.
  const testFiles = new Set<string>();
  let scans: FileScan[] = [];
  for (let pass = 0; pass <= files.length; pass++) {
    scans = files.map((file) => scanFile(file, testFiles.has(file.path), policy));
    const declarations = new Map<string, boolean>();
    for (const scan of scans)
      for (const declaration of scan.declarations) {
        declarations.set(
          declaration.name,
          (declarations.get(declaration.name) ?? true) && declaration.testOnly,
        );
      }
    const next = new Set(
      files
        .filter((file) => declarations.get(modulePath(file.path).join("::")) === true)
        .map((file) => file.path),
    );
    if (Array.from(next).every((path) => testFiles.has(path)) && next.size === testFiles.size)
      break;
    testFiles.clear();
    for (const path of next) testFiles.add(path);
    assert.ok(pass < files.length, "test-only module classification did not converge");
  }
  const unique = new Map<string, Edge>();
  for (const scan of scans)
    for (const edge of scan.edges) if (!unique.has(edgeKey(edge))) unique.set(edgeKey(edge), edge);
  const edges = Array.from(unique.values()).sort((a, b) => compare(edgeKey(a), edgeKey(b)));
  const issues = scans.flatMap((scan) => scan.issues);
  for (const file of files) {
    const owner = ownerFor(file.path);
    if (!Object.hasOwn(graph, owner))
      issues.push({
        kind: "unknown-module",
        module: owner,
        location: { path: file.path, line: 1, column: 1 },
        detail: "source owner is absent from the allowed graph",
      });
  }
  issues.sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)));
  const violations = edges.filter((edge) => {
    const productionAllowed =
      Object.hasOwn(graph, edge.source) && graph[edge.source].includes(edge.target);
    const fixtureAllowed =
      edge.scope === "testOnly" &&
      Object.hasOwn(testFixtureEdges, edge.source) &&
      testFixtureEdges[edge.source].includes(edge.target);
    return !productionAllowed && !fixtureAllowed;
  });
  const count = (scope: Scope) => ({
    edges: edges.filter((edge) => edge.scope === scope).length,
    violations: violations.filter((edge) => edge.scope === scope).length,
  });
  return {
    schema: 1,
    identity: {
      kind: "lexical-source-scan",
      engineSourceSha256: digest(JSON.stringify(files)),
      // No binary was built; this scan is reproducible before or after its commit.
      binaryBuild: null,
    },
    contract: {
      version: 1,
      counting: "unique top-level source->target edges per production/testOnly scope",
      paths:
        "crate:: and grouped use trees; self/super resolved against conventional file and inline modules",
      exclusions:
        "comments and literals; no alias/re-export resolution, external crate paths or macro expansion",
      testScopes:
        "#[test] and cfg provably false without test; uncertain cfgs counted as production",
    },
    graph: allowedGraph,
    testFixtureEdges,
    compositionRoots,
    rootInlineModules,
    rootReexports,
    modules: Object.keys(graph)
      .sort(compare)
      .map((name) => ({
        name,
        kind: Object.hasOwn(compositionRoots, name) ? "composition-root" : "layer",
        files: files.filter((file) => ownerFor(file.path) === name).map((file) => file.path),
      })),
    edges,
    violations,
    issues,
    counts: {
      production: count("production"),
      testOnly: count("testOnly"),
      violations: violations.length,
      inventoryIssues: issues.length,
    },
    capabilities: {
      status: "not-measured",
      gate: "plan 006 step 6 separate Full/Lite compile-and-test matrix; lexical edges do not prove compilation",
    },
    sizes: { full: { rawBytes: null, gzipBytes: null }, lite: { rawBytes: null, gzipBytes: null } },
  };
}
export type Evidence = ReturnType<typeof scanSources>;

export function assertRatchet(current: Evidence, baseline: Evidence, label: string): void {
  for (const scope of ["production", "testOnly"] satisfies Scope[]) {
    assert.ok(
      current.counts[scope].violations <= baseline.counts[scope].violations,
      `${label}: ${scope} violations increased (${baseline.counts[scope].violations} -> ${current.counts[scope].violations})`,
    );
  }
  const permitted = new Set(baseline.violations.map(edgeKey));
  for (const edge of current.violations)
    assert.ok(permitted.has(edgeKey(edge)), `${label}: new violation ${edgeKey(edge)}`);
}

function readSources(root: string): SourceFile[] {
  function visit(path: string): SourceFile[] {
    return readdirSync(resolve(root, path), { withFileTypes: true }).flatMap((entry) => {
      const child = `${path}${entry.name}`;
      assert.ok(!entry.isSymbolicLink(), `source symlinks are not supported: ${child}`);
      if (entry.isDirectory()) return visit(`${child}/`);
      return entry.isFile() && entry.name.endsWith(".rs")
        ? [{ path: child, source: readFileSync(resolve(root, child), "utf8") }]
        : [];
    });
  }
  return visit(sourceRoot);
}
function git(root: string, args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" },
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function stringLists(value: unknown): Readonly<Record<string, readonly string[]>> {
  assert.ok(isRecord(value), "invalid layer policy map");
  const entries: [string, string[]][] = [];
  for (const [name, items] of Object.entries(value)) {
    assert.ok(
      Array.isArray(items) && items.every((item: unknown) => typeof item === "string"),
      "invalid layer policy target list",
    );
    entries.push([name, items]);
  }
  return Object.fromEntries(entries);
}
function storedPolicy(value: unknown): Policy {
  assert.ok(isRecord(value), "invalid committed layer evidence");
  assert.ok(isRecord(value.rootReexports), "invalid layer re-export map");
  const reexports: [string, string][] = [];
  for (const [name, target] of Object.entries(value.rootReexports)) {
    assert.ok(typeof target === "string", "invalid layer re-export target");
    reexports.push([name, target]);
  }
  return {
    allowedGraph: stringLists(value.graph),
    testFixtureEdges: stringLists(value.testFixtureEdges),
    compositionRoots: stringLists(value.compositionRoots),
    rootInlineModules: stringLists(value.rootInlineModules),
    rootReexports: Object.fromEntries(reexports),
  };
}
function committedScan(root: string, ref: string, label: string): Evidence {
  assert.match(ref, /^[a-f0-9]{40}$/, `${label} must be a full commit SHA`);
  assert.equal(
    git(root, ["rev-parse", "--verify", `${ref}^{commit}`]).trim(),
    ref,
    `${label} must identify an exact commit`,
  );
  const paths = git(root, ["ls-tree", "-r", "--name-only", "-z", ref, "--", sourceRoot])
    .split("\0")
    .filter((path) => path.endsWith(".rs"));
  const files = paths.map((path) => ({ path, source: git(root, ["show", `${ref}:${path}`]) }));
  const stored = git(root, ["ls-tree", "--name-only", ref, "--", evidencePath]).trim();
  if (stored) {
    const evidence: unknown = JSON.parse(git(root, ["show", `${ref}:${evidencePath}`]));
    // Verify an older snapshot using its deliberately recorded policy. This lets
    // future graph additions be reviewed without freezing today's inventory,
    // while neither edited counts nor stale source identities can be trusted.
    const scan = scanSources(files, storedPolicy(evidence));
    if (!isDeepStrictEqual(evidence, scan)) {
      // A normal merge may inherit an unchanged evidence blob while combining
      // new engine sources. Trust neither that stale digest nor arbitrary old
      // evidence: verify the identical parent blob, then ratchet the merge's
      // actual sources against that verified parent. Ordinary stale commits and
      // evidence edited in the merge still fail closed.
      const parents = git(root, ["rev-list", "--parents", "-n", "1", ref])
        .trim()
        .split(" ")
        .slice(1);
      const blob = git(root, ["ls-tree", ref, "--", evidencePath]);
      let inherited = false;
      if (parents.length > 1) {
        for (const parent of parents) {
          if (git(root, ["ls-tree", parent, "--", evidencePath]) !== blob) continue;
          const parentScan = committedScan(root, parent, `${label} inherited parent`);
          assertRatchet(scan, parentScan, `${label} merged sources`);
          inherited = true;
        }
      }
      if (!inherited)
        assert.deepEqual(
          evidence,
          scan,
          `${label}: committed layer evidence does not match its engine sources`,
        );
    }
    return scan;
  }
  // A first-baseline target has no JSON yet: scan its immutable sources instead
  // of skipping the ratchet or trusting candidate-provided numbers.
  return scanSources(files);
}

export function checkLayers(
  root: string,
  { record = false, baseRef }: { record?: boolean; baseRef?: string } = {},
): Evidence {
  const current = scanSources(readSources(root));
  assert.equal(
    current.issues.length,
    0,
    `layer inventory/scanner issues:\n${JSON.stringify(current.issues, null, 2)}`,
  );
  for (const edge of current.edges)
    assert.ok(
      Object.hasOwn(graph, edge.target),
      `unknown rooted target ${edge.target} at ${edge.location.path}:${edge.location.line}`,
    );
  const head = git(root, ["rev-parse", "HEAD"]).trim();
  assertRatchet(current, committedScan(root, head, "committed HEAD"), "committed HEAD");
  if (baseRef)
    assertRatchet(current, committedScan(root, baseRef, "LAYERS_BASE_REF"), "immutable target");
  const path = resolve(root, evidencePath);
  if (record) writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`);
  else {
    assert.ok(
      existsSync(path),
      "missing layer evidence; run node scripts/check-layers.ts --record",
    );
    const stored: unknown = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(
      stored,
      current,
      "layer evidence is stale or edited; explicitly refresh with --record (ratchets still apply)",
    );
  }
  return current;
}

export function optionsFor(args: readonly string[], environment: NodeJS.ProcessEnv = process.env) {
  let record = false;
  let baseRef = environment.LAYERS_BASE_REF;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--record") record = true;
    else if (args[i] === "--base-ref") {
      const value = args[++i];
      assert.ok(value && !value.startsWith("--"), "--base-ref requires a full commit SHA");
      baseRef = value;
    } else throw new Error(`unknown layer-check argument ${args[i]}`);
  }
  if (baseRef !== undefined)
    assert.match(baseRef, /^[a-f0-9]{40}$/, "LAYERS_BASE_REF/--base-ref must be a full commit SHA");
  return { record, baseRef };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const scan = checkLayers(resolve(import.meta.dirname, ".."), optionsFor(process.argv.slice(2)));
    console.log(
      `Engine layers: ${scan.counts.production.violations} production + ${scan.counts.testOnly.violations} test-only violations; ${scan.counts.production.edges} production + ${scan.counts.testOnly.edges} test-only unique edges. Capability matrix and Full/Lite sizes: not measured.`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
