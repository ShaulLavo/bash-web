# Development

How to build bash-web, run its checks, and find your way around the repository. For the design, read [Architecture](concepts/architecture.md). For the inside of the engine, read [Engine ownership notes](reference/engine-ownership.md).

## Choose your setup

| You want to | You need | Time |
| ----------- | -------- | ---- |
| Change the Rust engine or parser, run native tests | Rust through rustup | about 2 minutes for `npm run test:rust` on an M1 laptop |
| Build the WASM guests and run the WASI tests | The above, plus wasi-sdk 34.0, wasmtime, CMake, Ninja | a full patched-libc build on first run |
| Build and test the browser demo | The above, plus Playwright browsers | longest |
| Replay the frozen compatibility score | The WASI build, plus the installed Waffle dependency | see [Bash compatibility](bash-compatibility.md) |

CI builds the WASM guests on `ubuntu-latest`. The WASI and browser steps are verified on Linux only. The native Rust steps also run on macOS (see [Status](status.md#platforms)).

## Prerequisites

- Node `>=26.12.1` and npm. `package.json` sets `engines` and CI uses 26.12.1. The compatibility replay is stricter: `scripts/bash-compat.mjs` refuses to run unless `process.version` equals the oracle's recorded `v26.12.1`.

  Check what you have with `node -v`. If it prints a lower version, install 26.12.1 with a version manager, or download it from [nodejs.org](https://nodejs.org/dist/v26.12.1/):

  ```sh
  nvm install 26.12.1 && nvm use 26.12.1   # nvm
  fnm install 26.12.1 && fnm use 26.12.1   # fnm
  ```

  Install the exact 26.12.1 if you plan to run `npm run compat:shell`. Node ships with npm. The native Rust build and the README example do not need Node.
- Bun, only for the Node-side Waffle checks (`npm run compat:shell`, `npm run test:installed-waffle`). Bun builds Waffle's `dist/`, which `npm ci` leaves unbuilt. See [Install the Waffle peer](guides/embed-in-a-page.md#install-the-waffle-peer).
- Rust 1.98.1 through rustup. `rust-toolchain.toml` pins it with the `rustfmt` and `clippy` components and the `wasm32-wasip1` target, so rustup installs it the first time you run `cargo` in the repository.
- For WASI guests: wasi-sdk **34.0** with wasi-libc `2e6fb9d8ee0c` (`scripts/wasi-build.ts` rejects any other). Always set `WASI_SDK_PATH` to the SDK directory. `scripts/wasi-build.ts` has a built-in default that fits only one Linux layout, so do not rely on it. CI downloads `wasi-sdk-34.0-x86_64-linux.tar.gz` from the [wasi-sdk-34 release](https://github.com/WebAssembly/wasi-sdk/releases/tag/wasi-sdk-34) into `.build/wasi-sdk` and checks its SHA-256 (`.github/actions/wasi-sdk/action.yml`). You also need wasmtime, CMake **3.26+**, Ninja, curl, tar, patch, sha256sum, Linux `setsid`, GNU `timeout`, and `flock`. The shared libc patch and builder come from Waffle. See [Guest libc and build provenance](wasi-libc.md).
- For browser tests: `npx playwright install chromium firefox`.
- For score capture only: Linux, GNU Bash 5.3.15, bubblewrap, and Python 3. Replay needs none of these.

## Build and test

```sh
git clone https://github.com/ShaulLavo/bash-web.git
cd bash-web
npm ci
npm run build:shell       # WASI shell engine, needs wasi-sdk
npm run test:rust         # parser provenance, rustfmt, native workspace tests
npm run test:shell:wasi   # WASI tests under wasmtime and the brotli size ceiling
```

`npm run test:rust` ends with the native test summary. At commit `a745a96` the workspace has 1,657 passing tests on macOS arm64.

Build and check the browser integration separately:

```sh
npm run test:browser:package
npm run build:browser
npm run typecheck:browser
npm run test:runtime:terminal
npm run test:browser
```

`npm run serve` starts the standalone demo at `http://127.0.0.1:4187` after a build. `PORT` overrides the port. The demo sends the isolation headers described in [Browser integration](browser-runtime.md#serve-the-assets).

The shell CI job also runs the native and WASI suites, the size ceiling, the scoreboard runner tests, the generator tests, and the fixed fuzz replays. Run one replay with its `:ci` script in `package.json`, for example `npm run fuzz:shell-echo:ci`. See [CI inputs and job ownership](ci.md), [Code quality gates](code-quality.md), and [Shell fuzzing](shell-fuzzing.md).

### Replay the compatibility score

```sh
BASH_COMPAT_BASE_REF=$(git rev-parse HEAD) npm run compat:shell
```

This replays the frozen oracle without downloading corpora or installing GNU Bash. It builds the WASI guests first, so it needs the WASI prerequisites. Each parallel runner needs about 1.2 GiB. Set `BASH_COMPAT_JOBS=1` on a small machine. The corpus preparation step (`npm run prepare:shell-corpus`) and score capture are maintenance tasks. See [Bash compatibility](bash-compatibility.md#own-shell-fixed-scoreboard).

## Frozen files

Do not regenerate or edit these in ordinary work. Scripts check them by digest.

- `docs/evidence/`: oracle, baseline, receipts. See its [README](evidence/README.md).
- `scripts/fixtures/`: generator inputs and recorded Bash output.
- `sources.lock.json`: pinned source revisions, archive checksums, and the provenance of every copied or adapted file.
- `THIRD_PARTY_NOTICES.md` and `dist/THIRD_PARTY_NOTICES.txt`: ship these with any distribution. `npm run notices:shell` regenerates the shell-only notices.

## Repository layout

- `shell/parser/`: the parser crate (`shell-parser`), started from Bashkit's parser.
- `shell/engine/`: the async shell engine. It builds `shell-engine` (CLI and size harness) and `shell-runtime` (the browser guest).
- `shell/utilities/`: `cat`, `grep`, `mkdir`, `seq`, and `tail` as separate WASM programs.
- `shell/compat-fixtures/`: test-only guests (`argv-py`, `printenv-py`) and `shell-cli`, the engine composed with the utilities. Never packaged.
- `src/shell.ts`, `src/index.ts`: the public API. See [API reference](reference/api.md).
- `src/runtime/`: adapters that connect the shell guest to Waffle.
- `src/utilities/`: the install entries for each utility.
- `src/browser/`: the demo page and its terminal UI. Not part of the shell API.
- `tests/`: Playwright acceptance tests. `tests/guest/` holds the source-built `test-guest` and `test-spin` programs ([Test guests](test-guests.md)).
- `scripts/`: build helpers, the scoreboard, differential fuzzers, provenance checks.
- `docs/`: this documentation. [Docs map](README.md).
- `plans/`: internal notes, not documentation. `sources.lock.json` names this path, so it stays.

## Engine layer gate

The engine's modules may import only lower layers. `npm run check:layers` scans every engine Rust source for rooted `crate::` imports and fails when a violation count grows.

```sh
npm run test:check-layers
npm run typecheck:layers
LAYERS_BASE_REF=$(git rev-parse origin/main) npm run check:layers
```

`LAYERS_BASE_REF` (or `--base-ref`) must be an immutable full commit SHA. CI fetches complete history and selects the PR base SHA, the pre-push main SHA, or the merge-base with main for another branch's push. The layer job runs independently of the shell, compatibility, and browser jobs, and a layer failure does not skip their coverage.

The checker compares production and test-only edges using the immutable base's scanner and policy for both source sets. Neither violation count may increase, and a new violating edge cannot replace an old one at the same count. The check is lexical. It does not resolve Rust aliases or macros and does not prove that optional capabilities compile separately.

Set `LAYERS_OUTPUT` or `--output` to retain complete base/candidate graphs and comparison evidence. CI uploads this file even when the comparison fails. Do not refresh or commit `docs/evidence/engine-layers.json`; it is historical evidence, not a gate input. The graph is described in [ADR 003](adr/003-one-core-shell-and-installable-utilities.md).

### Shared execution ownership

`exec` owns storage budgets and allocation guards, retained `Rc` source text,
execution scopes and frames, neutral command `Work`, shared `Error` metadata,
`ResultFuture`, and the charged arithmetic fault constructor. It imports only
`executor` internally. `state` and `ast_copy` borrow `exec::Work` directly.
Expansion keeps an inline wrapper with arithmetic recursion/name/write policy
and its concrete substitution runner; `Deref`/`DerefMut` borrow neutral admission
without a new trait, generic parameter or allocation.

There are two intentionally different frame policies. `Scope::frame` admits the
exact pin-projected wrapper size from the session's **active** execution budget
and returns its allocation immediately on readiness or cancellation. Arithmetic's
small feature adapter admits the exact future size from command Work's
**cumulative** storage budget, without refunding completed frames. Do not replace
the pin projection with `FutureExt::map`: recursive polling would reserve large
per-level scratch frames. `RESOURCE_STATUS` remains the internal -1000 sentinel;
only the interpreter maps it to resource flow and public status 2. Ordinary
status 2 and cancellation 130 remain distinct.

`Limits`, `Flow`, `Outcome`, diagnostics, eval source-shape accounting and parser
orchestration remain in the interpreter. Low scopes take only `source_bytes`,
issue a fresh parser budget for each input and preserve interrupt probes. A
function entry resets structural depth only (256), while a new task also resets
eval reader depth (16). Retained sources share their text and allocation owner
through stored functions and descendant contexts. Test-only poll/drop/call
measurements share one executor-owned thread-local observer; memory observations
stay with the storage budget. Parsing orchestration remains above these types.

### Binding ownership

| Area                                  | Classification                                                   | Local source and reason                                                                                                                                                |
| ------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Binding storage and scope restoration | Original local ownership adapters; no newly copied upstream code | `state.rs` owns scalar/attribute/nameref/function/positional/local writes and every restoration guard. `state/bindings_tests.rs` pins the distinct lifecycle policies. |

The binding move starts from local bash-web
`163386141175458cf9d265e70e92d0c5074333dc`, especially the interpreter's
original `BuiltinPrefixFrame` and the state's existing `PrefixFrame` and
`FunctionFrame`. The unchanged Bashkit-derived expansion rules retain their
separate classification in `sources.lock.json` and the notices.

Callers request checked parameter assignment, declarations, temporary binding
scopes, function scopes, subshell snapshots, startup environment initialization
or execution-result publication. Read views borrow immutable raw storage: they
must not dereference namerefs, format dynamic parameters or substitute special
parameter values. No mutable-map accessor is available, including to fixtures.
Fixture setup now uses state operations; it is not a production write path.

One `state::PrefixFrame` restores temporary scalar bindings, but its policies
are intentionally different. Expansion saves stay in state so completed RHS
assignments update only the last expansion frame's saved binding. Installation
checks scalar targets and readonly state, and direct IFS prefixes restore their
cached classification and separator on drop. Builtin replay saves stay with the
guard, outside subshell snapshots; replay does not recheck readonly state or
refresh/restore IFS caches. Builtin attribute and nameref side effects survive
scalar restoration. Its dynamic-clock suspension restores only the hook that
the guard actually suspended. All asynchronous admission precedes replay;
later per-entry admission failures still unwind already installed bindings.

`FunctionFrame` remains distinct: its temporary prefix scope sits below its
local-declaration scope, and it owns positional restoration, local export and
nameref restoration, storage tickets and function-return IFS refresh. Drop
restores synchronously without cancellation checks. Assignment-only expansion
commit still admits aggregate positive local-ticket growth before changing any
binding owner. The standalone CLI replaces startup scalar bindings and inserts
an absent non-exported PATH; the browser adapter extends default bindings and
exports the retained default IFS without inventing PATH. Execution status,
pipeline status and async identity are published separately at their existing
phases, not assigned as ordinary scalar strings.

### Parsing contexts

| Area                                   | Classification                                                            | Local source and reason                                                                                                                                                                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Parsing facade and delegation controls | Original local adapters; no newly copied or moved upstream implementation | `shell/engine/src/parse.rs` and `parse/tests.rs` centralize the original parser calls from local bash-web `3cec14c60bf2ed90dedb504d48da50d3b689108e`. The parser crate, provenance lock and upstream-derived expansion algorithms remain unchanged. |

The private `parse` module is the single production entry boundary for shell
parsing, not a new parser or a generic mode-switch API. Entry points retain their
source and grammar distinctions:

- `script` and `eval` borrow the caller-owned source, byte ceiling and fresh
  interruptible parser budget. Both use the existing recovering reader: complete
  prior lines and command-end lines survive, syntax and shell-word failures stay
  distinct, and resource/cancellation errors remain immediate errors. Source
  admission/retention, eval depth and public status/diagnostic mapping stay with
  their callers.
- `declaration_tokens` re-lexes only the bounded source span with raw capture,
  retaining incremental token order and caller-owned cancellation checkpoints.
- `generated_word` parses one admitted brace variant in **word** context, with
  the general AST depth cap and source-derived fuel. It does not use the smaller
  scalar-operand cap or treat generated reserved words as commands.
- `lazy_parameter` receives the scanner's outer-quote and pattern flags;
  `lazy_variable` retains the existing infallible word API and single-part check
  in the caller. Both keep the scalar depth cap 16 and token fuel 65,536. Neither
  parses inactive operand bodies in advance.
- `substitution_token` and `backtick_body` retain strict body grammar, general
  depth and source-derived fuel. Backtick syntax failures still become deferred
  child errors, while resource failures remain immediate. `substitution_grammar`
  keeps its separate validation-only depth cap 16, fuel 65,536 and default options.

Expansion still admits synchronous work and storage **before** calling the facade
and retains its checkpoint/error-conversion order. Script grammar stays lenient
at top level and strict in substitution bodies, with aliases absent and extglob
lexing enabled as before. Validation-only substitution grammar retains the
different default options (extglob disabled). Compiled capabilities receive no
new filters or settings. Full/Lite capability policy is
not introduced by this move. AST types, boundary scanners, the arithmetic
expression evaluator and direct parser fixture constructors are not facade entry
points. Contract tests compare each context with its exact old parser call and
pin recovery, byte limits, shared sticky work/cancellation, lazy quote/pattern
context and deferred substitution failures.

### Command views and dispatch

| Area                                       | Classification                                                                      | Local source and reason                                                                                                                                                                                                                                                                                          |
| ------------------------------------------ | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Noninteractive select                      | Original local execution and regression controls; GNU Bash is an observation oracle | `shell/engine/src/interpreter/select.rs` expands a retained choice list once, writes literal PS3/menu bytes, reads one bounded line without read-ahead, and uses existing scalar assignment and loop-control contracts. No upstream implementation copied.                                                       |
| Typed command catalogue and view contracts | Original local ownership adapters; no newly copied upstream code                    | `shell/engine/src/commands.rs`, `commands/tests.rs` and `tests/words/command_metadata.rs` centralize the command-name inventory from bash-web `92ab384516abcf91da811e11ac871b73f6722ba0`. The adapted declaration-word checks remain in `builtins.rs`; their existing Bashkit classification below is unchanged. |

Before extraction, the engine had **31** `is_builtin` names, only **30** builtin
adapter dispatch names (`command` has no adapter arm), and three interpreter-only
names (`exec`, `eval`, `let`): **34** expanded-name execution entries in total.
The query view reports **30** shell builtins and **22** keywords. Literal scalar
declaration syntax has exactly five candidates. The single typed catalogue now
owns these names and selects the existing enum handlers. `type`, `alias`,
`builtin` and `source` are not added.

These are intentionally different views, not one generic builtin predicate:

- Literal declaration recognition still checks quoting, word parts and raw
  continuation spelling before scalar assignment operands suppress splitting.
  An expanded name may dispatch a declaration handler without gaining that
  syntactic privilege; `command` does not re-expand its target's arguments.
  Parser-owned compound-array declaration grammar remains separate and unchanged.
- Special/regular builtin class is descriptive metadata, not a new precedence,
  persistence or POSIX-mode rule. Declaration status overlaps both classes.
  `cat`, `grep`, `mkdir` and `seq` are external programs, absent from builtin
  metadata and dispatch. Queries and execution both use ordinary PATH lookup.
- Builtin heredoc errors belong to the shell; external-command errors use the
  command-local context. Functions take precedence before command-wrapper
  unwrapping.
- Queries still choose keyword, function, reportable builtin, then PATH. Keyword
  visibility does not claim syntax support: `time` and `coproc` are
  explicitly unsupported execution syntax. Noninteractive `select` is included.
  Availability distinguishes included core commands from unsupported syntax,
  without build presets or feature filters.
- The interpreter retains early direct `exec`, wrapper parsing/function bypass,
  function frames, and `let`/`eval` phases. Prefix restoration, status/diagnostics,
  PATH admission, cancellation and lazy expansion remain with their old owners.
  There is no alias lookup to reorder.

The catalogue has no dependencies on feature modules. Original membership tests
pin every old view independently, including absent names, handler ownership,
class/availability relationships and the external-command exclusions. Original
engine controls passed against the unchanged baseline before extraction and pin
query output, declaration syntax, heredoc scope and function/prefix behavior.

## Repository layout

- `shell/` contains the parser and WASI shell engine.
- `src/shell.ts` exposes the runtime-injected browser shell API.
- `src/runtime/` contains guest/worker embedding adapters that import Waffle.
- `src/browser/` contains the terminal demo and page-level UI concerns.
- `tests/` contains browser acceptance tests.
- `scripts/` contains browser build helpers, the shell runner, scoreboard,
  provenance checks, and differential generators.
- `scripts/fixtures/` contains frozen generator inputs; do not regenerate them
  during ordinary maintenance.
- `docs/evidence/` contains frozen oracle, baseline, and classification data.
- `docs/extraction/` preserves the shell extraction's commit mapping and records.
- `plans/004-own-shell.md` records the approved shell work, and
  `plans/005-bash-web-packaging.md` records the package boundary.

The pinned source revisions, archive checksums, and implementation
classifications are in [`sources.lock.json`](../sources.lock.json). Keep the
generated `dist/THIRD_PARTY_NOTICES.txt` with distributions; shell-only notices
can be regenerated with `npm run notices:shell`. See
[Third-party notices](../THIRD_PARTY_NOTICES.md) and the
[browser source provenance](browser-runtime.md#source-provenance) for the
browser adapters, peer runtime, and terminal notices.

## Host boundary

A shell owns shell semantics and its own process handle. It borrows the page's runtime, so closing a shell never disposes that runtime or any other shell. The page owns runtime disposal. Waffle owns shared services and their teardown. Terminal rendering, browser controls, and asset serving stay with the host. Browser acceptance complements the frozen shell scoreboard and never replaces or regenerates its oracle, baseline, classifications, or generator fixtures.
