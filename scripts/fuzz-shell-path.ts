#!/usr/bin/env node
import { validateResultBytes } from "./fuzz-shell-results.ts";
// Original bounded PATH grammar and portable filesystem manifest. Process lifetime,
// byte comparison, CLI and fixture identity follow the functions oracle family.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  healthy,
  matches,
  optionsFor as sharedOptionsFor,
  outputLimit,
} from "./fuzz-shell-control-flow.mjs";
import { drainGroup, killGroup } from "./shell-process-group.mjs";
export { healthy, matches, outputLimit };

import {
  encode,
  decode,
  type FuzzFixture,
  type FuzzOptions,
  type RecordedCase,
  type ProcessResult,
  type RunOptions,
} from "./fuzz-shell-results.ts";
type Case = ReturnType<typeof generateCases>[number];

export const defaultCount = 128;
export const defaultTimeoutMs = 2000;
export const probe = "bw_path_probe_5315";
export type FixtureNode = {
  path: string;
  kind: "directory" | "file";
  mode: number;
  marker?: string;
  status?: number;
};
// The opt-in standalone native/WASI test host consumes this exact manifest. It
// must install real metadata/access decisions and exact-path process programs;
// it must never turn a bare registration into an implicit executable lookup.
export const filesystem: FixtureNode[] = [
  { path: "path-a", kind: "directory", mode: 0o755 },
  { path: "path-b", kind: "directory", mode: 0o755 },
  { path: "path-noexec", kind: "directory", mode: 0o755 },
  { path: "path-dir", kind: "directory", mode: 0o755 },
  { path: "path-denied", kind: "directory", mode: 0o000 },
  { path: "path space", kind: "directory", mode: 0o755 },
  { path: "work", kind: "directory", mode: 0o755 },
  { path: "work/path-a", kind: "directory", mode: 0o755 },
  { path: probe, kind: "file", mode: 0o755, marker: "cwd", status: 3 },
  { path: "path-a/" + probe, kind: "file", mode: 0o755, marker: "a", status: 7 },
  { path: "path-b/" + probe, kind: "file", mode: 0o755, marker: "b", status: 9 },
  { path: "path-noexec/" + probe, kind: "file", mode: 0o600, marker: "nonexec", status: 21 },
  { path: "path-dir/" + probe, kind: "directory", mode: 0o755 },
  { path: "path-denied/" + probe, kind: "file", mode: 0o755, marker: "denied", status: 23 },
  { path: "path space/" + probe, kind: "file", mode: 0o755, marker: "space", status: 15 },
  { path: "work/" + probe, kind: "file", mode: 0o755, marker: "work", status: 11 },
  { path: "work/path-a/" + probe, kind: "file", mode: 0o755, marker: "work-a", status: 13 },
  { path: "path-file", kind: "file", mode: 0o600 },
  { path: "path-a/printf", kind: "file", mode: 0o755, marker: "external-printf", status: 17 },
  { path: "path-a/shadow", kind: "file", mode: 0o755, marker: "external-shadow", status: 19 },
];
export const fixtureEnvironmentKey = "BASH_WEB_PATH_FIXTURE";
export const fixtureManifest = { schema: 1, nodes: filesystem };
// Shared wire-contract limits; the Rust consumer enforces the same limits before
// copying strings, growing its node list, or touching its virtual filesystem.
export const manifestLimits = { bytes: 32768, nodes: 128, pathBytes: 256, markerBytes: 64 };
export function validateManifest(value: unknown): asserts value is typeof fixtureManifest {
  const object = (item: unknown): item is Record<string, unknown> =>
    item !== null && typeof item === "object" && !Array.isArray(item);
  const keys = (item: Record<string, unknown>, allowed: readonly string[]) => {
    if (Object.keys(item).some((key) => !allowed.includes(key)))
      throw new Error("unknown fixture field");
  };
  if (!object(value)) throw new Error("invalid fixture manifest");
  keys(value, ["schema", "nodes"]);
  if (
    value.schema !== 1 ||
    !Array.isArray(value.nodes) ||
    value.nodes.length > manifestLimits.nodes
  )
    throw new Error("unsupported or oversized fixture manifest");
  const directories = new Set<string>();
  const paths = new Set<string>();
  for (const node of value.nodes) {
    if (!object(node)) throw new Error("invalid fixture node");
    keys(node, ["path", "kind", "mode", "marker", "status"]);
    if (
      typeof node.path !== "string" ||
      !node.path.isWellFormed() ||
      Buffer.byteLength(node.path) > manifestLimits.pathBytes ||
      !node.path ||
      Array.from(node.path).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
      node.path.split("/").some((part) => !part || part === "." || part === "..") ||
      paths.has(node.path)
    )
      throw new Error("invalid or duplicate fixture path");
    const slash = node.path.lastIndexOf("/");
    if (slash >= 0 && !directories.has(node.path.slice(0, slash)))
      throw new Error("fixture parent must be an earlier directory");
    if (
      !["directory", "file"].includes(node.kind as string) ||
      !Number.isInteger(node.mode) ||
      (node.mode as number) < 0 ||
      (node.mode as number) > 0o777
    )
      throw new Error("invalid fixture kind or mode");
    const program = Object.hasOwn(node, "marker") || Object.hasOwn(node, "status");
    if (
      program &&
      (node.kind !== "file" ||
        typeof node.marker !== "string" ||
        !/^[a-zA-Z0-9_-]+$/.test(node.marker) ||
        Buffer.byteLength(node.marker) > manifestLimits.markerBytes ||
        !Number.isInteger(node.status) ||
        (node.status as number) < 1 ||
        (node.status as number) > 255)
    )
      throw new Error("invalid fixture program");
    paths.add(node.path);
    if (node.kind === "directory") directories.add(node.path);
  }
}
export function parseManifest(raw: string) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > manifestLimits.bytes)
    throw new Error("oversized fixture JSON");
  const manifest: unknown = JSON.parse(raw);
  validateManifest(manifest);
  return manifest;
}
validateManifest(fixtureManifest);
export const fixtureManifestJson = JSON.stringify(fixtureManifest);
parseManifest(fixtureManifestJson);
export const environment = {
  locale: "C",
  path: "/usr/bin:/bin",
  stdin: "empty",
  shellArgs: ["-c", "SCRIPT"],
  jobControl: "off",
  filesystem: fixtureManifest,
  fixtureEnvironmentKey,
  scope:
    "PATH lookup and command -v/-V; explicit portable filesystem/access/process fixture; no aliases, hashing, symlinks or interpreter fallback",
  isolation:
    "fresh identical filesystem per observation; explicit PWD equals actual cwd; ancestor permission controls applied after provisioning and restored before removal",
  dynamicQueries:
    "input programs assert exact expected answers for cwd-dependent query output, preserve query status, and print unexpected answers on failure; all captured bytes remain unchanged; ordinary relative command -v output is direct",
  comparison: "stdout bytes and exit status; stderr retained as diagnostics, not compared",
};
export const searchPaths = [
  "",
  ":",
  "::",
  "missing",
  "path-a",
  "path-b:path-a",
  "path-a:path-b",
  ":path-a",
  "path-a:",
  "missing::path-a",
  "missing:",
  ":missing",
  "missing::missing",
  "./path-a",
  "path-b/../path-a",
  "path-a/.",
  "path space",
  "path-noexec",
  "path-dir",
  "path-denied",
  "path-file",
  "path-noexec:path-b",
  "path-dir:path-b",
  "path-denied:path-b",
  "path-file:path-b",
  "path-noexec:missing",
  "path-dir:path-noexec",
  "path-noexec:",
  "path-noexec:path-dir",
  "path-denied:path-noexec",
  "path-dir:path-noexec:path-b",
  "path-noexec:path-dir:path-b",
];
// Expected directory spellings for the source-level verbose-query assertions,
// aligned with searchPaths. null means Bash should print no successful answer.
// These are input-program predicates, not an output filter or fixture rewrite.
export const selectedDirectories = [
  "",
  "",
  "",
  null,
  "path-a",
  "path-b",
  "path-a",
  "",
  "path-a",
  "",
  "",
  "",
  "",
  "path-a",
  "path-b/../path-a",
  "path-a/.",
  "path space",
  "path-noexec",
  null,
  null,
  null,
  "path-b",
  "path-b",
  "path-b",
  "path-b",
  "path-noexec",
  null, // An earlier directory suppresses the later nonexec regular fallback.
  "",
  "path-noexec",
  "path-noexec",
  "path-b",
  "path-b",
];
export const variants: Record<string, string[]> = {
  search: searchPaths.map((_, index) => "path-" + index).concat(["unset", "generated"]),
  cwd: ["empty", "relative", "parent", "double-empty", "change-after-query"],
  precedence: [
    "function",
    "command-bypass",
    "builtin",
    "command-builtin",
    "command-double-dash",
    "prefix-path",
    "prefix-restored",
    "function-query-v",
    "function-query-V",
    "builtin-query-v",
    "builtin-query-V",
    "command-query-bypasses-function",
  ],
  slash: [
    "relative",
    "dot",
    "absolute",
    "missing",
    "nonexec",
    "directory",
    "not-directory",
    "denied",
  ],
  query: [
    "v",
    "V",
    "unset-v",
    "unset-V",
    "missing-v",
    "missing-V",
    "mixed-v",
    "mixed-V",
    "all-missing-v",
    "all-missing-V",
    "no-args-v",
    "no-args-V",
    "slash-v",
    "slash-V",
    "absolute-v",
    "absolute-V",
    "nonexec-v",
    "nonexec-V",
    "directory-v",
    "directory-V",
    "denied-v",
    "denied-V",
    "not-directory-v",
    "not-directory-V",
    "slash-nonexec-v",
    "slash-nonexec-V",
    "slash-directory-v",
    "slash-directory-V",
    "slash-denied-v",
    "slash-denied-V",
    "slash-missing-v",
    "slash-missing-V",
    "builtin-function-external-v",
    "builtin-function-external-V",
  ],
};
export const families = Object.keys(variants);
export const generatedValues = Array.from(
  { length: 32 },
  (_, n) => `arg${n}${n % 2 ? " space*?[x]" : "'\"$\\"}${n % 3 ? "" : "\nline"}`,
);
// Generated arguments must reach an executable; error-only paths remain fixed
// controls rather than padding their observations with inert randomized values.
export const generatedPaths = searchPaths
  .slice(0, 3)
  .concat(searchPaths.slice(4, 17), searchPaths.slice(21, 25));
export const maxGeneratedCount = generatedValues.length * generatedPaths.length;
type Spec = { family: string; variant: string; value: string; path?: string; query?: "-v" | "-V" };
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const status = (label: string) => `printf '${label}=%s\\n' "$?"`;
const observe = 'path_status=$?; command printf "status=%s\\n" "$path_status"; exit "$path_status"';
const invocation = (value: string) => `${probe} ${quote(value)} 'tail arg'`;
// command -V expands relative PATH answers against the observation's fresh cwd.
// Assert that complete answer inside the shell input, retaining the query's exit
// code and exposing unexpected answers. Nothing rewrites captured stdout/stderr.
const exactQuery = (command: string, expectedExpression: string) =>
  `path_answer=$(${command}); path_query_status=$?; if test "$path_answer" = ${expectedExpression}; then printf 'query-exact=1\\n'; else printf 'query-exact=0\\nunexpected=<%s>\\n' "$path_answer"; fi; (exit "$path_query_status")`;
const verboseExpected = (directory: string | null) =>
  directory === null ? "''" : `"${probe} is $PWD${directory ? "/" + directory : ""}/${probe}"`;
export function render(spec: Spec) {
  if (
    !families.includes(spec.family) ||
    !variants[spec.family]?.includes(spec.variant) ||
    typeof spec.value !== "string"
  )
    throw new Error("invalid path specification");
  let body: string;
  if (spec.family === "search") {
    if (spec.variant === "unset") body = `unset PATH; ${invocation(spec.value)}`;
    else {
      const path =
        spec.variant === "generated" ? spec.path : searchPaths[Number(spec.variant.slice(5))];
      if (
        typeof path !== "string" ||
        (spec.variant === "generated" && !generatedPaths.includes(path))
      )
        throw new Error("invalid generated path");
      if (
        spec.query !== undefined &&
        (!["-v", "-V"].includes(spec.query) || spec.variant === "generated")
      )
        throw new Error("invalid query mode");
      const query =
        spec.query === "-V"
          ? exactQuery(
              `command -V ${probe}`,
              verboseExpected(selectedDirectories[Number(spec.variant.slice(5))]),
            )
          : `command -v ${probe}`;
      body = `PATH=${quote(path)}; ${spec.query ? query : invocation(spec.value)}`;
    }
  } else
    switch (spec.family + "/" + spec.variant) {
      case "cwd/empty":
        body = `PATH=; cd work; ${invocation(spec.value)}`;
        break;
      case "cwd/relative":
        body = `PATH=path-a; cd work; ${invocation(spec.value)}`;
        break;
      case "cwd/parent":
        body = `PATH=../path-b; cd work; ${invocation(spec.value)}`;
        break;
      case "cwd/double-empty":
        body = `PATH=missing::path-a; cd work; ${invocation(spec.value)}`;
        break;
      case "cwd/change-after-query":
        body = `PATH=path-a; command -v ${probe}; cd work; command -v ${probe}; ${invocation(spec.value)}`;
        break;
      case "precedence/function":
        body = `PATH=path-a; shadow() { printf 'function\\n'; }; shadow`;
        break;
      case "precedence/command-bypass":
        body = `PATH=path-a; shadow() { printf 'function\\n'; }; shadow; command shadow 'argument' 'tail arg'`;
        break;
      case "precedence/builtin":
        body = `PATH=path-a; printf 'builtin\\n'`;
        break;
      case "precedence/command-builtin":
        body = `PATH=path-a; printf() { echo function; }; command printf 'builtin\\n'`;
        break;
      case "precedence/command-double-dash":
        body = `PATH=path-a; command -- ${invocation(spec.value)}`;
        break;
      case "precedence/prefix-path":
        body = `PATH=path-a; PATH=path-b command ${invocation(spec.value)}`;
        break;
      case "precedence/prefix-restored":
        body = `PATH=path-a; PATH=path-b command ${invocation(spec.value)}; ${status("temporary")}; ${invocation(spec.value)}`;
        break;
      case "precedence/function-query-v":
        body = `PATH=path-a; shadow() { :; }; command -v shadow`;
        break;
      case "precedence/function-query-V":
        body = `PATH=path-a; shadow() { :; }; command -V shadow`;
        break;
      case "precedence/builtin-query-v":
        body = `PATH=path-a; command -v printf`;
        break;
      case "precedence/builtin-query-V":
        body = `PATH=path-a; command -V printf`;
        break;
      case "precedence/command-query-bypasses-function":
        body = `PATH=path-a; shadow() { :; }; command command -v shadow`;
        break;
      case "slash/relative":
        body = `PATH=path-b; path-a/${invocation(spec.value)}`;
        break;
      case "slash/dot":
        body = `PATH=path-b; ./${invocation(spec.value)}`;
        break;
      case "slash/absolute":
        body = `PATH=path-b; "$PWD/path-a/${probe}" ${quote(spec.value)} 'tail arg'`;
        break;
      case "slash/missing":
        body = `PATH=path-a; missing/${invocation(spec.value)}`;
        break;
      case "slash/nonexec":
        body = `PATH=path-b; path-noexec/${invocation(spec.value)}`;
        break;
      case "slash/directory":
        body = `PATH=path-b; path-dir/${invocation(spec.value)}`;
        break;
      case "slash/not-directory":
        body = `PATH=path-b; path-file/${invocation(spec.value)}`;
        break;
      case "slash/denied":
        body = `PATH=path-b; path-denied/${invocation(spec.value)}`;
        break;
      default:
        body = renderQuery(spec);
    }
  return `${body}\n${observe}\n`;
}
function renderQuery(spec: Spec) {
  if (spec.family !== "query") throw new Error("missing path variant");
  const verbose = spec.variant.endsWith("-V") || spec.variant === "V";
  const option = verbose ? "-V" : "-v";
  const kind = spec.variant.replace(/-?[vV]$/, "");
  const prefixes: Record<string, string> = {
    nonexec: "path-noexec",
    directory: "path-dir",
    denied: "path-denied",
    "not-directory": "path-file",
  };
  if (Object.hasOwn(prefixes, kind)) {
    const directory = kind === "nonexec" ? "path-noexec" : null;
    return `PATH=${prefixes[kind]}; ${verbose ? exactQuery(`command -V ${probe}`, verboseExpected(directory)) : `command -v ${probe}`}`;
  } else if (kind === "unset") {
    return `unset PATH; ${exactQuery(`command ${option} ${probe}`, verbose ? verboseExpected("") : `"$PWD/${probe}"`)}`;
  } else if (
    kind.startsWith("slash-") &&
    (Object.hasOwn(prefixes, kind.slice(6)) || kind === "slash-missing")
  )
    return `PATH=path-a; command ${option} ${prefixes[kind.slice(6)] ?? "missing"}/${probe}`;
  else if (kind === "absolute") {
    const expected = verbose
      ? `"$PWD/path-a/${probe} is $PWD/path-a/${probe}"`
      : `"$PWD/path-a/${probe}"`;
    return `PATH=path-b; ${exactQuery(`command ${option} "$PWD/path-a/${probe}"`, expected)}`;
  } else {
    const operands = {
      "": probe,
      missing: "bw_path_missing_5315",
      mixed: `bw_path_missing_5315 ${probe} bw_path_other_missing_5315`,
      "all-missing": "bw_path_missing_5315 bw_path_other_missing_5315",
      "no-args": "",
      slash: `./path-a/${probe}`,
      "builtin-function-external": `printf shadow ${probe}`,
    }[kind];
    if (operands === undefined) throw new Error("missing query variant");
    const prefix = kind === "builtin-function-external" ? "shadow() { :; }; " : "";
    let query = `command ${option} ${operands}`;
    if (verbose && ["", "mixed", "builtin-function-external"].includes(kind)) {
      const expected =
        kind === "builtin-function-external"
          ? quote("printf is a shell builtin\nshadow is a function\nshadow () \n{ \n    :\n}\n") +
            verboseExpected("path-a")
          : verboseExpected("path-a");
      query = exactQuery(query, expected);
    }
    return `PATH=path-a; ${prefix}${query}`;
  }
}
function makeCase(id: string, spec: Spec) {
  return { id, ...spec, tags: [spec.family, "variant=" + spec.variant], script: render(spec) };
}
export function matrixCases() {
  const cases = [];
  for (const family of families)
    for (const variant of variants[family]) {
      if (variant !== "generated")
        cases.push(
          makeCase("matrix-" + cases.length, { family, variant, value: "fixed argument" }),
        );
    }
  // Queries must exercise the same candidate search ordering as execution,
  // including nonexec fallback and skipped directories/denied ancestors.
  for (const index of searchPaths.keys())
    for (const query of ["-v", "-V"] as const) {
      cases.push(
        makeCase("matrix-" + cases.length, {
          family: "search",
          variant: "path-" + index,
          value: "fixed argument",
          query,
        }),
      );
    }
  return cases;
}
export function generateCases(seed: number, count = defaultCount) {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)
    throw new Error("invalid uint32 seed");
  if (!Number.isSafeInteger(count) || count < 0 || count > maxGeneratedCount)
    throw new Error(`invalid count (0..${maxGeneratedCount})`);
  let state = seed >>> 0;
  const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
  const available = Array.from({ length: maxGeneratedCount }, (_, index) => index);
  const cases = matrixCases();
  for (let index = 0; index < count; index++) {
    const selected = next() % available.length;
    const tuple = available[selected];
    available[selected] = available[available.length - 1];
    available.pop();
    cases.push(
      makeCase("generated-" + index, {
        family: "search",
        variant: "generated",
        path: generatedPaths[Math.floor(tuple / generatedValues.length)],
        value: generatedValues[tuple % generatedValues.length],
      }),
    );
  }
  return cases;
}
export function coverage(cases: readonly Case[]) {
  const unique = (fn: (item: Case) => string | undefined) =>
    Array.from(new Set(cases.map(fn))).sort();
  return {
    families: unique((item) => item.family),
    variants: unique((item) => item.family + "/" + item.variant),
    paths: unique((item) => item.path).filter((item) => item !== undefined),
    queries: unique((item) => item.query).filter((item) => item !== undefined),
  };
}
const sandboxDirectories = new Map<string, string[]>();
export function provision(sandbox: string, raw = fixtureManifestJson) {
  // Reject the complete wire document before creating even the first node.
  const manifest = parseManifest(raw);
  const root = resolve(sandbox);
  if (sandboxDirectories.has(root)) throw new Error("fixture sandbox already provisioned");
  // Retain the validated parent-first cleanup list even if installation fails.
  sandboxDirectories.set(
    root,
    manifest.nodes.filter((node) => node.kind === "directory").map((node) => node.path),
  );
  for (const node of manifest.nodes) {
    const path = resolve(sandbox, node.path);
    if (node.kind === "directory") mkdirSync(path, { recursive: true });
    else
      writeFileSync(
        path,
        node.marker === undefined
          ? "ordinary file\n"
          : `#!/usr/bin/bash\nprintf 'marker=<%s>\\n' ${quote(node.marker)}\nprintf 'arg=<%s>\\n' "$@"\nexit ${node.status}\n`,
        { mode: node.mode },
      );
  }
  for (const node of manifest.nodes.toReversed()) chmodSync(resolve(sandbox, node.path), node.mode);
}
export function removeSandbox(sandbox: string) {
  const root = resolve(sandbox);
  // Restore this installation's directories parent-first. Never chmod through a
  // replaced symlink or one of its descendants; recursive rm unlinks it instead.
  if (lstatSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    const searchable = new Set([""]);
    for (const path of sandboxDirectories.get(root) ?? []) {
      const slash = path.lastIndexOf("/");
      if (slash >= 0 && !searchable.has(path.slice(0, slash))) continue;
      const directory = resolve(root, path);
      if (!lstatSync(directory, { throwIfNoEntry: false })?.isDirectory()) continue;
      chmodSync(directory, 0o755);
      searchable.add(path);
    }
  }
  rmSync(root, { recursive: true, force: true });
  sandboxDirectories.delete(root);
}
export async function run(
  bin: string,
  script: string,
  options: RunOptions,
): Promise<ProcessResult> {
  if (options.interrupted) throw new Error("interrupted");
  if (process.geteuid?.() === 0)
    throw new Error("PATH permission fixtures require an unprivileged host user");
  if (!options.cwd) throw new Error("process sandbox parent required");
  const sandbox = mkdtempSync(resolve(options.cwd, "process-"));
  let child: ReturnType<typeof spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    provision(sandbox);
    const running = spawn(bin, ["-c", script], {
      cwd: sandbox,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: "/usr/bin:/bin",
        HOME: sandbox,
        TMPDIR: sandbox,
        PWD: sandbox,
        LC_ALL: "C",
        LANG: "C",
        [fixtureEnvironmentKey]: fixtureManifestJson,
      },
    });
    child = running;
    const chunks: { stdout: Buffer[]; stderr: Buffer[] } = { stdout: [], stderr: [] };
    let bytes = 0,
      timedOut = false,
      error: string | null = null;
    const stop = (reason: string) => {
      error ??= reason;
      killGroup(running.pid, "SIGKILL");
    };
    timer = setTimeout(() => {
      timedOut = true;
      stop("ETIMEDOUT");
    }, options.timeoutMs);
    for (const name of ["stdout", "stderr"] as const)
      running[name].on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > outputLimit) stop("ENOBUFS");
        else chunks[name].push(chunk);
      });
    const result = await new Promise<{ status: number | null; signal: NodeJS.Signals | null }>(
      (done) => {
        running.once("error", (failure: NodeJS.ErrnoException) => {
          error ??= failure.code ?? "SPAWN_ERROR";
        });
        running.once("close", (status, signal) => done({ status, signal: signal ?? null }));
      },
    );
    return {
      ...result,
      timedOut,
      error,
      stdout: Buffer.concat(chunks.stdout),
      stderr: Buffer.concat(chunks.stderr),
    };
  } finally {
    clearTimeout(timer);
    await drainGroup(child?.pid);
    removeSandbox(sandbox);
  }
}
const root = resolve(import.meta.dirname, "..");
const sourcePath = fileURLToPath(import.meta.url);
const bashBin = "/usr/bin/bash";
const oracleVersion = /^GNU bash, version 5\.3\.15(?:\(|\s)/;
const queue = process.env.FUZZ_HEAVY_RUNNER;
export function scratchParent(env = process.env) {
  return env.FUZZ_JOB_SCRATCH ?? env.RUNNER_TEMP ?? tmpdir();
}
export const sourceFiles = [
  "fuzz-shell-path.ts",
  "fuzz-shell-control-flow.mjs",
  "fuzz-shell-results.ts",
  "shell-process-group.mjs",
];
export const sourceHashes = () =>
  Object.fromEntries(
    sourceFiles.map((name) => [
      name,
      createHash("sha256")
        .update(readFileSync(new URL(name, import.meta.url)))
        .digest("hex"),
    ]),
  );
export const fingerprint = () =>
  createHash("sha256").update(JSON.stringify(sourceHashes())).digest("hex");
export function optionsFor(args: string[]) {
  const options = sharedOptionsFor(["--count", String(defaultCount)].concat(args));
  if (options.count > maxGeneratedCount) throw new Error(`invalid count (0..${maxGeneratedCount})`);
  return options;
}
export function validateFixture(path: string, fixture: FuzzFixture<Case>, options: FuzzOptions) {
  if (
    fixture.schema !== 1 ||
    fixture.sourceHash !== fingerprint() ||
    JSON.stringify(fixture.sourceHashes) !== JSON.stringify(sourceHashes())
  )
    throw new Error("stale path fixture hash/schema");
  if (
    !oracleVersion.test(fixture.bash ?? "") ||
    fixture.oraclePath !== bashBin ||
    JSON.stringify(fixture.environment) !== JSON.stringify(environment)
  )
    throw new Error("fixture oracle/environment differs");
  if (!["oracle-only", "candidate-verified"].includes(fixture.provenance))
    throw new Error("fixture provenance differs");
  if (fixture.count !== options.count || fixture.timeoutMs !== options.timeoutMs)
    throw new Error("fixture count/timeout differs");
  if (
    !Number.isInteger(fixture.seed) ||
    fixture.seed < 0 ||
    fixture.seed > 0xffffffff ||
    (options.explicitSeed && fixture.seed !== options.seed)
  )
    throw new Error("fixture seed differs");
  const filenameSeed = /shell-path-seed-(\d+)\.json$/.exec(path);
  if (!filenameSeed || Number(filenameSeed[1]) !== fixture.seed)
    throw new Error("fixture filename seed differs");
  const cases = generateCases(fixture.seed, fixture.count);
  if (JSON.stringify(fixture.coverage) !== JSON.stringify(coverage(cases)))
    throw new Error("fixture coverage differs");
  if (!Array.isArray(fixture.cases) || fixture.cases.length !== cases.length)
    throw new Error("fixture length differs");
  for (const [index, item] of cases.entries()) {
    const entry = fixture.cases[index];
    if (JSON.stringify(entry?.case) !== JSON.stringify(item))
      throw new Error("fixture case differs at " + index);
    if (!entry?.bash || !healthy(entry.bash))
      throw new Error("invalid fixture process result at " + index);
    validateResultBytes(entry.bash, outputLimit, index);
  }
  return cases;
}
export async function execute<T extends { id: string; family: string; script: string }>(
  cases: readonly T[],
  options: Pick<FuzzOptions, "cwd" | "timeoutMs" | "interrupted" | "record" | "recordOracle">,
  shell: string,
  recorded?: readonly Pick<RecordedCase<T>, "bash">[],
) {
  const counts = { MATCH: 0, MISMATCH: 0 },
    byFamily: Record<string, { MATCH: number; MISMATCH: number }> = {},
    mismatches = [],
    results = [];
  for (const [index, item] of cases.entries()) {
    if (options.interrupted) throw new Error("interrupted");
    const bash = recorded ? decode(recorded[index].bash) : await run(bashBin, item.script, options);
    if (!healthy(bash))
      throw new Error("unrecordable oracle: " + item.id + " " + JSON.stringify(encode(bash)));
    if (options.record || options.recordOracle) results.push({ case: item, bash: encode(bash) });
    if (options.recordOracle) continue;
    const candidate = await run(shell, item.script, options);
    const outcome = matches(bash, candidate) ? "MATCH" : "MISMATCH";
    counts[outcome]++;
    (byFamily[item.family] ??= { MATCH: 0, MISMATCH: 0 })[outcome]++;
    if (outcome === "MISMATCH" && mismatches.length < 24)
      mismatches.push({ case: item, bash: encode(bash), candidate: encode(candidate) });
  }
  return { total: cases.length, counts, byFamily, mismatches, results };
}
function ensureQueued() {
  if (process.argv.includes("--queue-active") || !queue) return;
  const child = spawnSync(
    "bun",
    [
      queue,
      "--class",
      "light",
      "bash-web-path-fuzz",
      "--",
      bashBin,
      "-c",
      'ulimit -c 0; exec "$@"',
      "path-fuzz",
      process.execPath,
      sourcePath,
    ].concat(process.argv.slice(2), ["--queue-active"]),
    { cwd: root, stdio: "inherit", env: process.env },
  );
  if (child.error) throw child.error;
  process.exit(child.status ?? 1);
}
async function main() {
  const options = optionsFor(process.argv.slice(2));
  if (options.help) {
    console.log(
      "Usage: node scripts/fuzz-shell-path.ts [--shell PATH] [--seed N] [--count 128]\n  --record-oracle PATH  Independent GNU Bash 5.3.15 recording\n  --record PATH         Record only strict candidate matches\n  --replay PATH         Strict all-case replay; repeatable; never invokes Bash\n  --self-control        Two independent Bash observations\n  --output PATH         Bounded diagnostics\nRequires the opt-in BASH_WEB_PATH_FIXTURE native/WASI test host manifest contract. No automatic build; optional FUZZ_HEAVY_RUNNER queues --class light.",
    );
    return;
  }
  ensureQueued();
  const shell = options.selfControl
    ? bashBin
    : (options.shell ??
      process.env.FUZZ_SHELL_BIN ??
      resolve(root, ".build/shell/release/shell-engine"));
  if (!options.recordOracle && !existsSync(shell))
    throw new Error("pass an existing native --shell PATH: " + shell);
  if (options.record && realpathSync(shell) === realpathSync(bashBin))
    throw new Error("cannot candidate-verify against Bash itself; use --record-oracle");
  const parent = scratchParent();
  mkdirSync(parent, { recursive: true });
  const scratch = mkdtempSync(resolve(parent, "oracle-run-"));
  options.cwd = scratch;
  const onSignal = () => {
    options.interrupted = true;
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    const reports = [];
    if (options.replays.length) {
      const inputs = options.replays.map((path) => {
        const fixture: FuzzFixture<Case> = JSON.parse(readFileSync(path, "utf8"));
        return { path, fixture, cases: validateFixture(path, fixture, options) };
      });
      for (const { path, fixture, cases } of inputs)
        reports.push({
          path,
          seed: fixture.seed,
          ...(await execute(cases, options, shell, fixture.cases)),
        });
    } else {
      const bash = execFileSync(bashBin, ["--version"], {
        encoding: "utf8",
        env: { LC_ALL: "C", PATH: "/usr/bin:/bin" },
        timeout: options.timeoutMs,
        maxBuffer: outputLimit,
      }).split("\n", 1)[0];
      if (!oracleVersion.test(bash)) throw new Error("Bash 5.3.15 required, got " + bash);
      const cases = generateCases(options.seed, options.count),
        result = await execute(cases, options, shell);
      reports.push({ seed: options.seed, bash, ...result });
      const recordPath = options.record ?? options.recordOracle;
      if (recordPath && result.counts.MISMATCH)
        throw new Error("refusing candidate-verified recording with differences");
      if (recordPath) {
        const fixture = {
          schema: 1,
          sourceHash: fingerprint(),
          sourceHashes: sourceHashes(),
          seed: options.seed,
          count: options.count,
          timeoutMs: options.timeoutMs,
          bash,
          oraclePath: bashBin,
          environment,
          provenance: options.recordOracle ? "oracle-only" : "candidate-verified",
          coverage: coverage(cases),
          cases: result.results,
        };
        validateFixture(recordPath, fixture, options);
        mkdirSync(dirname(recordPath), { recursive: true });
        writeFileSync(recordPath, JSON.stringify(fixture, null, 2) + "\n");
      }
    }
    const report = {
      schema: 1,
      sourceHash: fingerprint(),
      environment,
      mode: options.replays.length
        ? "replay"
        : options.recordOracle
          ? "oracle-only"
          : options.selfControl
            ? "bash-self-control"
            : "live",
      shell: options.recordOracle ? null : shell,
      reports: reports.map(({ results: _results, ...report }) => report),
    };
    const text = JSON.stringify(report, null, 2) + "\n";
    if (options.output) {
      mkdirSync(dirname(options.output), { recursive: true });
      writeFileSync(options.output, text);
    }
    process.stdout.write(text);
    if (options.interrupted) process.exitCode = 130;
    else if (reports.some((report) => report.counts.MISMATCH)) process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    rmSync(scratch, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(error.stack ?? error);
    process.exitCode = 1;
  });
