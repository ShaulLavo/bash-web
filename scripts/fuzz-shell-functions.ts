#!/usr/bin/env node
import { validateResultBytes } from "./fuzz-shell-results.ts";
// Original bounded scalar-functions grammar. Harness/fixture plumbing is adapted
// from fuzz-shell-job-lifetime.mjs; process ownership comes from its shared runner.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  healthy,
  matches,
  optionsFor as sharedOptionsFor,
  outputLimit,
  run,
} from "./fuzz-shell-control-flow.mjs";

export { healthy, matches, outputLimit, run };
import {
  encode,
  decode,
  type FuzzFixture,
  type FuzzOptions,
  type RecordedCase,
} from "./fuzz-shell-results.ts";
type Case = ReturnType<typeof generateCases>[number];

export const defaultCount = 128;
export const defaultTimeoutMs = 2000;
export const values = ["", "a b", "x'\"$*\\\nend"];
export const variants: Record<string, string[]> = {
  local: [
    "dynamic",
    "shadow",
    "unset",
    "unset-bare",
    "unset-redeclare",
    "nested-unset",
    "uninitialized",
    "redeclaration",
    "multiple",
    "assignment-status",
    "readonly",
    "export",
    "invalid-name",
  ],
  state: ["ordinary", "subshell", "async", "pipeline-left", "pipeline-right", "lastpipe"],
  arguments: [
    "quoted-at",
    "quoted-star",
    "unquoted-at",
    "unquoted-star",
    "empty-at",
    "zero",
    "nested",
    "recursive",
  ],
  positionals: [
    "set",
    "clear",
    "shift",
    "shift-zero",
    "shift-overflow",
    "shift-negative",
    "shift-invalid",
    "shift-many",
    "shift-empty",
    "shift-arithmetic",
  ],
  return: [
    "implicit",
    "last-status",
    "explicit",
    "negative",
    "wrapped",
    "plus",
    "large",
    "overflow",
    "invalid",
    "many",
    "outside",
    "outside-invalid",
    "nested",
    "loop",
    "subshell",
    "async",
    "pipeline",
    "readonly-local",
  ],
  prefix: [
    "restore",
    "unset",
    "local",
    "nested",
    "argument-expansion",
    "export",
    "readonly",
    "readonly-inner",
    "local-unset",
    "new-name",
    "export-unset",
    "multiple",
    "return",
  ],
  funcnest: ["positive", "zero", "negative", "invalid", "plus", "leading-zero", "space"],
  command: [
    "bypass-builtin",
    "bypass-function",
    "builtin-v",
    "builtin-V",
    "function-v",
    "function-V",
    "multiple-v",
    "multiple-V",
    "unknown-v",
    "unknown-V",
    "unknown-execute",
    "missing-path-v",
    "missing-path-V",
    "no-args",
    "no-args-v",
    "no-args-V",
    "double-dash",
    "default-path",
    "invalid-option",
    "combined-options",
    "keyword-v",
    "keyword-V",
    "nested-command",
  ],
};
export const families = Object.keys(variants);
// Deliberately narrowed after the initial 292-case observations: declaration
// listing/formatting, local -I, integer attributes and += belong to plan unit 6.
// Removed local/integer, local/inherit and prefix/integer. Replaced declare -p
// and bare-local listing in local/{redeclaration,assignment-status,export} and
// prefix/{export,readonly-inner,export-unset} with printf-based value, restoration
// and readonly/export consequences. The original observations remain unit-6
// evidence, not silently exempted failures. Every active case gates strictly.
export const generatedValues = Array.from(
  { length: 256 },
  (_, n) => `v${n} ${n % 2 ? "*?[x]" : "'\"$\\"}${n % 3 ? "" : "\nnext"}`,
);
// Generated values feed actual local/state/argument/prefix semantics. Error-only
// variants are fixed controls, not padded with inert randomized annotations.
export const generatedVariants = [
  ["local", "dynamic"],
  ["local", "shadow"],
  ["local", "unset"],
  ["local", "uninitialized"],
  ["local", "multiple"],
  ["local", "redeclaration"],
  ["local", "unset-bare"],
  ["local", "unset-redeclare"],
  ["local", "nested-unset"],
  ["state", "ordinary"],
  ["state", "subshell"],
  ["state", "async"],
  ["state", "pipeline-left"],
  ["state", "pipeline-right"],
  ["state", "lastpipe"],
  ["arguments", "quoted-at"],
  ["arguments", "quoted-star"],
  ["arguments", "unquoted-at"],
  ["arguments", "unquoted-star"],
  ["arguments", "nested"],
  ["arguments", "recursive"],
  ["positionals", "set"],
  ["positionals", "clear"],
  ["positionals", "shift"],
  ["prefix", "restore"],
  ["prefix", "unset"],
  ["prefix", "local"],
  ["prefix", "nested"],
  ["prefix", "argument-expansion"],
  ["prefix", "export"],
  ["prefix", "new-name"],
  ["prefix", "export-unset"],
  ["prefix", "local-unset"],
  ["command", "bypass-builtin"],
  ["command", "bypass-function"],
  ["command", "double-dash"],
  ["command", "nested-command"],
];
export const valueVariants = new Set(
  generatedVariants
    .map(([family, variant]) => family + "/" + variant)
    .concat(
      [
        "local/assignment-status",
        "local/readonly",
        "local/export",
        "arguments/zero",
        "positionals/shift-zero",
        "positionals/shift-overflow",
        "positionals/shift-negative",
        "positionals/shift-invalid",
        "positionals/shift-arithmetic",
        "return/implicit",
        "return/nested",
      ],
      ["prefix/multiple", "prefix/return"],
    ),
);
export const maxGeneratedCount = generatedVariants.length * generatedValues.length;
export const environment = {
  locale: "C",
  path: "/usr/bin:/bin",
  stdin: "empty",
  shellArgs: ["-c", "SCRIPT"],
  jobControl: "off",
  scope:
    "builtin-only scalar functions/locals/positionals/return/shift/set--/command; no arrays, traps or job selectors; external path execution/resolution requires ProcessHost controls",
  isolation:
    "fresh cwd and environment per observation; async outputs sequenced by wait; lastpipe explicitly enabled only in its control",
  shellZero: "$0 compared with saved entry value, never compared across executable paths",
  comparison: "stdout bytes and exit status; stderr retained as diagnostics, not compared",
};
const root = resolve(import.meta.dirname, "..");
const sourcePath = fileURLToPath(import.meta.url);
const bashBin = "/usr/bin/bash";
const oracleVersion = /^GNU bash, version 5\.3\.15(?:\(|\s)/;
const queue = "/work/platform-production/heavy/current/run.js";
export const sourceFiles = [
  "fuzz-shell-functions.ts",
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
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const observe = 'fn_status=$?; printf "status=%s\\n" "$fn_status"; exit "$fn_status"';
const print = (label: string, variable = "x") => `printf '${label}=<%s>\\n' "$${variable}"`;
const status = (label: string) => `printf '${label}=%s\\n' "$?"`;
const args = (label: string) =>
  `printf '${label}-count=%s\\n' "$#"; printf '${label}-arg=<%s>\\n' "$@"`;
type Spec = { family: string; variant: string; value: string };
export function render(spec: Spec) {
  if (
    !families.includes(spec.family) ||
    !variants[spec.family]?.includes(spec.variant) ||
    typeof spec.value !== "string"
  )
    throw new Error("invalid functions specification");
  let body: string;
  switch (spec.family + "/" + spec.variant) {
    case "local/dynamic":
      body = `g() { ${print("g")}; x=changed; }; f() { local x="$fn_value"; g; ${print("f")}; }; f; ${print("outer")}`;
      break;
    case "local/shadow":
      body = `g() { local x=inner; ${print("g")}; }; f() { local x="$fn_value"; g; ${print("f")}; }; f; ${print("outer")}`;
      break;
    case "local/unset":
      body = `g() { ${print("before-unset")}; unset x; printf 'g-set=<%s>\\n' "\${x-unset}"; }; f() { local x="$fn_value"; g; printf 'f-set=<%s>\\n' "\${x-unset}"; x=again; }; f; ${print("outer")}`;
      break;
    case "local/unset-bare":
      body = `f() { local x; printf 'bare=<%s>\\n' "\${x-unset}"; unset x; ${print("exposed")}; local x="$fn_value"; ${print("redeclared")}; }; f; ${print("outer")}`;
      break;
    case "local/unset-redeclare":
      body = `f() { local x="$fn_value"; ${print("before")}; unset x; local x; printf 'redeclared=<%s>\\n' "\${x-unset}"; x=again; }; f; ${print("outer")}`;
      break;
    case "local/nested-unset":
      body = `h() { unset x; ${print("once")}; unset x; printf 'twice=<%s>\\n' "\${x-unset}"; }; g() { local x=inner; h; printf 'g=<%s>\\n' "\${x-unset}"; }; f() { local x="$fn_value"; ${print("before")}; g; printf 'f=<%s>\\n' "\${x-unset}"; }; f; printf 'outer=<%s>\\n' "\${x-unset}"`;
      break;
    case "local/uninitialized":
      body = `f() { local x; printf 'initial=<%s>\\n' "\${x-unset}"; x="$fn_value"; ${print("local")}; }; f; ${print("outer")}`;
      break;
    case "local/redeclaration":
      body = `f() { local x="$fn_value"; local x; ${print("redeclared")}; }; f; ${print("outer")}`;
      break;
    case "local/multiple":
      body = `f() { local x="$fn_value" y="$x"; ${print("local")}; ${print("same-command", "y")}; }; f; ${print("outer")}`;
      break;
    case "local/assignment-status":
      body = `f() { false; local x="$fn_value"; ${status("local")}; ${print("local")}; }; f; ${print("outer")}`;
      break;
    case "local/readonly":
      body = `f() { local -r x="$fn_value"; ${print("readonly")}; g; }; g() { x=changed; printf 'unreachable\\n'; }; f; ${status("call")}; ${print("outer")}`;
      break;
    case "local/export":
      body = `f() { local -x x="$fn_value"; ${print("inside")}; }; f; ${print("outer")}`;
      break;
    case "local/invalid-name":
      body = `f() { local 'bad-name=1'; ${status("local")}; printf 'continued\\n'; }; f`;
      break;
    case "state/ordinary":
    case "state/subshell":
    case "state/async":
    case "state/pipeline-left":
    case "state/pipeline-right":
    case "state/lastpipe": {
      const call = `f() { x="$fn_value"; set -- child ""; ${print("inside")}; }; `;
      const invocation = {
        ordinary: "f",
        subshell: "( f )",
        async: 'f & fn_pid=$!; wait "$fn_pid"',
        "pipeline-left": "f | while IFS= read -r fn_line; do printf '%s\\n' \"$fn_line\"; done",
        "pipeline-right": "g | f",
        lastpipe: "shopt -s lastpipe; g | f",
      }[spec.variant];
      body = `set -- parent; g() { :; }; ${call}${invocation}; ${print("outer")}; ${args("outer")}`;
      // The left-stage control drains every line with builtin read, so its
      // values are observable without unread-pipe/EPIPE scheduling races.
      break;
    }
    case "arguments/quoted-at":
      body = `f() { ${args("f")}; }; f '' "$fn_value" '*'`;
      break;
    case "arguments/quoted-star":
      body = `f() { IFS=:; printf 'star=<%s>\\n' "$*"; printf 'at=<%s>\\n' "$@"; IFS=; printf 'empty-ifs=<%s>\\n' "$*"; }; f '' "$fn_value" '*'`;
      break;
    case "arguments/unquoted-at":
      body = `f() { printf 'split=<%s>\\n' $@; }; f '' "$fn_value" 'tail end'`;
      break;
    case "arguments/unquoted-star":
      body = `f() { IFS=:; printf 'split=<%s>\\n' $*; }; f '' "$fn_value" ':tail::end:'`;
      break;
    case "arguments/empty-at":
      body = `f() { ${args("f")}; printf 'embedded=<%s>\\n' pre"$@"post; }; f`;
      break;
    case "arguments/zero":
      body = `fn_zero=$0; f() { if test "$0" = "$fn_zero"; then printf 'zero=preserved\\n'; else printf 'zero=changed\\n'; fi; ${args("f")}; }; f "$fn_value"`;
      break;
    case "arguments/nested":
      body = `set -- root '' "$fn_value"; g() { ${args("g")}; set -- changed; shift; }; f() { ${args("f-before")}; g "$fn_value" ''; ${args("f-after")}; }; f '' "$fn_value" tail; ${args("root")}`;
      break;
    case "arguments/recursive":
      body = `f() { local n=$1; shift; ${args("level")}; if test "$n" -gt 0; then f "$((n-1))" '' "$fn_value"; fi; ${args("restored")}; }; f 3 "$fn_value" tail`;
      break;
    case "positionals/set":
      body = `set -- root "$fn_value"; f() { set -- "$fn_value" '' '*'; ${args("inner")}; }; f before; ${args("outer")}`;
      break;
    case "positionals/clear":
      body = `set -- root "$fn_value"; f() { set --; ${args("inner")}; }; f "$fn_value"; ${args("outer")}`;
      break;
    case "positionals/shift":
      body = `set -- root "$fn_value"; f() { shift; ${status("shift")}; ${args("inner")}; }; f discard '' "$fn_value"; ${args("outer")}`;
      break;
    case "positionals/shift-zero":
    case "positionals/shift-overflow":
    case "positionals/shift-negative":
    case "positionals/shift-invalid":
    case "positionals/shift-many":
    case "positionals/shift-empty":
    case "positionals/shift-arithmetic": {
      const operand = {
        "shift-zero": "0",
        "shift-overflow": "4",
        "shift-negative": "-1",
        "shift-invalid": "bad",
        "shift-many": "1 2",
        "shift-empty": "",
        "shift-arithmetic": "1+1",
      }[spec.variant];
      body = `f() { shift ${operand}; ${status("shift")}; ${args("remaining")}; }; f ${spec.variant === "shift-empty" ? "" : "'' \"$fn_value\" tail"}`;
      break;
    }
    case "return/implicit":
      body = `f() { printf 'value=<%s>\\n' "$fn_value"; false; }; f`;
      break;
    case "return/last-status":
      body = `f() { false; return; printf 'unreachable\\n'; }; f`;
      break;
    case "return/explicit":
      body = `f() { return 7; printf 'unreachable\\n'; }; f`;
      break;
    case "return/negative":
      body = `f() { return -1; printf 'unreachable\\n'; }; f`;
      break;
    case "return/wrapped":
      body = `f() { return 258; printf 'unreachable\\n'; }; f`;
      break;
    case "return/plus":
      body = `f() { return +256; printf 'unreachable\\n'; }; f`;
      break;
    case "return/large":
      body = `f() { return 9223372036854775807; printf 'unreachable\\n'; }; f`;
      break;
    case "return/overflow":
      body = `f() { return 9223372036854775808; printf 'unreachable\\n'; }; f; ${status("call")}; printf 'continued\\n'`;
      break;
    case "return/invalid":
      body = `f() { return bad; printf 'unreachable\\n'; }; f; ${status("call")}; printf 'continued\\n'`;
      break;
    case "return/many":
      body = `f() { return 7 8; ${status("many")}; printf 'continued-function\\n'; }; f`;
      break;
    case "return/outside":
      body = `return 7; ${status("outside")}; printf 'continued\\n'`;
      break;
    case "return/outside-invalid":
      body = `return bad; ${status("outside")}; printf 'continued\\n'`;
      break;
    case "return/nested":
      body = `g() { return 9; }; f() { local x="$fn_value"; g; ${status("g")}; ${print("restored")}; return 7; }; f; ${status("f")}; ${print("outer")}`;
      break;
    case "return/loop":
      body = `f() { for x in one two; do return 7; done; printf 'unreachable\\n'; }; f`;
      break;
    case "return/subshell":
      body = `f() { (return 7; printf 'unreachable\\n'); ${status("subshell")}; printf 'function-continued\\n'; }; f`;
      break;
    case "return/async":
      body = `f() { return 7 & fn_pid=$!; wait "$fn_pid"; ${status("async")}; printf 'function-continued\\n'; }; f`;
      break;
    case "return/pipeline":
      body = `f() { : | return 7; ${status("pipeline")}; printf 'function-continued\\n'; }; f`;
      break;
    case "return/readonly-local":
      body = `readonly x=locked; f() { local x="$fn_value"; ${status("local")}; return; }; f`;
      break;
    case "prefix/restore":
      body = `f() { ${print("inside")}; x=written; y="$fn_value"; }; x="$fn_value" f; ${print("outer")}; ${print("shared", "y")}`;
      break;
    case "prefix/unset":
      body = `f() { ${print("inside")}; unset x; printf 'unset=<%s>\\n' "\${x-unset}"; }; x="$fn_value" f; ${print("outer")}`;
      break;
    case "prefix/local":
      body = `f() { ${print("prefix")}; local x=local; ${print("inside")}; }; x="$fn_value" f; ${print("outer")}`;
      break;
    case "prefix/nested":
      body = `g() { ${print("g")}; x=written; }; f() { x=inner g; ${print("f")}; }; x="$fn_value" f; ${print("outer")}`;
      break;
    case "prefix/argument-expansion":
      body = `f() { ${print("inside")}; ${args("f")}; }; x="$fn_value" f "$x"; ${print("outer")}`;
      break;
    case "prefix/export":
      body = `f() { ${print("prefix")}; export x; x=written; ${print("inside")}; }; x="$fn_value" f; ${print("outer")}`;
      break;
    case "prefix/readonly":
      body = `readonly x=locked; f() { printf 'called\\n'; }; x="$fn_value" f; ${status("prefix")}; ${print("outer")}`;
      break;
    case "prefix/readonly-inner":
      body = `f() { readonly x; ${print("inside")}; }; x=temporary f; ${print("restored")}; x=changed; ${print("mutable")}`;
      break;
    case "prefix/local-unset":
      body = `f() { local x=local; unset x; ${print("exposed")}; x=written; }; x="$fn_value" f; ${print("outer")}`;
      break;
    case "prefix/new-name":
      body = `unset x; f() { ${print("inside")}; x=written; }; x="$fn_value" f; printf 'outer=<%s>\\n' "\${x-unset}"`;
      break;
    case "prefix/export-unset":
      body = `unset x; f() { ${print("prefix")}; export x; x=written; ${print("inside")}; }; x="$fn_value" f; printf 'outer=<%s>\\n' "\${x-unset}"`;
      break;
    case "prefix/multiple":
      body = `f() { ${print("inside-x")}; ${print("inside-y", "y")}; ${args("f")}; }; x="$fn_value" y="$x" f "$x:$y"; ${print("outer-x")}; ${print("outer-y", "y")}`;
      break;
    case "prefix/return":
      body = `f() { ${print("inside")}; return 7; }; x="$fn_value" f; ${status("call")}; ${print("outer")}`;
      break;
    case "funcnest/positive":
    case "funcnest/zero":
    case "funcnest/negative":
    case "funcnest/invalid":
    case "funcnest/plus":
    case "funcnest/leading-zero":
    case "funcnest/space": {
      const limit = {
        positive: "2",
        zero: "0",
        negative: "-1",
        invalid: "bad",
        plus: "+2",
        "leading-zero": "02",
        space: " 2 ",
      }[spec.variant];
      if (limit === undefined) throw new Error("invalid funcnest specification");
      body = `FUNCNEST=${quote(limit)}; f() { printf 'enter=%s\\n' "$1"; if test "$1" -gt 0; then f "$(($1-1))"; fi; printf 'leave=%s\\n' "$1"; }; f 3; ${status("call")}; f 0; ${status("recovered")}`;
      break;
    }
    case "command/bypass-builtin":
      body = `echo() { printf 'function=<%s>\\n' "$1"; }; echo "$fn_value"; command echo "$fn_value"`;
      break;
    case "command/bypass-function":
      body = `fn_missing_executable() { printf 'function=<%s>\\n' "$fn_value"; }; fn_missing_executable; command fn_missing_executable; ${status("bypass")}`;
      break;
    case "command/builtin-v":
      body = `command -v printf local return shift set command; ${status("query")}`;
      break;
    case "command/builtin-V":
      body = `command -V printf local return shift set command; ${status("query")}`;
      break;
    case "command/function-v":
      body = `f() { :; }; command -v f; ${status("query")}`;
      break;
    case "command/function-V":
      body = `f() { :; }; command -V f; ${status("query")}`;
      break;
    case "command/multiple-v":
      body = `f() { :; }; command -v f printf fn_missing_executable; ${status("query")}`;
      break;
    case "command/multiple-V":
      body = `f() { :; }; command -V printf f fn_missing_executable; ${status("query")}`;
      break;
    case "command/unknown-v":
      body = `command -v fn_missing_executable; ${status("query")}`;
      break;
    case "command/unknown-V":
      body = `command -V fn_missing_executable; ${status("query")}`;
      break;
    case "command/unknown-execute":
      body = `command fn_missing_executable; ${status("unknown")}`;
      break;
    case "command/missing-path-v":
      body = `command -v /fn_missing_directory/fn_missing_executable; ${status("query")}`;
      break;
    case "command/missing-path-V":
      body = `command -V ./fn_missing_executable; ${status("query")}`;
      break;
    case "command/no-args":
      body = `command; ${status("empty")}`;
      break;
    case "command/no-args-v":
      body = `command -v; ${status("empty")}`;
      break;
    case "command/no-args-V":
      body = `command -V; ${status("empty")}`;
      break;
    case "command/double-dash":
      body = `command -- printf 'builtin=<%s>\\n' "$fn_value"`;
      break;
    case "command/default-path":
      body = `PATH=/fn_missing_directory; command -p printf 'builtin\\n'; command -pv printf; ${status("query")}`;
      break;
    case "command/invalid-option":
      body = `command -x printf; ${status("option")}`;
      break;
    case "command/combined-options":
      body = `f() { :; }; command -vV f printf; ${status("query")}`;
      break;
    case "command/keyword-v":
      body = `command -v if for while; ${status("query")}`;
      break;
    case "command/keyword-V":
      body = `command -V if for while; ${status("query")}`;
      break;
    case "command/nested-command":
      body = `echo() { printf 'wrong-function\\n'; }; command command echo "$fn_value"`;
      break;
    default:
      throw new Error("missing functions variant");
  }
  return `fn_value=${quote(spec.value)}; x=outer; y=outer-y\n${body}\n${observe}\n`;
}
function makeCase(id: string, spec: Spec) {
  return {
    id,
    ...spec,
    tags: [spec.family, "variant=" + spec.variant, "scalar-only"],
    script: render(spec),
  };
}
export function matrixCases() {
  const result = [];
  for (const family of families)
    for (const variant of variants[family])
      for (const value of valueVariants.has(family + "/" + variant) ? values : [values[0]])
        result.push(makeCase("matrix-" + result.length, { family, variant, value }));
  return result;
}
export function generateCases(seed: number, count = defaultCount) {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)
    throw new Error("invalid uint32 seed");
  if (!Number.isSafeInteger(count) || count < 0 || count > maxGeneratedCount)
    throw new Error(`invalid count (0..${maxGeneratedCount})`);
  let state = seed >>> 0;
  const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
  const available = Array.from({ length: maxGeneratedCount }, (_, index) => index);
  const result = matrixCases();
  for (let index = 0; index < count; index++) {
    const selected = next() % available.length;
    const tuple = available[selected];
    available[selected] = available[available.length - 1];
    available.pop();
    const [family, variant] = generatedVariants[Math.floor(tuple / generatedValues.length)];
    result.push(
      makeCase("generated-" + index, {
        family,
        variant,
        value: generatedValues[tuple % generatedValues.length],
      }),
    );
  }
  return result;
}
export function coverage(cases: readonly Case[]) {
  const unique = (key: keyof Case) => Array.from(new Set(cases.map((item) => item[key]))).sort();
  return {
    families: unique("family"),
    variants: Array.from(new Set(cases.map((item) => item.family + "/" + item.variant))).sort(),
    values: unique("value"),
  };
}
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
    throw new Error("stale functions fixture hash/schema");
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
  const filenameSeed = /shell-functions-seed-(\d+)\.json$/.exec(path);
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
  const counts = { MATCH: 0, MISMATCH: 0 };
  const byFamily: Record<string, { MATCH: number; MISMATCH: number }> = {};
  const mismatches = [];
  const results = [];
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
  if (process.argv.includes("--queue-active") || !existsSync(queue)) return;
  const child = spawnSync(
    "bun",
    [
      queue,
      "--class",
      "light",
      "bash-web-functions-fuzz",
      "--",
      bashBin,
      "-c",
      'ulimit -c 0; exec "$@"',
      "functions-fuzz",
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
      "Usage: node scripts/fuzz-shell-functions.ts [--shell PATH] [--seed N] [--count 128]\n  --record-oracle PATH  Bash-only recording\n  --record PATH         Record only a strict candidate match\n  --replay PATH         Strict stdout/status replay; repeatable; never invokes Bash\n  --self-control        Independent Bash 5.3.15 observations\n  --output PATH         Bounded diagnostics\nBuiltin-only scalar functions/locals/arguments/return/shift/set--/command; no arrays, traps or job selectors; successful external path resolution/execution remains ProcessHost-owned.\nNo automatic build. Self-queues through wave-heavy --class light.",
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
  const parent = process.env.FUZZ_JOB_SCRATCH ?? process.env.RUNNER_TEMP ?? "/work/tmp";
  mkdirSync(parent, { recursive: true });
  const scratch = mkdtempSync(resolve(parent, "bash-web-functions-run-"));
  options.cwd = scratch;
  // Shared run() owns each process group through close and drain, with a finite
  // timeout. A signal stops new observations; await in-flight teardown before rm.
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
      const cases = generateCases(options.seed, options.count);
      const result = await execute(cases, options, shell);
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
