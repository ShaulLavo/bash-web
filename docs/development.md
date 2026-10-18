# Development and architecture

`bash-web` is a WASM-first bash-compatible shell: a Rust parser and shell
engine, a browser embedding adapter, and standalone verification. Its original
shell commits, fixtures, oracle observations, and compatibility harness are
preserved.

The shell is a WASM program, not a browser runtime. The separate
[`waffle`](https://github.com/ShaulLavo/waffle) package owns filesystem, process,
pipe, and page lifecycle services. Create **one runtime per page**, then pass it
to each shell. The shell adapter imports Waffle; it does not vendor a runtime or
create a second runtime behind the application's back. Applications register
external programs with their runtime; the shell does not register Bun or other
programs implicitly.

```ts
import { createRuntime } from "waffle";
import { createShell } from "bash-web";

// Serve the bundled Waffle filesystem worker at this application-owned URL.
const runtime = createRuntime({
  filesystem: { workerURL: new URL("/fs-worker.js", location.href) },
});
try {
  const shell = await createShell({ runtime, script: "printf 'hello\\n'" });
  try {
    const result = await shell.done;
    console.log(result.code);
  } finally {
    await shell.dispose();
  }
} finally {
  await runtime.dispose();
}
```

This is a browser/bundler entry, not a Node shell launcher. Serve the shell
and guest assets with the isolation headers described in
[Browser integration](browser-runtime.md). Omitting `script` starts the
persistent interactive editor; the host connects the shell's terminal byte
bridge to its UI. Terminal rendering and demo controls live in `src/browser/`,
separate from the shell facade.

`waffle` is a **required peer dependency**, pinned to the published Git commit
`4f07d191c0c8d6047800031c3a803f67d6954572`:
`git+https://github.com/ShaulLavo/waffle.git#4f07d191c0c8d6047800031c3a803f67d6954572`.
The development dependency uses the same pin so local builds and tests exercise
the same runtime applications supply.

## Build and test

Prerequisites are Node 26.7.0, npm, Rust 1.98.1 through rustup, and
wasmtime for WASI tests. The frozen compatibility oracle requires exactly
Node 26.7.0; CI and standalone verification use that version.

```sh
git clone https://github.com/ShaulLavo/bash-web.git
cd bash-web
rustup toolchain install 1.98.1 --profile minimal --component rustfmt --target wasm32-wasip1
npm ci
npm run build:shell
npm run test:rust
npm run test:shell:wasi
```

Build and check the browser integration separately:

```sh
npm run test:browser:package
npm run build:browser
npm run typecheck:browser
npm run test:runtime:terminal
npm run test:browser
```

Browser tests require the Playwright browsers used by their configured projects.
The browser build publishes the real `shell-runtime.wasm` at
`/programs/shell-engine.wasm` and bundled JavaScript workers at
`dist/shell-worker.js` and `dist/fs-worker.js`. The filesystem worker is built
from Waffle's public `waffle/browser/fs-worker` entry; applications own its served
URL and pass it to `createRuntime`. The browser shell is not the stand-in CLI. This package
contains no Bun launcher, runtime implementation, guest binary, or guest-license
payload. Bun-specific browser cases remain pending until the external package
publishes the required installer/worker APIs and verified guest descriptor; see
[the current boundary and limitations](browser-runtime.md).

The shell-only CI also runs the native and WASI suites, size ceiling,
scoreboard runner tests, generator source tests and fixed fixture replays.
Run the individual shell fuzz replays with the `:ci` scripts in
`package.json`; they use only the committed generator and fixture bytes.

The frozen compatibility score can be replayed without downloading corpora,
installing GNU Bash, or installing browser assets. The full compatibility CI job
also runs sandbox and transport tests, which require bubblewrap and Python 3:

```sh
BASH_COMPAT_BASE_REF=$(git rev-parse HEAD) npm run compat:shell
```

For explicit maintenance capture, prepare the pinned corpus sources only with
`npm run prepare:shell-corpus`. That command verifies archive checksums and
does not build an engine. Capture itself requires Linux, GNU Bash 5.3.15,
bubblewrap, Python's standard library, and the `yaml` package.

## Engine layer gate

Run the lexical dependency checks without building Rust or changing frozen
compatibility data:

```sh
npm run test:check-layers
npm run typecheck:layers
LAYERS_BASE_REF=$(git rev-parse origin/main) npm run check:layers
```

`LAYERS_BASE_REF` (or `--base-ref`) must be an immutable full commit SHA.
CI fetches complete history and selects the PR base SHA, the pre-push main SHA,
or the merge-base with main for another branch's push. The lightweight layer
job and the shell, compatibility and browser jobs run independently and must all
pass: a layer-check failure must not skip real shell or browser coverage.
`npm run compat` is an alias for `npm run compat:shell`; it still uses the frozen oracle.

The checker scans every engine Rust source regardless of platform or feature
configuration. It records separate production and test-only edges, violations,
source locations and a source digest in `docs/evidence/engine-layers.json`.
Neither violation count may increase, and a new violating edge cannot replace
an old one even at the same count. This is a lexical check, not Rust alias or
macro resolution and not proof that optional capabilities compile separately.
See [plan 006](../plans/006-engine-boundaries.md) for the graph and that later gate.

After editing engine sources, refresh and commit their exact evidence together:

```sh
LAYERS_BASE_REF=$(git rev-parse origin/main) npm run check:layers -- --record
```

Recording cannot bypass the committed-HEAD or immutable-target ratchet. A normal
merge can carry unchanged evidence from a parent while combining newer sources.
The checker verifies the identical parent evidence against that parent's sources,
rescans the merge, and ratchets it against the verified parent before permitting
a refresh. It never substitutes the old source digest or old counts for merged
sources. Changed merge evidence must match exactly; ordinary source commits with
stale evidence are rejected, as are tampered parent or immutable-target records.
A target predating the first evidence file is scanned from its immutable sources.

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

A shell owns shell semantics and its own process handle. It borrows the page's
runtime; closing a shell must not dispose that runtime or unrelated shells.
The page owns runtime disposal. Waffle owns shared services and their teardown;
terminal rendering, browser controls, and asset serving remain host concerns.
Browser acceptance complements the frozen shell scoreboard and never replaces
or regenerates its oracle, baseline, classifications, or generator fixtures.
