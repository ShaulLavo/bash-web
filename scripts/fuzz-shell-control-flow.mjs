#!/usr/bin/env node
import { encode, decode } from "./fuzz-shell-results.ts";
// Generator-first differential control-flow gate. Oracle-only recording deliberately
// does not depend on candidate support; replay is always strict, including UNSUPPORTED.
import { spawn } from "node:child_process";
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
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { drainGroup, killGroup } from "./shell-process-group.ts";

const root = resolve(import.meta.dirname, "..");
const sourcePath = fileURLToPath(import.meta.url);
const queue = "/work/tmp/wave-heavy/run.sh";
const bashBin = "/usr/bin/bash";
const oracleVersion = /^GNU bash, version 5\.3\.15(?:\(|\s)/;
export const defaultCount = 600;
export const defaultTimeoutMs = 2000;
export const outputLimit = 64 * 1024;
export const depths = [0, 1, 2, 3];
export const families = [
  "if",
  "while",
  "until",
  "for-list",
  "for-arithmetic",
  "case",
  "loop-control",
  "condition",
  "errexit",
  "syntax-failure",
  "runtime-failure",
  "redirection",
  "invalid-for",
  "conditional-newline",
  "inherit-errexit",
  "nullglob",
  "regex",
  "time-format",
  "option-control",
];
export const conditionKinds = [
  "true",
  "false",
  "test-n",
  "test-z",
  "test-string",
  "bracket-string",
  "test-integer",
  "double-pattern",
  "double-quoted-pattern",
  "double-and",
  "double-or",
  "double-not",
  "double-integer",
  "double-lexical",
  "arithmetic",
];
export const values = ["", "a", "a b", "*", "x[y]", "a;b", "0", "2", "a'\"$\\b", "line\nbreak"];
export const terminators = [";;", ";&", ";;&"];
export const errexitContexts = [
  "top",
  "if-test",
  "elif-test",
  "while-test",
  "until-test",
  "and-left",
  "and-right",
  "or-left",
  "or-right",
  "negated",
  "function",
  "function-if",
  "subshell",
  "group",
];
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
export const fingerprint = () =>
  createHash("sha256")
    .update(readFileSync(sourcePath))
    .update(readFileSync(new URL("./fuzz-shell-results.ts", import.meta.url)))
    .update(readFileSync(new URL("./shell-process-group.ts", import.meta.url)))
    .digest("hex");
const observe = 'cf_status=$?; printf "status=%s\\n" "$cf_status"; exit "$cf_status"';
const print = (label) => `printf '${label}=<%s>\\n' "$v"`;

function randomFor(seed) {
  let state = seed >>> 0;
  return {
    next() {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state;
    },
    pick(items) {
      return items[this.next() % items.length];
    },
  };
}

export function condition(kind) {
  switch (kind) {
    case "true":
      return "true";
    case "false":
      return "false";
    case "test-n":
      return 'test -n "$v"';
    case "test-z":
      return 'test -z "$v"';
    case "test-string":
      return "test \"$v\" = 'a b'";
    case "bracket-string":
      return "[ \"$v\" != '*' ]";
    case "test-integer":
      return 'test "$number" -lt 2';
    case "double-pattern":
      return "[[ $v == a* ]]";
    case "double-quoted-pattern":
      return '[[ $v == "a*" ]]';
    case "double-and":
      return '[[ -n $v && $v != "*" ]]';
    case "double-or":
      return "[[ -z $v || $v == a* ]]";
    case "double-not":
      return "[[ ! ( $v == a* ) ]]";
    case "double-integer":
      return "[[ number -ge 2 ]]";
    case "double-lexical":
      return "[[ $v < z ]]";
    case "arithmetic":
      return "(( number % 2 ))";
    default:
      throw new Error("unknown condition " + kind);
  }
}

function nest(body, depth) {
  for (let index = 0; index < depth; index++) {
    if (index % 3 === 0) body = `if true; then ${body}; fi`;
    else if (index % 3 === 1) body = `for cf_nest_${index} in 'one'; do ${body}; done`;
    else body = `{ ${body}; }`;
  }
  return body;
}

function errexitBody(spec) {
  const fail = spec.failure === "return7" ? "cf_fail" : "false";
  const inner = `${fail}; printf 'inner\\n'${spec.finalFailure ? "; " + fail : ""}`;
  const group = `{ ${inner}; }`;
  switch (spec.context) {
    case "top":
      return inner;
    case "if-test":
      return `if ${group}; then printf 'then\\n'; else printf 'else\\n'; fi`;
    case "elif-test":
      return `if false; then :; elif ${group}; then printf 'elif\\n'; else printf 'else\\n'; fi`;
    case "while-test":
      return `cf_n=0; while { cf_n=$((cf_n+1)); test "$cf_n" -lt 2 && ${group}; }; do printf 'body\\n'; done`;
    case "until-test":
      return `cf_n=0; until { cf_n=$((cf_n+1)); test "$cf_n" -ge 2 || { ${inner}; false; }; }; do printf 'body\\n'; done`;
    case "and-left":
      return `${group} && printf 'right\\n'`;
    case "and-right":
      return `true && ${group}`;
    case "or-left":
      return `${group} || printf 'right\\n'`;
    case "or-right":
      return `false || ${group}`;
    case "negated":
      return `! ${group}`;
    case "function":
      return `cf_f() { ${inner}; }; cf_f`;
    case "function-if":
      return `cf_f() { ${inner}; }; if cf_f; then printf 'then\\n'; else printf 'else\\n'; fi`;
    case "subshell":
      return `( ${inner} )`;
    case "group":
      return group;
    default:
      throw new Error("unknown errexit context " + spec.context);
  }
}

const syntaxFailures = [
  ["if-missing-then", "if true; printf bad; fi"],
  ["if-missing-fi", "if true; then printf bad"],
  ["if-empty-condition", "if ; then :; fi"],
  ["elif-after-else", "if false; then :; else :; elif true; then :; fi"],
  ["stray-then", "then"],
  ["stray-else", "else"],
  ["stray-fi", "fi"],
  ["while-missing-do", "while false; :; done"],
  ["until-missing-done", "until true; do :"],
  ["for-missing-name", "for in a; do :; done"],
  ["for-missing-in", "for x a; do :; done"],
  ["for-missing-done", "for x in a; do :"],
  ["for-arithmetic-missing-close", "for ((i=0;i<1;i++); do :; done"],
  ["case-missing-in", "case x x) :;; esac"],
  ["case-missing-esac", "case x in x) :;;"],
  ["case-missing-pattern-close", "case x in x :;; esac"],
  ["double-bracket-missing-close", "[[ a == a"],
  ["double-bracket-missing-rhs", "[[ a == ]]"],
  ["double-bracket-invalid-op", "[[ a -unknown b ]]"],
  ["stray-done", "done"],
  ["stray-esac", "esac"],
];
const runtimeFailures = [
  // Capture groups remain outside this gate; malformed regex status is observed.
  ["invalid-regex", "[[ x =~ [ ]]"],
  ["test-integer", "if test bad -eq 1; then printf bad; else printf 'else\\n'; fi"],
  ["bracket-close", "[ a"],
  ["test-arity", "test a b c"],
  [
    "missing-condition",
    "if cf_missing_control_command; then printf bad; else printf 'else\\n'; fi",
  ],
  ["missing-body", "if true; then cf_missing_control_command; fi"],
  ["for-status", "for x in a b; do false; done"],
  ["case-status", "case a in a) false;; esac"],
  ["while-status", 'n=0; while test "$n" -lt 1; do n=$((n+1)); false; done'],
  ["until-status", 'n=0; until test "$n" -ge 1; do n=$((n+1)); false; done'],
  ["return-status", "cf_f() { if true; then return 7; fi; printf bad; }; cf_f"],
  ["break-outside", "break; printf 'after-break\\n'"],
  ["continue-outside", "continue; printf 'after-continue\\n'"],
];

const descriptorControls = [
  [
    "exec-for-persists",
    "exec 3>&1; for x in once; do exec >saved; done; echo body; printf 'saved:' >&3; cat saved >&3",
  ],
  [
    "exec-if-persists",
    "exec 3>&1; if true; then exec >saved; fi; echo body; printf 'saved:' >&3; cat saved >&3",
  ],
  [
    "redirected-for-restores",
    "for x in once; do exec >saved; echo inner; done >outer; echo restored; cat saved",
  ],
];

// Original deterministic adapters for the frozen no-loss prerequisites. Origins
// identify cases in docs/evidence/own-shell-oracle.json, never a live upstream.
// Filesystem examples are relativized to the process-owned sandbox, not /tmp.
export const prerequisiteControls = (() => {
  const controls = [];
  const add = (name, family, script, status, stdout = "", origins = []) => {
    const control = { name, family, script, expected: { status, stdout }, origins };
    controls.push(control);
    return control;
  };
  for (const name of ["i.j", "1item", "item-name"])
    add(
      "invalid-for-" + name,
      "invalid-for",
      `for ${name} in a b c; do printf 'bad\\n'; done; printf 'done\\n'`,
      0,
      "done\n",
      name === "i.j" ? ["oils:parse-errors:93"] : [],
    );

  const newlines = [
    ["after-open", "[[\na == a ]]", 0],
    ["after-and", "[[ a &&\nb ]]", 0],
    ["after-or", "[[ '' ||\nb ]]", 0],
    ["after-group-open", "[[ (\na == a ) ]]", 0],
    ["after-comparison", "[[ a == a\n]]", 0],
    ["after-unary-expression", "[[ -n a\n]]", 0],
    ["bare-before-close", "[[ a\n]] && echo should-not-print", 2, "brush-suite:extended_tests:66"],
    [
      "bare-before-group-close",
      "[[ ( a\n) ]] && echo should-not-print",
      2,
      "brush-suite:extended_tests:67",
    ],
    [
      "bare-before-and",
      "[[ a\n&& b ]] && echo should-not-print",
      2,
      "brush-suite:extended_tests:68",
    ],
    [
      "negated-bare-before-group-close",
      "[[ ( ! a\n) ]] && echo should-not-print",
      2,
      "brush-suite:extended_tests:69",
    ],
    ["before-binary-operator", "[[ a\n== a ]]", 2],
  ];
  for (const [name, script, status, origin] of newlines)
    add("newline-" + name, "conditional-newline", script, status, "", origin ? [origin] : []);

  const inherited = [
    [
      "frozen-inherit-off",
      'set -e\nshopt -u inherit_errexit\nresult=$(false; echo "still running")\necho "result: $result"\necho "after"',
      0,
      "result: still running\nafter\n",
      "brush-suite:options/inherit-errexit:2",
    ],
    [
      "frozen-inherit-nested-on",
      'set -e\nshopt -s inherit_errexit\nresult=$(echo "outer: $(false; echo inner)")\necho "should not print"',
      0,
      "should not print\n",
      "brush-suite:options/inherit-errexit:4",
    ],
    [
      "frozen-inherit-nested-off",
      'set -e\nshopt -u inherit_errexit\nresult=$(echo "outer: $(false; echo inner)")\necho "result: $result"\necho "after"',
      0,
      "result: outer: inner\nafter\n",
      "brush-suite:options/inherit-errexit:5",
    ],
    [
      "frozen-inherit-local",
      'set -e\nshopt -s inherit_errexit\nmyfunc() { local result=$(false; echo "should not print"); echo "after local"; }\nmyfunc\necho "should not print"',
      0,
      "after local\nshould not print\n",
      "brush-suite:options/inherit-errexit:8",
    ],
    [
      "frozen-inherit-multiple",
      'set -e\nshopt -u inherit_errexit\nresult=$(echo "start"; false; echo "after false")\necho "result: $result"\necho "after"',
      0,
      "result: start\nafter false\nafter\n",
      "brush-suite:options/inherit-errexit:10",
    ],
  ];
  for (const [name, script, status, stdout, origin] of inherited)
    add(name, "inherit-errexit", script, status, stdout, [origin]);
  for (const setting of ["default", "off", "on"]) {
    const enabled = setting === "on";
    const prefix =
      "set -e; " + (setting === "default" ? "" : `shopt -${enabled ? "s" : "u"} inherit_errexit; `);
    const captured = enabled ? "" : "captured";
    const observeResult = "printf 'result=<%s>\\n' \"$result\"; printf 'done\\n'";
    add(
      "inherit-" + setting + "-assignment",
      "inherit-errexit",
      prefix + "result=$(false; printf captured); " + observeResult,
      enabled ? 1 : 0,
      enabled ? "" : "result=<captured>\ndone\n",
    );
    add(
      "inherit-" + setting + "-backtick",
      "inherit-errexit",
      prefix + "result=`false; printf captured`; " + observeResult,
      enabled ? 1 : 0,
      enabled ? "" : "result=<captured>\ndone\n",
    );
    add(
      "inherit-" + setting + "-nested-echo",
      "inherit-errexit",
      prefix + "result=$(printf 'outer:%s' \"$(false; printf captured)\"); " + observeResult,
      0,
      `result=<outer:${captured}>\ndone\n`,
    );
    add(
      "inherit-" + setting + "-nested-assignment",
      "inherit-errexit",
      prefix +
        "result=$(inner=$(false; printf captured); printf 'outer:%s' \"$inner\"); " +
        observeResult,
      enabled ? 1 : 0,
      enabled ? "" : "result=<outer:captured>\ndone\n",
    );
    add(
      "inherit-" + setting + "-local-declaration",
      "inherit-errexit",
      prefix +
        "cf_local() { local result=$(false; printf captured); printf 'local=<%s>\\n' \"$result\"; }; cf_local; printf 'done\\n'",
      0,
      `local=<${captured}>\ndone\n`,
    );
    add(
      "inherit-" + setting + "-local-assignment",
      "inherit-errexit",
      prefix +
        "cf_local() { local result; result=$(false; printf captured); printf 'local=<%s>\\n' \"$result\"; }; cf_local; printf 'done\\n'",
      enabled ? 1 : 0,
      enabled ? "" : "local=<captured>\ndone\n",
    );
    add(
      "inherit-" + setting + "-multiple",
      "inherit-errexit",
      prefix + "result=$(printf before; false; printf after); " + observeResult,
      enabled ? 1 : 0,
      enabled ? "" : "result=<beforeafter>\ndone\n",
    );
  }
  add(
    "inherit-child-off-no-leak",
    "inherit-errexit",
    "set -e; shopt -s inherit_errexit; result=$(shopt -u inherit_errexit; printf child); printf 'child=%s\\n' \"$result\"; result=$(false; printf leaked); printf bad",
    1,
    "child=child\n",
  );
  add(
    "inherit-child-on-no-leak",
    "inherit-errexit",
    "set -e; shopt -u inherit_errexit; result=$(shopt -s inherit_errexit; printf child); result=$(false; printf parent); printf 'parent=%s\\n' \"$result\"",
    0,
    "parent=parent\n",
  );

  for (const enabled of [false, true]) {
    const mode = enabled ? "on" : "off";
    const prefix = `shopt -${enabled ? "s" : "u"} nullglob; `;
    const loop = (words) => `for f in ${words}; do printf '<%s>\\n' "$f"; done; printf 'done\\n'`;
    add(
      "nullglob-" + mode + "-unmatched",
      "nullglob",
      prefix + loop("*.nonexistent"),
      0,
      enabled ? "done\n" : "<*.nonexistent>\ndone\n",
      enabled ? ["brush-suite:options/shopt-nullglob:12", "bashkit-suite:glob-options:64"] : [],
    );
    add(
      "nullglob-" + mode + "-missing-directory",
      "nullglob",
      prefix + loop("missing-directory/*.txt"),
      0,
      enabled ? "done\n" : "<missing-directory/*.txt>\ndone\n",
      enabled ? ["bashkit-suite:variables:640"] : [],
    );
    add(
      "nullglob-" + mode + "-quoted-unmatched",
      "nullglob",
      prefix + loop("'*.nonexistent'"),
      0,
      "<*.nonexistent>\ndone\n",
    );
    add(
      "nullglob-" + mode + "-escaped-unmatched",
      "nullglob",
      prefix + loop("\\*.nonexistent"),
      0,
      "<*.nonexistent>\ndone\n",
    );
    const files = ": >a.txt; : >b.txt; : >'a b.txt'; : >.hidden.txt; : >skip.log; ";
    const matching = "<a b.txt>\n<a.txt>\n<b.txt>\ndone\n";
    add("nullglob-" + mode + "-matches", "nullglob", prefix + files + loop("*.txt"), 0, matching);
    add(
      "nullglob-" + mode + "-quoted-matches",
      "nullglob",
      prefix + files + loop("'*.txt'"),
      0,
      "<*.txt>\ndone\n",
    );
    add(
      "nullglob-" + mode + "-variable",
      "nullglob",
      prefix + files + "pattern='*.txt'; " + loop("$pattern"),
      0,
      matching,
    );
    add(
      "nullglob-" + mode + "-quoted-variable",
      "nullglob",
      prefix + files + "pattern='*.txt'; " + loop('"$pattern"'),
      0,
      "<*.txt>\ndone\n",
    );
    add(
      "nullglob-" + mode + "-partial-quote",
      "nullglob",
      prefix + files + loop('"a"*".txt"'),
      0,
      "<a b.txt>\n<a.txt>\ndone\n",
    );
    add(
      "nullglob-" + mode + "-question",
      "nullglob",
      prefix + files + loop("?.txt"),
      0,
      "<a.txt>\n<b.txt>\ndone\n",
    );
    add(
      "nullglob-" + mode + "-bracket",
      "nullglob",
      prefix + files + loop("[ab].txt"),
      0,
      "<a.txt>\n<b.txt>\ndone\n",
    );
  }

  const regex = (name, text, pattern, status, mode = "variable", rhs) => {
    const spelling =
      rhs ??
      (mode === "literal"
        ? quote(pattern)
        : mode === "quoted-variable"
          ? '"$regex_pattern"'
          : mode === "raw"
            ? pattern
            : "$regex_pattern");
    add(
      "regex-" + name,
      "regex",
      `regex_text=${quote(text)}; regex_pattern=${quote(pattern)}; [[ "$regex_text" =~ ${spelling} ]]`,
      status,
    );
  };
  regex("literal-search", "xabcx", "abc", 0);
  regex("literal-no-match", "ab", "abc", 1);
  regex("anchored", "abc", "^abc$", 0, "raw");
  regex("anchored-no-match", "xabc", "^abc$", 1, "raw");
  regex("dot", "abc", "^a.c$", 0);
  regex("dot-no-match", "ac", "^a.c$", 1);
  regex("escaped-dot", "a.c", "^a\\.c$", 0);
  regex("escaped-dot-no-match", "abc", "^a\\.c$", 1);
  regex("bracket", "abc", "^[a-c]+$", 0);
  regex("bracket-no-match", "abd", "^[a-c]+$", 1);
  regex("negated-bracket", "abc", "^[^0-9]+$", 0);
  regex("negated-bracket-no-match", "a1", "^[^0-9]+$", 1);
  for (const [name, yes, no] of [
    ["digit", "42", "ab"],
    ["alpha", "Az", "42"],
    ["alnum", "a2", "!"],
    ["space", " \t", "a"],
    ["lower", "az", "AZ"],
    ["upper", "AZ", "az"],
    ["xdigit", "aF09", "g"],
    ["punct", "!?", "a"],
    ["blank", " \t", "\n"],
  ]) {
    regex("class-" + name, yes, `^[[:${name}:]]+$`, 0);
    regex("class-" + name + "-no-match", no, `^[[:${name}:]]+$`, 1);
  }
  for (const [name, pattern, yes, no] of [
    ["plus", "^a+$", "aaa", ""],
    ["star", "^a*$", "", "b"],
    ["question", "^a?$", "a", "aa"],
    ["exact", "^a{2}$", "aa", "aaa"],
    ["open-repeat", "^a{2,}$", "aaa", "a"],
    ["bounded-repeat", "^a{2,3}$", "aaa", "aaaa"],
  ]) {
    regex("repeat-" + name, yes, pattern, 0);
    regex("repeat-" + name + "-no-match", no, pattern, 1);
  }
  regex("alternation", "dog", "^cat$|^dog$", 0);
  regex("alternation-no-match", "bird", "^cat$|^dog$", 1);
  regex("quoted-operators-literal", "^a+$", "^a+$", 0, "literal");
  regex("quoted-operators-no-match", "aaa", "^a+$", 1, "literal");
  regex("quoted-open-bracket", "[", "[", 0, "literal");
  regex("quoted-open-bracket-no-match", "x", "[", 1, "literal");
  regex("quoted-variable", "a+", "a+", 0, "quoted-variable");
  regex("quoted-variable-no-match", "aaa", "a+", 1, "quoted-variable");
  regex("partial-quote", "a.bbb", "", 0, "raw", '^"a."b+$');
  regex("partial-quote-no-match", "axbbb", "", 1, "raw", '^"a."b+$');
  regex("invalid-open-bracket", "x", "[", 2);
  regex("invalid-repetition", "x", "*a", 2);
  add(
    "epochrealtime-six-digits",
    "time-format",
    "for cf_time in 1 2 3 4 5; do [[ $EPOCHREALTIME =~ ^[0-9]+\\.[0-9]{6}$ ]] || exit 1; done; printf 'done\\n'",
    0,
    "done\n",
    ["brush-suite:well_known_vars:27"],
  );
  // The option must be accepted before the next read unit parses its case arm.
  add(
    "extglob-no-match",
    "option-control",
    "case xyz in a*(b)c) printf bad;; esac\nprintf 'after\\n'",
    0,
    "after\n",
    ["brush-suite:options/set-e:140"],
  ).prelude = "set -e\nshopt -s extglob\n";
  return controls;
})();

export function prerequisiteCases() {
  return prerequisiteControls.flatMap((control) =>
    depths.map((depth) =>
      makeCase(`control-${control.name}-depth-${depth}`, {
        family: control.family,
        control: control.name,
        depth,
        origins: control.origins,
      }),
    ),
  );
}

export function render(spec) {
  if (spec.control !== undefined) {
    const control = prerequisiteControls.find((control) => control.name === spec.control);
    if (!control || control.family !== spec.family)
      throw new Error("unknown prerequisite control " + spec.control);
    return (control.prelude ?? "") + nest(control.script, spec.depth) + "\n";
  }
  let body;
  const last = spec.fail ? "false" : "true";
  switch (spec.family) {
    case "if":
      body = `if ${condition(spec.condition)}; then ${print("then")}; ${last}; elif ${condition(spec.elif)}; then ${print("elif")}; ${last}; else ${print("else")}; ${last}; fi`;
      break;
    case "condition":
      body = condition(spec.condition);
      break;
    case "while":
    case "until": {
      const comparison = spec.family === "while" ? "-lt" : "-ge";
      body = `n=0; ${spec.family} test "$n" ${comparison} ${spec.limit}; do n=$((n+1)); printf 'loop=%s\\n' "$n"; ${last}; done`;
      break;
    }
    case "for-list":
      body = `for item in ${spec.empty ? "" : "'' 'a b' '*' \"$v\""}; do printf 'item=<%s>\\n' "$item"; ${last}; done`;
      break;
    case "for-arithmetic":
      body = spec.omitted
        ? `i=0; for ((; ;)); do printf 'i=%s\\n' "$i"; i=$((i+1)); if test "$i" -ge ${spec.limit || 1}; then break; fi; done`
        : `for ((i=0; i<${spec.limit}; i++)); do printf 'i=%s\\n' "$i"; ${last}; done`;
      break;
    case "case":
      body = `case "$v" in (a|"a b") printf 'first\\n'; ${last}${spec.terminator} (b) printf 'second\\n'; ${last}${spec.terminator} (a*) printf 'pattern\\n'; ${last}${spec.terminator} ("*") printf 'literal\\n'; ${last}${spec.terminator} (*) printf 'fallback\\n'; ${last};; esac`;
      break;
    case "loop-control": {
      body = `printf 'visit\\n'; ${spec.verb} ${spec.level}; printf 'after-control\\n'`;
      for (let index = 0; index < spec.loops; index++)
        body = `for cf_loop_${index} in a b; do ${body}; printf 'tail-${index}\\n'; done`;
      break;
    }
    case "errexit":
      body = errexitBody(spec);
      break;
    case "redirection":
      body = descriptorControls.find(([name]) => name === spec.failure)?.[1];
      break;
    case "syntax-failure":
      body = syntaxFailures.find(([name]) => name === spec.failure)?.[1];
      break;
    case "runtime-failure":
      body = runtimeFailures.find(([name]) => name === spec.failure)?.[1];
      break;
    default:
      throw new Error("unknown family " + spec.family);
  }
  if (body === undefined) throw new Error("unknown failure " + spec.failure);
  body = nest(body, spec.depth);
  const prefix = spec.family === "errexit" ? "set -e; cf_fail() { return 7; }; " : "";
  return `v=${quote(spec.value ?? "a b")}; number=${spec.number ?? 2}; ${prefix}${body}\n${observe}\n`;
}

function makeCase(id, spec) {
  const tags = [spec.family, "depth-" + spec.depth];
  for (const key of [
    "condition",
    "elif",
    "terminator",
    "verb",
    "level",
    "context",
    "failure",
    "control",
  ])
    if (spec[key] !== undefined) tags.push(key + "=" + spec[key]);
  if (spec.value !== undefined) tags.push("value=" + spec.value);
  if (spec.limit !== undefined) tags.push("iterations=" + spec.limit);
  if (spec.loops !== undefined) tags.push("loops=" + spec.loops);
  if (spec.fail || spec.finalFailure) tags.push("last-failure");
  if (spec.empty) tags.push("empty-list");
  if (spec.omitted) tags.push("omitted-for-expressions");
  if (spec.origins) for (const origin of spec.origins) tags.push("frozen=" + origin);
  return { id, ...spec, tags, script: render(spec) };
}

export function matrixCases() {
  const result = [];
  const add = (spec) => result.push(makeCase("matrix-" + result.length, spec));
  const addDepth = (depth) => {
    for (const kind of conditionKinds) {
      for (const [index, value] of values.entries())
        add({ family: "condition", depth, condition: kind, value, number: index % 4 });
      for (const fail of [false, true])
        add({
          family: "if",
          depth,
          condition: kind,
          elif: fail ? "true" : "false",
          value: "a b",
          fail,
        });
    }
    for (const family of ["while", "until", "for-arithmetic"])
      for (const limit of [0, 1, 3])
        for (const fail of [false, true]) add({ family, depth, limit, fail });
    for (const empty of [false, true]) add({ family: "for-list", depth, empty, value: "a b" });
    add({ family: "for-arithmetic", depth, limit: 2, omitted: true });
    for (const terminator of terminators)
      for (const value of ["a", "b", "a b", "*", "", "z"])
        for (const fail of [false, true]) add({ family: "case", depth, terminator, value, fail });
    for (const context of errexitContexts)
      for (const failure of ["false", "return7"])
        for (const finalFailure of [false, true])
          add({ family: "errexit", depth, context, failure, finalFailure });
    for (const [failure] of descriptorControls) add({ family: "redirection", depth, failure });
    for (const [failure] of syntaxFailures) add({ family: "syntax-failure", depth, failure });
    for (const [failure] of runtimeFailures) add({ family: "runtime-failure", depth, failure });
  };
  depths.forEach(addDepth);
  for (const verb of ["break", "continue"])
    for (const loops of [1, 2, 3])
      for (const level of ["1", "2", "3", "4", "0", "-1", "bad", "1 2"])
        add({ family: "loop-control", depth: loops - 1, verb, loops, level });
  return result.concat(prerequisiteCases());
}

export function generateCases(seed, count = defaultCount) {
  const random = randomFor(seed);
  const result = matrixCases();
  for (let index = 0; index < count; index++) {
    const family = random.pick(families.slice(0, 9));
    const spec = {
      family,
      depth: random.pick(depths),
      value: random.pick(values),
      number: random.next() % 4,
    };
    if (family === "if" || family === "condition") {
      spec.condition = random.pick(conditionKinds);
      if (family === "if") spec.elif = random.pick(conditionKinds);
    }
    if (["while", "until", "for-arithmetic"].includes(family)) spec.limit = random.next() % 4;
    if (family === "for-list") spec.empty = random.next() % 4 === 0;
    if (family === "for-arithmetic") spec.omitted = random.next() % 4 === 0;
    if (family === "case") spec.terminator = random.pick(terminators);
    if (family === "loop-control") {
      spec.verb = random.pick(["break", "continue"]);
      spec.loops = 1 + (random.next() % 3);
      spec.level = random.pick(["1", "2", "3", "4"]);
    }
    if (family === "errexit") {
      spec.context = random.pick(errexitContexts);
      spec.failure = random.pick(["false", "return7"]);
      spec.finalFailure = Boolean(random.next() % 2);
    } else spec.fail = Boolean(random.next() % 2);
    result.push(makeCase("generated-" + index, spec));
  }
  return result;
}

export function coverage(cases) {
  const unique = (key) =>
    Array.from(
      new Set(cases.flatMap((item) => (item[key] === undefined ? [] : [item[key]]))),
    ).sort();
  return {
    families: unique("family"),
    depths: unique("depth"),
    conditions: unique("condition"),
    values: unique("value"),
    terminators: unique("terminator"),
    contexts: unique("context"),
    levels: unique("level"),
    tags: Array.from(new Set(cases.flatMap((item) => item.tags))).sort(),
  };
}

export function healthy(result) {
  return (
    Number.isInteger(result.status) &&
    result.status >= 0 &&
    result.status <= 255 &&
    result.signal === null &&
    result.timedOut === false &&
    result.error === null
  );
}
export function matches(bash, candidate) {
  return (
    healthy(bash) &&
    healthy(candidate) &&
    bash.status === candidate.status &&
    bash.stdout.equals(candidate.stdout)
  );
}
export function classify(bash, candidate, selfControl = false) {
  if (matches(bash, candidate)) return "MATCH";
  if (
    !selfControl &&
    healthy(bash) &&
    healthy(candidate) &&
    bash.status === 0 &&
    candidate.status === 2 &&
    candidate.stdout.length === 0 &&
    /^(?:shell-engine: )?unsupported (?:syntax\b|(?:compound command|conditional expression|control flow)\b|feature:\s*(?:compound command|conditional expression|control flow)\b)/im.test(
      candidate.stderr.toString(),
    )
  )
    return "UNSUPPORTED";
  return "MISMATCH";
}

// Finite builtin grammar, plus cat in descriptor controls. Own every process
// group and give each observation a fresh cwd: candidate output files must never
// be supplied by an earlier oracle/candidate process, even during shrinking.
const active = new Set();
/** @param {string} bin
 * @param {string} script
 * @param {import("./fuzz-shell-results.ts").RunOptions} options
 * @returns {Promise<import("./fuzz-shell-results.ts").ProcessResult>}
 */
export async function run(bin, script, options) {
  if (options.interrupted) throw new Error("interrupted");
  if (!options.cwd) throw new Error("process sandbox parent required");
  const sandbox = mkdtempSync(resolve(options.cwd, "process-"));
  const child = spawn(bin, ["-c", script], {
    cwd: sandbox,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: "/usr/bin:/bin", HOME: sandbox, TMPDIR: sandbox, LC_ALL: "C", LANG: "C" },
  });
  if (child.pid) active.add(child.pid);
  const chunks = { stdout: [], stderr: [] };
  let bytes = 0;
  let timedOut = false;
  let error = null;
  const stop = (reason) => {
    error ??= reason;
    killGroup(child.pid, "SIGKILL");
  };
  const timer = setTimeout(() => {
    timedOut = true;
    stop("ETIMEDOUT");
  }, options.timeoutMs);
  for (const name of ["stdout", "stderr"])
    child[name].on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > outputLimit) stop("ENOBUFS");
      else chunks[name].push(chunk);
    });
  try {
    const result = await new Promise((done) => {
      child.once("error", (failure) => {
        error ??= failure.code ?? "SPAWN_ERROR";
      });
      child.once("close", (status, signal) => done({ status, signal: signal ?? null }));
    });
    return {
      ...result,
      timedOut,
      error,
      stdout: Buffer.concat(chunks.stdout),
      stderr: Buffer.concat(chunks.stderr),
    };
  } finally {
    clearTimeout(timer);
    await drainGroup(child.pid);
    active.delete(child.pid);
    rmSync(sandbox, { recursive: true, force: true });
  }
}

/** @param {string[]} args */
export function optionsFor(args) {
  /** @type {{ seed: number, count: number, timeoutMs: number, replays: string[], selfControl?: boolean, help?: boolean, explicitSeed?: boolean, shell?: string, record?: string, recordOracle?: string, output?: string, cwd?: string, interrupted?: boolean }} */
  const options = { seed: 1, count: defaultCount, timeoutMs: defaultTimeoutMs, replays: [] };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--queue-active") continue;
    if (arg === "--self-control") {
      options.selfControl = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    const split = arg.indexOf("=");
    const name = split < 0 ? arg : arg.slice(0, split);
    const value = split < 0 ? args[++index] : arg.slice(split + 1);
    if (!value || value.startsWith("--")) throw new Error(name + " needs a value");
    if (name === "--seed") {
      options.seed = Number(value);
      options.explicitSeed = true;
    } else if (name === "--count") options.count = Number(value);
    else if (name === "--timeout-ms") options.timeoutMs = Number(value);
    else if (name === "--shell") options.shell = resolve(value);
    else if (name === "--record") options.record = resolve(value);
    else if (name === "--record-oracle") options.recordOracle = resolve(value);
    else if (name === "--output") options.output = resolve(value);
    else if (name === "--replay") options.replays.push(resolve(value));
    else throw new Error("unknown option " + name);
  }
  validateOptions(options);
  return options;
}

/** @param {import("./fuzz-shell-results.ts").FuzzOptions} options */
function validateOptions(options) {
  if (!Number.isInteger(options.seed) || options.seed < 0 || options.seed > 0xffffffff)
    throw new Error("invalid uint32 seed");
  if (!Number.isSafeInteger(options.count) || options.count < 0 || options.count > 10000)
    throw new Error("invalid count (0..10000)");
  if (
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 1 ||
    options.timeoutMs > 30000
  )
    throw new Error("invalid timeout (1..30000)");
  if (
    Number(Boolean(options.record)) +
      Number(Boolean(options.recordOracle)) +
      Number(Boolean(options.replays?.length)) +
      Number(Boolean(options.selfControl)) >
    1
  )
    throw new Error("record, record-oracle, replay and self-control are exclusive");
  if ((options.recordOracle || options.selfControl) && options.shell)
    throw new Error("oracle-only/self-control cannot select a shell");
}

export function validateFixture(path, fixture, options) {
  if (fixture.schema !== 1 || fixture.sourceHash !== fingerprint())
    throw new Error("stale control-flow fixture hash/schema");
  if (
    !oracleVersion.test(fixture.bash ?? "") ||
    fixture.oraclePath !== bashBin ||
    JSON.stringify(fixture.oracleArgs) !== JSON.stringify(["-c", "SCRIPT"])
  )
    throw new Error("fixture oracle differs");
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
  const filenameSeed = /shell-control-flow-seed-(\d+)\.json$/.exec(path);
  if (!filenameSeed || Number(filenameSeed[1]) !== fixture.seed)
    throw new Error("fixture filename seed differs");
  const cases = generateCases(fixture.seed, fixture.count);
  if (JSON.stringify(fixture.coverage) !== JSON.stringify(coverage(cases)))
    throw new Error("fixture coverage differs");
  if (!Array.isArray(fixture.cases) || fixture.cases.length !== cases.length)
    throw new Error("fixture length differs");
  for (const [index, test] of cases.entries()) {
    const entry = fixture.cases[index];
    if (JSON.stringify(entry?.case) !== JSON.stringify(test))
      throw new Error("fixture case differs at " + index);
    if (!entry?.bash || !healthy(entry.bash))
      throw new Error("invalid fixture process result at " + index);
    let bytes = 0;
    for (const key of ["stdoutBase64", "stderrBase64"]) {
      const value = entry.bash[key];
      if (typeof value !== "string" || Buffer.from(value, "base64").toString("base64") !== value)
        throw new Error("invalid fixture bytes at " + index);
      bytes += Buffer.from(value, "base64").length;
    }
    if (bytes > outputLimit) throw new Error("fixture output limit exceeded at " + index);
  }
  return cases;
}

export function reductions(test) {
  const { id, tags: _tags, script, ...spec } = test;
  const result = [];
  if (spec.depth > 0) result.push(makeCase(id, { ...spec, depth: spec.depth - 1 }));
  if (spec.limit > 1) result.push(makeCase(id, { ...spec, limit: 1 }));
  if (spec.loops > 1) result.push(makeCase(id, { ...spec, loops: spec.loops - 1 }));
  if (spec.value?.length) result.push(makeCase(id, { ...spec, value: "" }));
  return result.filter((item) => item.script.length < script.length);
}
const signature = (bash, candidate) =>
  JSON.stringify([
    bash.status,
    candidate.status,
    bash.signal,
    candidate.signal,
    bash.timedOut,
    candidate.timedOut,
    bash.error,
    candidate.error,
  ]);
async function shrink(test, bash, candidate, options, shell) {
  const originalSignature = signature(bash, candidate);
  let best = { test, bash, candidate };
  let attempts = 0;
  for (;;) {
    let improved = false;
    for (const reduced of reductions(best.test)) {
      if (++attempts > 12) return { ...best, attempts: 12 };
      const oracle = await run(bashBin, reduced.script, options);
      const ours = await run(shell, reduced.script, options);
      if (
        classify(oracle, ours, options.selfControl) === "MISMATCH" &&
        signature(oracle, ours) === originalSignature
      ) {
        best = { test: reduced, bash: oracle, candidate: ours };
        improved = true;
        break;
      }
    }
    if (!improved) return { ...best, attempts };
  }
}

async function execute(cases, options, shell, recorded) {
  const counts = { MATCH: 0, UNSUPPORTED: 0, MISMATCH: 0 };
  const byFamily = {};
  const mismatches = [];
  const results = [];
  for (const [index, test] of cases.entries()) {
    if (options.interrupted) throw new Error("interrupted");
    const bash = recorded ? decode(recorded[index].bash) : await run(bashBin, test.script, options);
    if (options.interrupted) throw new Error("interrupted");
    if (options.record || options.recordOracle) {
      if (!healthy(bash))
        throw new Error(
          "unrecordable oracle process failure: " + test.id + " " + JSON.stringify(encode(bash)),
        );
      results.push({ case: test, bash: encode(bash) });
    }
    if (options.recordOracle) continue;
    const candidate = await run(shell, test.script, options);
    const classification = classify(bash, candidate, options.selfControl);
    counts[classification]++;
    (byFamily[test.family] ??= { MATCH: 0, UNSUPPORTED: 0, MISMATCH: 0 })[classification]++;
    if (classification !== "MATCH" && mismatches.length < 32) {
      const minimized =
        classification === "MISMATCH" && !recorded && mismatches.length < 8
          ? await shrink(test, bash, candidate, options, shell)
          : null;
      mismatches.push({
        classification,
        case: test,
        bash: encode(bash),
        candidate: encode(candidate),
        minimized: minimized
          ? {
              case: minimized.test,
              bash: encode(minimized.bash),
              candidate: encode(minimized.candidate),
              attempts: minimized.attempts,
            }
          : null,
      });
    }
  }
  return { total: cases.length, counts, byFamily, coverage: coverage(cases), mismatches, results };
}

function ensureQueued() {
  if (process.argv.includes("--queue-active") || !existsSync(queue)) return;
  const child = spawnSync(
    "/usr/bin/bash",
    [
      queue,
      "--class",
      "light",
      "bash-web-control-flow-fuzz",
      "--",
      process.execPath,
      sourcePath,
    ].concat(process.argv.slice(2), ["--queue-active"]),
    { cwd: root, stdio: "inherit", env: process.env },
  );
  if (child.error) throw child.error;
  process.exit(child.status ?? 1);
}

function assertRunning(options) {
  if (options.interrupted) throw new Error("interrupted");
}

async function main() {
  const options = optionsFor(process.argv.slice(2));
  if (options.help) {
    console.log(
      "Usage: node scripts/fuzz-shell-control-flow.mjs [--shell PATH] [--seed N] [--count 600] [--timeout-ms 2000]\n  --record PATH        Record only after a strict candidate match\n  --record-oracle PATH Generator-first Bash-only capture; no candidate implied\n  --replay PATH        Strict fixture replay, repeatable; never invokes Bash\n  --self-control       Compare two independent Bash 5.3.15 processes\n  --output PATH        Save bounded mismatch diagnostics\n\nOracle: /usr/bin/bash 5.3.15 -c SCRIPT; no shell flags or inherited startup environment.\nFinite builtin-only grammar, private cwd, bounded output/time, process-group teardown.\nHost execution self-queues through wave-heavy --class light. No automatic build.",
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
    throw new Error("pass an existing native --shell PATH; never builds: " + shell);
  if (options.record && realpathSync(shell) === realpathSync(bashBin))
    throw new Error("cannot candidate-verify against Bash itself; use --record-oracle");
  const parent = process.env.FUZZ_CONTROL_SCRATCH ?? process.env.RUNNER_TEMP ?? "/work/tmp";
  mkdirSync(parent, { recursive: true });
  const scratch = mkdtempSync(resolve(parent, "bash-web-control-flow-run-"));
  options.cwd = scratch;
  // Register teardown before starting any child. Never remove another run's files.
  let interrupted = false;
  const onSignal = () => {
    interrupted = true;
    options.interrupted = true;
    for (const pid of active) killGroup(pid, "SIGKILL");
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    const reports = [];
    if (options.replays.length) {
      // Validate every fixture before starting any candidate process.
      const inputs = options.replays.map((path) => {
        const fixture = JSON.parse(readFileSync(path, "utf8"));
        return { path, fixture, cases: validateFixture(path, fixture, options) };
      });
      for (const { path, fixture, cases } of inputs) {
        assertRunning(options);
        reports.push({
          path,
          seed: fixture.seed,
          ...(await execute(cases, options, shell, fixture.cases)),
        });
      }
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
      if (recordPath && (result.counts.MISMATCH || result.counts.UNSUPPORTED))
        throw new Error("refusing candidate-verified recording with differences");
      if (recordPath) {
        const fixture = {
          schema: 1,
          sourceHash: fingerprint(),
          seed: options.seed,
          count: options.count,
          timeoutMs: options.timeoutMs,
          bash,
          oraclePath: bashBin,
          oracleArgs: ["-c", "SCRIPT"],
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
      mode: options.replays.length
        ? "replay"
        : options.recordOracle
          ? "oracle-only"
          : options.selfControl
            ? "bash-self-control"
            : "live",
      shell: options.recordOracle ? null : shell,
      timeoutMs: options.timeoutMs,
      reports: reports.map(({ results: _results, ...report }) => report),
    };
    const text = JSON.stringify(report, null, 2) + "\n";
    if (options.output) {
      mkdirSync(dirname(options.output), { recursive: true });
      writeFileSync(options.output, text);
    }
    process.stdout.write(text);
    if (interrupted) process.exitCode = 130;
    else if (
      reports.some(
        (report) => report.counts.MISMATCH || (options.replays.length && report.counts.UNSUPPORTED),
      )
    )
      process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    for (const pid of active) await drainGroup(pid);
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(error.stack ?? error);
    process.exitCode = 1;
  });
