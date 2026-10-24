# Shell word fuzzer

`npm run fuzz:shell-words` runs a deterministic differential fuzzer against GNU Bash
5.3.15 and the native `shell-engine` binary. Each generated template is run as a pair,
once at top level and once inside double quotes; `--count` is the total generated cases
(the fixed regressions are additional). It generates scalar parameter defaults,
assignments, alternatives, errors, indirection, length, trim, replacement, and case
operators at the top level and inside double quotes. Operands cover nested expansions,
quote boundaries, escaped and literal braces, raw `${`/`$(` text in single quotes,
slashes, patterns, spaces, empty text, and following words. Seven fixed regressions from
the parameter-boundary review are included in every run. Field capture uses a repeating
`printf '<%s>\\n'` format so every post-expansion field is observed without a helper.

The command builds the native binary through the shared heavy-job queue, using a temporary
`CARGO_TARGET_DIR`, unless `--shell PATH` (or `FUZZ_SHELL_BIN`) supplies an existing
binary. Build scratch is removed on exit. Useful options are:

```sh
npm run fuzz:shell-words -- --count 3000 --seed 42 --timeout-ms 2000 \
  --output fuzz-seed-42.json
npm run fuzz:shell-words -- --shell shell/target/debug/shell-engine \
  --count 3000 --seed 42
```

The summary and full JSON report are printed. `--output` writes the same report to a
persistent file. Each case is `MATCH`, `UNSUPPORTED` (a known unsupported feature exits
2 with a diagnostic while Bash succeeds), or `MISMATCH`; the command exits non-zero when
a mismatch is found. Reports include counts by class, operator and quote/operand feature,
plus minimized mismatches with Bash and shell stdout as both text and base64 bytes.

## Recorded CI gate

Bash 5.3.15 is not available on every CI runner, so the two checked-in fixtures under
`scripts/fixtures/` contain the Bash stdout/status oracle for 3,000 generated cases plus
fixed regressions at seeds 1 and 42. Recording rejects any Bash version other than 5.3.15
and requires a clean native run:

```sh
npm run fuzz:shell-words -- --count 3000 --seed 1 \
  --shell /path/to/release/shell-engine \
  --record scripts/fixtures/shell-words-seed-1.json
```

Replay never invokes Bash. It regenerates the cases and rejects a fixture whose source
hash, seed, count, operator list, quote pairing, case identity, or script differs from
this fuzzer, then compares native status and stdout bytes with the recorded oracle:

```sh
npm run fuzz:shell-words:ci -- --shell .build/shell/release/shell-engine
```

The CI replay is strict: it pins the fixture count to 3,000 generated cases and treats
both `UNSUPPORTED` and every status or byte difference as a failure, exiting non-zero.

## Readonly scalar gate

`npm run fuzz:shell-readonly` checks readonly declarations, rejected local and
arithmetic writes, nested local shadowing, and assignment expansion errors against
GNU Bash 5.3.15. It includes 256 deterministic generated cases and eleven fixed
regressions. Supply an existing native binary with `--shell PATH`.

Record the oracle with `--record scripts/fixtures/shell-readonly-seed-17.json`.
`npm run fuzz:shell-readonly:ci -- --shell PATH` replays status and stdout bytes
without invoking Bash. Replay verifies the generator hash, seed, count, timeout,
Bash version, and every regenerated script. Stderr is recorded for diagnosis.

## Whole-script parser compatibility

`node scripts/fuzz-shell-parse-boundaries.mjs --shell /path/to/shell-engine`
compares 27 generated empty-alias arithmetic scripts with GNU Bash 5.3.15.
Names, arithmetic assignments, whitespace, continuations and read-unit newlines vary.
The check compares stdout and status. Alias and shopt diagnostics remain outside the
engine's supported subset. `--record PATH` records Bash observations after a clean
comparison. CI uses `--replay scripts/fixtures/shell-parse-boundaries.json` without
invoking Bash and verifies the generator hash and every regenerated script.

## Brace lists and ranges

`npm run fuzz:shell-braces -- --shell PATH --seed 1` compares 5,318 cases with
GNU Bash 5.3.15: 3,000 original generated cases, 2,031 boundary cases and 287
fixed controls. Also run seed 42 and `--self-control` (two independent Bash
processes). The original bounded grammar covers lists, adjacent/nested products,
invalid enclosing groups, signed/padded numeric and ASCII-letter ranges,
escapes, quotes, empty fields, arithmetic order, variable-name boundaries, and a
source alternative above 4 KiB. Cartesian products are capped at 128 fields;
resource tests are separate.

The appended boundary grammar covers arithmetic/command-subshell ambiguity,
case patterns, subshells and comment parentheses, plus protected dollars before
parameter, command and arithmetic openers. Ambiguous forms vary one, two or three
closing parentheses, distinguishing incomplete raw arithmetic spans from later
command errors. Its full matrix crosses six contexts, nesting depths 0–3 and
both outer quoting modes. Inactive guards avoid requiring
unsupported command execution; syntax failures still count as observations.
Selected literal/arithmetic controls and structural shrinking retain the phase
distinctions. `--count` changes only the original generated stream, never the
boundary matrix or fixed controls.

The command never builds a binary and self-queues through the host's light
admission wrapper. Each invocation cleans its own scratch directory. Exact
stdout bytes and numeric status decide matches; signals, timeouts and spawn
errors cannot match. There are no unsupported exemptions.

`--record scripts/fixtures/shell-braces-seed-1.json` records only after every
candidate case matches. `npm run fuzz:shell-braces:ci -- --shell PATH` strictly
validates and replays seeds 1 and 42 without Bash.
`npm run test:fuzz-shell-braces` tests generation, matching and fixture rejection.

## Command and process substitution boundaries

`npm run fuzz:shell-substitutions -- --shell PATH --seed 1` compares a bounded,
seeded matrix with GNU Bash 5.3.15. The default run has 600 seeded cases, 16
fixed controls and 2,520 structured boundary cases. Seed 42 uses the same matrix
and a different deterministic stream. Run `--self-control` to compare two fresh
Bash processes. The generator covers plain and double quoted words, set and unset
`${v:-...}` operands, arithmetic, nested command substitutions and guarded
process substitutions. Openers include `$(`, `$( (`, `$((`, `<(`, `<((` and
backticks. Here-doc delimiters, case patterns, redirect and keyword end-of-input,
comments, continuations, open quotes, and valid and invalid closed bodies all
vary their one, two and three closing-parenthesis forms.

The oracle is `/usr/bin/bash -c SCRIPT`, so its status is the status of the
command string rather than file or stdin mode. Stdout bytes and status decide a
match; stderr is retained only for diagnosis. `UNSUPPORTED` is accepted only
when Bash succeeds and the candidate exits 2 with empty stdout because the
candidate cannot execute substitutions or compound commands yet. Parse
rejections and status 127 are mismatches. Structural shrinking keeps the opener,
context and process-failure signature. Mismatch shapes are written to
`brush-web-subst-mismatches.json` in the scratch parent below, or to
`FUZZ_SUBST_MISMATCHES` when set.

The fuzzer never builds. It self-queues through the host light queue and removes
its per-run directory (parent: `FUZZ_SUBST_SCRATCH`, else `RUNNER_TEMP`, else the
OS temporary directory). `--record` refuses a nonzero mismatch count. Replay
validates the generator hash, case order, coverage, seed, timeout, Bash version
and canonical bytes before running the candidate without Bash:

```sh
npm run fuzz:shell-substitutions -- --shell /path/to/shell-engine --seed 1
npm run fuzz:shell-substitutions -- --shell /path/to/shell-engine --seed 42
npm run fuzz:shell-substitutions:ci -- --shell /path/to/shell-engine
npm run test:fuzz-shell-substitutions
```

## Structured control flow and conditionals

`npm run fuzz:shell-control-flow -- --shell PATH --seed 1` compares 2,448
cases with GNU Bash 5.3.15: 1,848 structured controls and 600 seeded cases.
Seed 42 uses the same controls and a different deterministic stream. Coverage
includes if/elif/else, while/until, word and arithmetic for loops, multilevel
break/continue, case terminators, test/[ and structured [[ expressions, and
`set -e` suppression contexts. Nesting depths 0–3, quoted/empty/newline values,
descriptor persistence and syntax/runtime failures are included. Prerequisite
controls cover conditional newline grammar, invalid loop targets, shopt option
state and errexit inheritance, quote-aware for-list pathname expansion, bounded
no-capture ERE matching and dynamic EPOCHREALTIME. Captures, backreferences and
locale collation remain explicitly unsupported.

The generator never builds a binary. Each observation has a fresh working
directory and an owned process group, cleaned up before its scratch directory
is removed. It self-queues through the local light admission wrapper when
available. Exact stdout bytes and numeric status determine matches; a failed
Bash observation cannot receive an `UNSUPPORTED` exemption. Stderr is retained
for diagnosis, not scored.

`--record-oracle PATH` captures Bash-only observations before implementation and
marks their provenance `oracle-only`; it does not claim candidate support.
`--record PATH` additionally requires a clean candidate comparison. Both modes
pin GNU Bash 5.3.15. Replay verifies generator/process-runner fingerprints,
regenerated identities, scripts, count, coverage and oracle metadata, without
invoking Bash. Replay rejects every mismatch and `UNSUPPORTED` result:

```sh
npm run fuzz:shell-control-flow -- --shell /path/to/shell-engine --seed 1
npm run fuzz:shell-control-flow -- --shell /path/to/shell-engine --seed 42
npm run fuzz:shell-control-flow:ci -- --shell /path/to/shell-engine
npm run test:fuzz-shell-control-flow
```

The two new seed fixtures belong only to this generator. Existing generators
and fixtures are not regenerated as part of this gate.

## Direct-child wait and job lifetime

`npm run fuzz:shell-job-lifetime -- --shell PATH --seed 1` compares 240
builtin-only cases with GNU Bash 5.3.15: 144 fixed controls and 96 seeded cases.
The matrix crosses 12 wait/status/notification families, root/function/subshell
scopes, and four fixed exit statuses. Each seed adds 96 unique scripts using
non-matrix statuses across 0–255; all 240 scripts are distinct within the seed.
It covers repeated numeric and percent waits,
bare wait, pipeline status, child ownership, one-shot `jobs` completion, and
completed-job signal selectors. Completion barriers use direct-child existence
checks rather than timing sleeps. Job descriptions are normalized to their state;
exact resulting stdout bytes and exit status are compared without exemptions.

The generator shares the bounded process-group runner and fingerprints its own
source plus both imported runner sources. Oracle-only recording pins Bash
5.3.15, environment and every generated script. Strict CI replay never invokes
Bash and rejects stale source, metadata, grammar or observation mutations:

```sh
npm run fuzz:shell-job-lifetime:ci -- --shell /path/to/shell-engine
npm run test:fuzz-shell-job-lifetime
```

Inherited external descendants are intentionally outside this builtin grammar.
Their descriptor, signal and reaping behavior is covered by native/WASI tests
using the engine's injectable runtime ABI. Real Bun/browser acceptance remains
pending the inherited runtime-job dependency delivery.
