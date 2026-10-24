# Bash compatibility

## Current score

bash-web's own engine passes **1,315 of 1,682** Oils builtins-only cases (78.2%), **1,391 of 1,888** Brush-suite cases (73.7%), and **1,763 of 2,222** Bashkit-suite cases (79.3%). These are the committed baseline at `a745a96`. Print them with the command in [Status](status.md#compatibility-with-bash). Reproduce them with `npm run compat:shell`. The study that compared Brush, Bashkit and just-bash, and the per-change history of the score, are kept as internal working notes.

Names on this page:

- **own-shell** is the engine name the scoring scripts use for bash-web's own Rust engine (`BASH_COMPAT_ENGINES=own-shell`). It is the only engine the fixed replay runs.
- **brush-web** is the retired prototype repository that ran Brush in the browser. It produced the historical comparison in [History](#history). bash-web replaced it, and its browser adapter code was ported here (see [third-party notices](../THIRD_PARTY_NOTICES.md)).
- **Brush**, **Bashkit**, and **just-bash** are other bash implementations, scored for comparison only.

The case counts differ by one between the two parts of this page. The earlier comparison classified 1,889 Brush-suite and 2,223 Bashkit-suite cases as builtins-only. The fixed scoreboard scores 1,888 and 2,222, because it re-ran GNU Bash twice and dropped the two cases whose output differed between runs: `brush-suite:options/set-e:145` and `bashkit-suite:background:11`. Oils stays at 1,682. The oracle file marks both cases `fresh bash oracle output is not deterministic`.

## History

Before bash-web had its own engine, the same cases were scored for Brush, Bashkit, just-bash and native Brush in the retired `brush-web` prototype (GNU bash 5.3.15 as oracle, stdout and exit status compared, 10-second timeout per case). On the builtins-only Oils cases, Bashkit source scored 95.4% and Brush (browser) 78.4%. The first bash-web baseline was 288 of 1,682 Oils, 295 of 1,888 Brush-suite and 445 of 2,222 Bashkit-suite cases, and the score has only gone up since. The raw comparison is `docs/evidence/bash-compatibility.json`.

## Own-shell fixed scoreboard

`own-shell` is the package's only default engine. Its frozen replay runs the production `shell-runtime` guest on Waffle's Node runtime. The replay command and the rules that hold the score are in the paragraphs and code blocks below. For the committed baseline, see [Current score](#current-score).

[The committed baseline](evidence/own-shell-baseline.json) records exact counts for all 16 Oils subject categories, 120 Brush file categories and 261 Bashkit file categories, including categories whose cases are all skipped. Its `counts` are recomputed from per-case outcomes when validated.

The fixed set starts from the published case membership in
`docs/evidence/bash-compatibility.json`, including all excluded and external-case
classifications. It does not rediscover eligibility on each CI machine. Capture
loads scripts from the same pinned source paths and checks their IDs and names
against that classification. GNU bash 5.3.15(1)-release runs each selected case
twice, with fresh home/tmp directories, empty stdin and `LC_ALL=C.UTF-8`.
The old engines' outputs are never used as expected shell behavior. New oracle
timeouts, output-limit failures and nondeterminism become explicit exclusions,
so any difference from the earlier totals must be reported.

Capture runs inside bubblewrap with network namespaces disabled, a read-only
`/usr`, private home/tmp directories and the two Python fixtures. Owner files and
credentials are not mounted. The executable's SHA-256, version, capture platform,
helper hash and classification hash are recorded. Every source file's SHA-256
and upstream revision is recorded too. The source paths and retained upstream
licenses are listed in `sources.lock.json` and `THIRD_PARTY_NOTICES.md`.

The capture runner gives Bash independent real OS pipes for both output streams.
Node's `spawn` option
named `pipe` creates Unix sockets on this host; reopening those through
`/dev/stdout`, `/dev/stderr` or `/dev/fd` fails with `ENXIO`. The original Python 3
supervisor creates actual pipes, forwards exact bytes without combining streams,
and reports the command's exit status on a private descriptor unavailable to the
case. It does not wrap or rewrite the source. Timeouts, the combined output limit
and process-group teardown still belong to the Node runner. The supervisor drains
already-written bytes when the command exits, rather than waiting indefinitely
for background descendants to close a stream. Linux parent-death protection also
terminates the supervisor if Node is killed abruptly; bubblewrap then tears down
the private process namespace. Updating existing frozen observations requires a
complete eligible-case audit and the target-baseline proof described below.

`docs/evidence/own-shell-oracle.json` contains script text, category, case ID,
classification and exact normalized stdout/stderr bytes in base64 plus numeric
status. Only stdout and status decide a pass. stderr stays separate and is kept
for inspection. Oracle observations keep full bytes. Score diagnostics keep at
most 240 bytes per stream; longer streams include their full byte length and
SHA-256. Passing cases need no diagnostic copy. Compaction happens after the
exact comparison and does not affect scoring. Paths normalize to `$TMP` and `$HOME`; no UTF-8 conversion is used
for scoring. Oils keeps its subject categories; the secondary corpora use their
source file paths as categories. All skipped cases stay in the fixture and in the
result. The exact scored denominator is `total - skipped` in each count group.

CI uses Node 26.12.1 and Waffle's Node runtime to run only those selected cases
against the release `shell-runtime` guest. Each case gets a fresh Runtime and
filesystem with the working directory, `/dev`, `/bin`, `/usr/bin` and
`/usr/local/bin`, and the two fixture programs as separate guests on Waffle's
process path. stdout and stderr are raw separate streams, never a terminal sink,
and the root reports the oracle's descriptor kinds (pipes for stdout and stderr,
`/dev/null` for stdin). There is a 10-second timeout and a 4 MiB combined output
ceiling per case. A crash or timeout fails that case; it never silently becomes a
skip. Browser transport, shared filesystem behavior and cold-start measurement remain
host/product concerns. This package verifies the shell program and its
runtime boundary; it does not replace the browser host.

```sh
# Normal fixed replay, no installed GNU bash or corpus sources required.
npm run compat:shell

# Keep exact per-case results, counts, gained/lost IDs and newly failing cases.
BASH_COMPAT_OUT=compat-current.json npm run compat:shell

# Also compare with the baseline on the target branch, as pull-request CI does.
BASH_COMPAT_BASE_REF="$(git rev-parse HEAD)" npm run compat:shell

# Cheap mutation/selection tests, independent of Rust and the corpora.
npm run test:shell:scoreboard
```

The baseline stores exact outcomes and counts per corpus and category. Replay
rejects a changed case set, oracle observations, source identity, Node version,
environment policy or skip classification. It fails if **any corpus** loses a
pass in its exact count, even if rounded percentages or an aggregate score would
hide it. Gains and losses within a corpus are reported separately, including a
newly failing list that needs a named reason in the PR.

The compatibility CI job requires the candidate's committed per-case pass
membership to equal the fresh result. Gains must update the baseline in the same
PR, so a later loss of that gain cannot go unnoticed. Failure subtypes can change
without a baseline edit. The current score artifact is written before reporting
a stale baseline, so a climb PR can fetch and commit the updated result.

CI separately checks nonregression against the target branch's baseline read
with `git show` at the pull request's base SHA. Lowering the candidate baseline
cannot hide a regression. Bootstrap is allowed
only when the target source lock has no scoreboard entry. Later missing baseline
files fail closed. Case membership, corpus sources and environment identities
must still match exactly. An observation-only oracle correction triggers a
separate trusted migration: archive the exact target SHA, build its WASI engine
in a fresh target directory, and reproduce its old committed pass membership
before changing any oracle input. The same base binary is then rescored against
the corrected oracle. CI compares the candidate with that independently computed
base score while retaining `BASH_COMPAT_BASE_REF` and normal baseline validation.
No candidate-supplied base binary, oracle path or baseline path can replace this
proof. A failed old-baseline proof, rebuild, identity check or replay fails the
migration. Editing an identity or lowering the candidate baseline is insufficient.

Capture and initial baseline recording are explicit maintenance operations, not
part of compatibility CI:

```sh
# Requires bubblewrap, Python 3, GNU bash 5.3.15 and pinned corpus sources.
# BASH_COMPAT_BRUSH_DIR and BASH_COMPAT_BASHKIT_DIR may select existing caches.
BASH_COMPAT_MODE=capture BASH_COMPAT_BASH=/usr/bin/bash BASH_COMPAT_ENGINES=own-shell node scripts/bash-compat.mjs

# After reviewing the oracle and pinning its SHA-256 in sources.lock.json:
BASH_COMPAT_RECORD=1 BASH_COMPAT_OUT=docs/evidence/own-shell-baseline.json npm run compat:shell
```

Run builds, native/WASI tests and corpus captures through this host's heavy queue.
`BASH_COMPAT_SCRATCH` selects the scratch parent, defaulting to a local scratch directory
and `RUNNER_TEMP` in Actions. Each run owns a `bash-web-compat-*` directory and
removes it, workers and child groups on completion or interruption. Keep requested
result files outside that scratch directory and remove disposable result files
after review. Frozen replay neither prepares corpora nor invokes GNU bash, probes
external commands, runs mapfile sweeps or downloads other engines. Live ad hoc
comparisons use the own-shell engine and can select corpus groups with
`BASH_COMPAT_CORPORA`; corpus sources are not prepared when unselected.

### Differential arithmetic checks

`npm run fuzz:shell-arithmetic` generates deterministic scalar expressions and
compares native `shell-engine` stdout bytes and status with GNU Bash 5.3.15.
It covers `$((...))`, `((...))`, `let` and scalar `${v:offset:length}`, including
precedence, every integer operator, bases and overflow, assignments, short
circuits, recursive variable values, malformed expressions and fatal errors.
Quoted and unquoted slices include empty, ASCII and UTF-8 values. Fixed controls
check lazy offset/length evaluation, side effects and nested parameter operands.
This gate makes no claim about arrays, namerefs or command substitution.

```sh
# Build the native shell separately through the shared queue, then pass its path.
npm run fuzz:shell-arithmetic -- --shell /path/to/shell-engine --count 3000 --seed 7

# Refresh an oracle fixture only after the complete native comparison is clean.
npm run fuzz:shell-arithmetic -- --shell /path/to/shell-engine --count 3000 --seed 7 \
  --record scripts/fixtures/shell-arithmetic-seed-7.json

# CI replays seeds 7 and 314 without invoking an installed Bash.
npm run fuzz:shell-arithmetic:ci -- --shell /path/to/shell-engine
```

The generator routes itself through the shared queue when installed on this host.
It creates no temporary build trees, processes that outlive a case, or services.
Each case has a timeout and a bounded output buffer. Inherited startup files,
shell options and compatibility-mode variables are stripped, and both processes
use the same fixed UTF-8 locale. A timeout, signal, missing
process, byte difference or status difference is a mismatch; unsupported results
are not accepted for this scalar grammar. Replay verifies the generator hash,
seed-generated case identity, case count, oracle version and timeout before
running. The separate recorded shell-word gate remains unchanged.

## Scalar arithmetic and substring offsets

The shell supports scalar arithmetic expansion, arithmetic commands, `let`, recursive
scalar expressions, substring offsets and lengths, and positional slices.
Readonly declarations protect scalar writes and preserve local scope.
Arithmetic expansion errors discard the current read unit and resume at the
next top-level newline. Completed assignments survive errors and cancellation.

| Corpus        | Previous passes | Arithmetic passes | Gained | Lost |
| ------------- | --------------: | ----------------: | -----: | ---: |
| Oils          |             380 |               481 |    101 |    0 |
| Brush suite   |             340 |               384 |     44 |    0 |
| Bashkit suite |             595 |               754 |    159 |    0 |

The fixed oracle, case sets and environment are unchanged. The committed baseline membership matches the combined local WASI run. All 504 native and 287 WASI tests pass.
The release is 237,825 bytes with brotli-11, below the 1,000,000-byte ceiling.
Arithmetic seeds 7, 314 and 981 each match 3,674 Bash 5.3.15 cases. Seeds 7 and
314 are recorded for CI. Readonly seeds 17 and 314 each match 267 cases, and
27 parser compatibility cases match. Regenerated word fixtures for seeds 1
and 42 remain byte-identical, with 3,014 cases each.

## Brace expansion: lists and ranges

`npm run fuzz:shell-braces -- --shell /path/to/native/shell-engine` compares
5,318 cases with installed GNU Bash 5.3.15: 3,000 original generated cases,
2,031 boundary cases and 287 fixed controls.
Run both `--seed 1` (default) and `--seed 42`. `--self-control` instead compares
two fresh Bash processes; `npm run test:fuzz-shell-braces` checks the generator,
strict process matching and fixture validation without a shell build.

The original bounded grammar pairs quoted/unquoted command words and covers
nested/adjacent lists, empty alternatives, numeric and ASCII ranges, signed
padding, step zero, escaped/unmatched delimiters and opaque parameter results.
A leading fixed `printf '<%s>\\n'` argument distinguishes zero fields from one
empty field. Arithmetic counters test expansion order and evaluation once per
generated word; assignment and parameter-operand controls must not brace-expand.
Arithmetic failures in an older baseline are **MISMATCH**, never exemptions.
There is no tilde or selected command substitution; fixed controls cover
inactive command-substitution comments and deeply nested skipped defaults.
Generated letter ranges stay in one ASCII case: crossing `Z..a` beside `$v` can enter Bash's backtick parsing. An
isolated cross-case fixed control remains. Cartesian products are capped at 128
possible fields; engine resource-limit tests remain separate, not literal-output
fallbacks. Structural shrinking preserves context, quoting and failure status.

A structured boundary matrix systematically combines arithmetic/command-subshell
ambiguity, case patterns, subshells, comment parentheses and protected dollars
before parameter/command/arithmetic openers. Ambiguous forms vary one, two or
three closing parentheses so unmatched raw arithmetic spans remain distinct
from syntax errors inside a complete command substitution. Every feature crosses
six enclosing contexts, depths 0–3 and both quoting modes; the original seeded stream is not
displaced. Command-bearing operands stay inactive, while selected literal and
arithmetic controls exercise supported execution. Syntax failures are scored,
not excluded. Shrinking retains boundary kind, protection, context and guards.

The fuzzer never builds. It self-queues through this host's light queue and cleans
its private run directory (parent: `FUZZ_BRACES_SCRATCH`, else `RUNNER_TEMP`,
else the OS temporary directory). `--output PATH` keeps exact byte diagnostics.
`--record PATH` refuses dirty candidate runs and Bash self-controls. Seeds 1/42
are frozen only after a zero-mismatch native comparison.
`npm run fuzz:shell-braces:ci -- --shell PATH` replays both fixtures without Bash,
validating the generator hash, full ordered cases, coverage, seed, Bash version
family, timeout, status and canonical base64 observations before execution.

The implementation runs on original source before parameter-name parsing, so
`$v{a,b}` references `va` and `vb`, while `${v}{a,b}` retains its explicit name
boundary. Quote/escape spans and parameter/arithmetic text stay opaque. Lexical
line continuations join range fragments and dollar-opened constructs before
brace recognition, while ANSI-C quotes retain their escape boundaries. Invalid
enclosing groups do not become new ranges after their children expand. Lists
and numeric/ASCII-letter ranges preserve order, duplicate/empty alternatives,
padding and endpoint-directed steps. Scalar assignments and parameter operands
do not perform brace expansion. Declaration RHSs and redirect targets retain
the engine's existing scalar behavior; Bash's redirect brace/ambiguity rules
are not implemented. Pathname and tilde execution stay
separate.

Borrowed source spans and iterative expansion avoid recursive AST cloning.
Generated spellings are storage/work admitted before word-only parsing; their
length does not spend the emitted raw-output budget. All variants share field,
byte, raw-output and work limits. Resource exhaustion fails before dispatch,
never as a literal fallback or a partially expanded command. Native and WASI
regressions cover deep nesting, cancellation, source words above 4 KiB, and
independent storage and output budgets.

## Command and process substitution boundaries

`npm run fuzz:shell-substitutions -- --shell /path/to/native/shell-engine`
compares a bounded matrix against GNU Bash 5.3.15 with `bash -c SCRIPT`. Each
seed has 600 generated cases, 16 fixed controls and 2,520 boundary cases. Run
seeds 1 and 42, or use `--self-control` for two independent Bash processes.
The matrix crosses plain and double quoted words, set and unset
`${v:-...}` operands, arithmetic, nested `$(...)` and guarded `<(...)` contexts
with fused and spaced `$(`, `$( (`, `$((`, `<(` and `<((` openers. It includes
plain, quoted, escaped and dash here-documents, metacharacter delimiters,
continuations, missing delimiters, multiple here-documents, case pattern
terminators, closed syntax errors, and every requested unterminated redirect,
keyword, list, quote, comment and nested-substitution boundary. One, two and
three closing-parenthesis variants remain separate observations.

Only stdout bytes and exit status decide a match. Stderr is diagnostic. An
`UNSUPPORTED` result is allowed only when Bash succeeds and the candidate exits
2 with empty stdout because substitutions or compound commands are not
executable yet. A Bash-accepted parse that the candidate rejects, and status 127
instead of 2, are `MISMATCH`. Mismatches are structurally shrunk while retaining
their boundary shape and written to `brush-web-subst-mismatches.json` beside
the run directory (or `FUZZ_SUBST_MISMATCHES`). The run cleans its directory
under `FUZZ_SUBST_SCRATCH`, `RUNNER_TEMP` or the OS temporary directory and never
builds a shell binary. `--record` requires zero mismatches; replay invokes no
Bash and validates the generator hash and every regenerated case.

```sh
npm run fuzz:shell-substitutions -- --shell /path/to/native/shell-engine --seed 1
npm run fuzz:shell-substitutions -- --shell /path/to/native/shell-engine --seed 42
npm run fuzz:shell-substitutions:ci -- --shell /path/to/native/shell-engine
```

### Structured control-flow gate

The standalone shell executes if/elif/else, while/until, word-list and C-style
for loops, nested break/continue counts, and case `;;`, `;&` and `;;&`.
`set -e` follows conditional, AND/OR, negation, pipeline and function suppression
contexts. Unredirected compound commands preserve `exec` descriptor changes;
redirected compounds restore their caller's descriptors. Temporary process-substitution
descriptors close with their owning compound, without undoing unrelated `exec`
changes. Redirection setup failures obey `-e` even on compound commands.

`test` and `[` use argv semantics and decimal integer comparisons. `[[ ]]` has
its own parsed expression tree: operators are fixed before expansion, logical
branches short circuit, and scalar/pattern operands preserve quoting. Arithmetic
comparisons share the bounded arithmetic evaluator. File predicates use virtual
filesystem metadata, not attempts to open a file. A filesystem that cannot
supply a required permission/ownership capability reports explicit unsupported
status 2 rather than inventing an answer. `=~` supports a bounded, cooperative
no-capture ERE subset for ASCII patterns/input in C/POSIX/C.UTF-8/C.utf8
character and collation locales. Non-ASCII data, other locales, captures,
backreferences and locale collation return explicit unsupported status 2.
Dynamic `EPOCHREALTIME` emits seconds and six fractional digits, with
Bash-compatible unset behavior. `shopt` stores and reports
`inherit_errexit`, `nullglob` and `extglob`. Positive `@()`, `?()`, `+()` and
`*()` groups support nesting and alternatives in case patterns when extglob is
enabled, and in `[[ == ]]` and `[[ != ]]` regardless of that option. Quote masks
keep protected punctuation literal. An iterative, work-bounded NFA avoids
recursive matching and backtracking. Group boundaries preserve balanced literal
parentheses, bracket context and quote/expansion delimiter boundaries. Malformed
groups retain Bash's literal fallback. Negative groups, pathname extglob, and
extglob in scalar trim or replacement remain unsupported. The
[extglob receipt](evidence/own-shell-extglob.json) records exact production gains
and losses. Command argv, indexed compound assignment operands and for-list
pathname expansion use quote metadata and incremental filesystem directory reads,
including real positive matches, nullglob misses and `set -f`. Redirect targets
and scalar assignments stay scalar. Pathname
extglob, `dotglob`, `globstar`, `nocaseglob` and `failglob` remain unsupported.
`cd`, `pushd`, `popd` and `dirs` check real directory metadata and search
permission, publish `OLDPWD`/`PWD` like Bash, and keep a private directory
stack; physical (`-P`) resolution remains unsupported. See
[cd and the directory stack](directories.md).

The new control-flow generator has its own two recorded GNU Bash 5.3.15 seed
fixtures, each containing 1,848 structured controls plus 600 seeded cases.
Its initial oracle-only capture is explicitly distinguished from a
candidate-verified recording. Strict CI replay verifies generator and fixture
identity and accepts neither `UNSUPPORTED` nor byte/status mismatches.
Existing differential generators and their fixtures keep their original bytes.
See [the gate commands](shell-fuzzing.md#structured-control-flow-and-conditionals).

