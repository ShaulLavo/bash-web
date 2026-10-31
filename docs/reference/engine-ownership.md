# Engine ownership notes

Reference for who owns what inside `shell/engine/`: execution types, binding storage, parsing entry points, the command catalogue, and the frozen-runner completion fix. Each section records the source revision it started from and whether code was copied. Read it before moving code between engine modules. The allowed module graph is checked by `npm run check:layers` (see [Development](../development.md#engine-layer-gate)).

## Neutral program support

`lib.rs` re-exports the executor and I/O modules from the pinned
`waffle-program-support` Git dependency. Waffle owns scheduling, cancellation,
open descriptions, bounded pipes, filesystem metadata and directory paging,
readiness registrations, and neutral WASI imports. No copies remain in the engine.

The shell's `runtime` owns process groups, child collection, executable access,
input pumps, job-control policy, and prompt signals. Its ABI extends Waffle's
neutral ABI, and its reactor delegates to one support runtime. Reaping a shell job
notifies matching kind 4 readiness registrations after updating the shell state.

The local WASI wrapper reads `shell_terminal.inherited_fd` and passes those bindings
to `WasiAbi::with_inherited_fds`. It does not query `runtime_proc.inherited_fd`.
SIGWINCH handling remains opt-in for a hosted prompt. Stack observation is enabled
only through the engine's development dependency, never its release dependency.

The shared implementation is Waffle `a9af70fabd5ea2f0f7e7730a36ca00ff6697d9ee`.
Native and WASI characterization tests pin the previous ownership and wake behavior.

## Shared execution ownership

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

## Binding ownership

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

## Parsing contexts

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

## Command views and dispatch

| Area                                       | Classification                                                                      | Local source and reason                                                                                                                                                                                                                                                                                          |
| ------------------------------------------ | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Noninteractive select                      | Original local execution and regression controls; GNU Bash is an observation oracle | `shell/engine/src/interpreter/select.rs` expands a retained choice list once, writes literal PS3/menu bytes, reads one bounded line without read-ahead, and uses existing scalar assignment and loop-control contracts. No upstream implementation copied.                                                       |
| Typed command catalogue and view contracts | Original local ownership adapters; no newly copied upstream code                    | `shell/engine/src/commands.rs`, `commands/tests.rs` and `tests/words/command_metadata.rs` centralize the command-name inventory from bash-web `92ab384516abcf91da811e11ac871b73f6722ba0`. The adapted declaration-word checks remain in `builtins.rs`; their existing Bashkit classification below is unchanged. |

When the catalogue was extracted, the engine had **31** `is_builtin` names, only
**30** builtin adapter dispatch names (`command` has no adapter arm), and three
interpreter-only names (`exec`, `eval`, `let`): **34** expanded-name execution
entries in total. The query view reported **30** shell builtins and **22**
keywords. Literal scalar declaration syntax has exactly five candidates. The
single typed catalogue owns these names and selects the existing enum handlers.
These counts describe the extraction, not today's catalogue: `type`, `alias`,
`builtin` and `source` were added later, and `shell/engine/src/commands.rs` is the
current list.

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
  visibility does not claim syntax support: `coproc` is explicitly
  unsupported execution syntax. Noninteractive `select` is included.
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

## Frozen runner completion

The canonical Waffle root controller gates ordinary exit confirmation on the
worker's ordered acknowledgement. Its shared outcome can become visible before
queued stdout and stderr messages. Resolving on that outcome alone could dispose
the runtime and discard the output tail after an external utility. Signals still
settle without an ordinary acknowledgement through Waffle's supervisor.

This is an original local adapter correction, not copied upstream code.
`scripts/test-own-shell-root.ts` holds real root-worker messages until its outcome
is published, observes it through the real supervisor, then delivers those messages
in order. It pins raw output, status and the acknowledgement boundary, and separately
pins a killed root that never starts. `scripts/own-shell-runner-fixture.ts` only
relocates the unchanged original tiny WASI fixture from the existing runner tests.
No oracle, baseline, migration receipt, stdio kind, case deadline or output bound
changes.
