# Trap execution contract

## Caller usage

Trap execution is one lifecycle seam around the existing command reader. The
caller should not decide whether a trap is suppressed, which status wins, or
whether a nested scope owns `EXIT`:

```rust
let command = lifecycle.before_command(command, &context)?;
let outcome = command_body(command, state.clone(), fds, context.clone()).await;
let outcome = lifecycle.after_command(outcome, &state, &context).await?;
```

The function and source callers use the same owner, while their frames are
still live:

```rust
let outcome = execute_function_body(...).await;
let outcome = lifecycle.leave_boundary(Boundary::Function, outcome, ...).await?;
drop(function_frame);
```

The root reader is the only session owner:

```rust
let outcome = reader::run(...).await;
let outcome = lifecycle.finish_session(outcome, ...).await?;
```

These calls are the proposed touch points. Ordinary commands with no matching
trap take the value-only path; only a matching action enters nested evaluation.

## Problem and evidence

Main stores trap bindings and inherited snapshots, but action lookup is used by
the printing/query path only. The command path currently checks `ignore_errexit`
and `state.errexit` in `execute`, while function/source restoration is owned by
`FunctionFrame` and `SourceFrame`. Adding four unrelated fixes would duplicate
those policies and make status, cancellation, and snapshot behavior drift.

The design is grounded in main `9fc1cdbd907ab376e61039331b43b379addea754`.
`interpreter.rs:1119-1161` is the command boundary and applies errexit after
`command_body`; `interpreter.rs:1270-1303` creates pipeline-stage contexts;
`interpreter.rs:2003-2062` snapshots and cancels subshells;
`interpreter.rs:800-825` owns the root exit request. `state.rs:465-474` copies
`traps.inherited()` into snapshots. `state/traps.rs:1-2` explicitly records
that bindings are registration-only, and `:46-63` makes inherited mutation
copy-on-write. `interpreter.rs:3276-3404` keeps the function frame live until
its body outcome is known; `interpreter/source.rs:74-99` restores source state
before normalizing `return`. The study found 173 potential trap cases and
estimated 130–170 eventual cases; those are opportunity estimates, not gains.

## Contract

`TrapLifecycle` owns four policies: DEBUG eligibility, ERR suppression,
function/source RETURN ordering, and root-only EXIT-once. It receives the
existing `Context`, `State`, `Outcome`, reader location, and descriptors; it
does not own process signals or rewrite the executor.

- DEBUG runs only at the command sites frozen by the cross-family matrix. It
  runs before the target command body, is skipped after cancellation, and is
  suppressed while the same DEBUG action is running.
- ERR is considered only for a normal, status-bearing non-zero outcome. Its
  suppression bit is derived from the same `ignore_errexit`/condition/pipeline
  context that controls errexit; the implementation must not maintain a second
  hand-written suppression tree. Capture the errexit decision before running
  ERR, then apply it after ERR returns.
- A normal handler status never replaces the triggering command, pipeline, or
  boundary status. Before dispatch, publish the trigger status; after dispatch,
  restore the trigger status and the complete pipeline vector. Explicit
  `return` or `exit` from a handler changes control flow deliberately and
  bypasses re-entry of the same boundary.
- RETURN dispatches while the function or source frame is live. The handler
  sees that frame's positional/stack view; frame drop still restores locals,
  positionals, call-stack entries, and retained allocations. Nested function
  returns produce nested RETURN events; a source boundary is separate.
- EXIT is dispatched once by the root session owner, after the root reader has
  its final outcome and before final group completion. Child snapshots may
  retain/query EXIT registration, but child completion does not fire the root
  EXIT event. Cancellation skips new trap work and preserves the existing
  cancellation status.
- Each dispatch captures an `Rc<Action>` before evaluating its text. A handler
  that changes its own trap changes future events only. A value-level
  suppression mask prevents same-event recursion; it is copied in `Context` and
  adds no heap object to the no-handler path.
- Action storage remains registration-owned. Dispatch admits nested evaluation
  before side effects; failed admission runs no partial handler and returns a
  typed resource outcome. Temporary execution allocations refund on drop.
  `Rc<Action>` storage refunds only after the final parent/child reference is
  gone, preserving the existing `state/traps.rs:239-257` behavior.
- Snapshot visibility is the existing trap snapshot policy, not a new shared
  event queue. Functions and sources use their live state; isolated children
  use the copied, inherited trap set; process-substitution resets remain the
  rules already encoded in `Traps::process_substitution`.

The minimal domain shape is:

```rust
enum TrapEvent { Debug, Err, Return, Exit }
enum Boundary { Function, Source }
struct TrapMask(u8); // value copied in Context
struct Trigger { event: TrapEvent, status: i32, pipeline: PipelineStatus }
struct TrapResult { outcome: Outcome, explicit_flow: bool }
```

The public seam is four methods, not a public trap storage schema. `TrapResult`
keeps handler control flow distinct from ordinary handler status, so the
interpreter can preserve the original trigger without guessing from an integer.

## Frozen causal acceptance scaffold

Freeze scripts and expected traces across Oils, Brush, and Bashkit before bulk
implementation. Every row must record stdout, stderr, final status, event
order, and pipeline status; a pass in one family is not a contract for the
others.

| Row | Causal question | Required trace |
|---|---|---|
| DEBUG simple/pipeline | Which command sites are eligible, including non-last stages? | One DEBUG event per accepted site, no aggregate duplicate |
| ERR condition/`!`/pipeline | Does ERR use the existing errexit suppression boundary? | Suppressed exactly where errexit is ignored; fires once otherwise |
| function/source RETURN | Is the frame visible and restored after dispatch? | Handler sees live frame; nested boundaries order inside-out |
| EXIT root/child | Who owns termination and how many times? | One root EXIT, no child duplicate |
| handler mutation | Does the current event use the captured action? | Old action runs now; new action runs next event |
| status/pipeline | Can a handler overwrite `$?`/`PIPESTATUS` accidentally? | Trigger status/vector restored; explicit flow is the only override |
| cancellation | Does Ctrl+C stop new trap work? | No newly admitted handler; existing cancel status survives |
| resource admission | Is dispatch atomic? | No partial handler output/effects; typed resource result; refunds at unwind |
| snapshot isolation | Can parent mutation rewrite a child action? | Child uses its captured binding; child mutation does not mutate parent |
| noexec | What is observable without command execution? | Freeze DEBUG/ERR behavior explicitly before implementing the gate; no current-main claim |

## Touch set and ownership

The first implementation should touch only the lifecycle seam and its tests:
`interpreter.rs` for the four calls and precomputed errexit/status snapshots,
`interpreter/source.rs` for source-boundary ordering, `state/traps.rs` only for
execution-facing binding capture if needed, and a focused lifecycle test module
under `shell/engine/src/interpreter/`. Keep `builtins/trap.rs` registration
semantics unchanged. Do not touch package manifests, locks, fixture identity,
CI/scripts, versions, or closed PR78 metadata in this layer. Signal delivery,
noexec implementation, and a general runtime rewrite are outside this contract.

The direct constraints above are source facts. The root-only EXIT rule,
handler-flow merge, same-event suppression mask, and noexec row are design
constraints to validate against the frozen family matrix before broad code lands.
