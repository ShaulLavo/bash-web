# Trap execution contract

## Caller usage

```rust
// Sketch. Planning is synchronous; only an executable action gets a reader.
let plan = traps::before(&command, &state, &context)?;
let decision = traps::enter(plan, &state, &fds, &context).await;
let outcome = execute_or_transfer(decision, command, ...).await;
let outcome = traps::after(outcome, failure_policy, ...).await;
// Function/source owners call returning(...) before their existing frame restores.
// Each isolated supervisor calls completing(...) before releasing its descriptors.
// Persistent embedders call Session::finish(status) at actual EOF, not per start().
```

Status: awaiting parent acceptance before bulk handler code. This replaces the
incorrect root-only EXIT rule in the first draft. The stored bindings currently
execute no actions. The study's 173 candidates and 130–170 estimate are not gains.

## Ownership and transitions

Use a private `interpreter/traps.rs` module, the existing `Outcome`/`Flow`, and a
small event mask and outer-command DEBUG marker in `Context`. A synchronous
plan captures `Rc<Action>`
only for an executable binding. No handler action, saved status vector, or trap
reader belongs in the ordinary command future. Registration retains action
storage; dispatch never clones a value-level `State`. Isolated children continue
to use admitted `State::snapshot`; `SharedState` clones only share a handle.

| Boundary | Contract |
|---|---|
| DEBUG | Before eligible simple, arithmetic/test and frozen loop sites. A pipeline emits each outer stage event in its parent launcher, using parent FDs before expansion/dispatch. An already-run marker applies only to that outer command, not nested bodies. |
| DEBUG result | Normal mode ignores ordinary handler status. Under extdebug, nonzero means Skip; status 2 requests return only at an active function/source boundary. Explicit exit transfers. Represent Execute/Skip/Transfer, not an integer convention at callers. |
| ERR | Ordinary nonzero failure uses the same structural eligibility as errexit, including conditions, negation, AND/OR lists and pipeline stages, even with `-e` off. Dispatch ERR before applying the captured errexit decision. Redirect/setup failure shares that classifier. Avoid aggregate/stage duplicates. |
| RETURN | Function/source completion runs while locals, positionals and call stack remain live, before the existing restore/drop. Eval completion alone is not RETURN. Restore scoped DEBUG/RETURN bindings; ERR changes use the function-scope merge policy frozen by `trap-scope:81`. |
| EXIT | Once per executing shell environment. Inherited parent EXIT stays query-only; a child-installed handler runs at that child's completion. Open → Running → Finished prevents nested exit and later EOF from repeating the event. Shared lastpipe is not another environment. |
| actual EOF | Add idempotent `Session::finish(status)`. Explicit exit and terminating fatal outcomes use the same completion owner; reject later submissions. Migrate runtime `-c`, both interactive EOF paths and compat together. Keep executor/drains alive until completion finishes, then shutdown. |
| child completion | Subshell, background, isolated pipeline, command/process substitution owners finish language execution and EXIT before fd release, capture-EOF wait, scope/group reap. Release writers before waiting for capture EOF. |

Minimal private choices are `Event`, `Mask`, `DebugDecision`, a captured action
plan and a completion gate owned by Core for the root or its child supervisor.
Keep policy in that module, with no
public event bus, general lifecycle framework, signal synthesis or async Drop.

Before handler evaluation publish trigger `$?` and the original complete
`PIPESTATUS`. Admit its saved copy only on the action path. Normal completion
restores both; explicit return/exit transfers preserve deliberate flow/status.
Capture the action before running it, so replacing/resetting that binding changes
future events only. Mask same-kind reentry in the executing context. Function
trap restoration and status restoration must survive a dropped handler future.

Admission before dispatch covers source/parse/reader/task storage, saved status
capacity and dispatch-owned descriptor references. Failure at entry performs no
handler side effects and returns typed Resource. This is not a transaction for
the whole handler: later resource failure preserves completed user side effects,
but unwinds structural frames and refunds owned storage. Cancellation admits no
new handler and never evaluates user code during Drop; existing owners still
cancel, close, drain and reap. No whole-handler rollback is promised.

## Evidence and acceptance

Direct anchors at `9fc1cdb`: `interpreter.rs:1119-1161` owns command/errexit;
`:1270-1303` pipeline contexts; `:2003-2062` subshell snapshots;
`:800-825` submission completion; `state.rs:465-474` inherited trap snapshots;
`state/traps.rs:35-96` visibility/reset; `interpreter/source.rs:74-99` restore;
`interpreter.rs:3276-3404` function-frame lifetime. Completion ownership and the
small planning API above are design inferences, not existing implementation.

The first executable scaffold is `shell/engine/tests/trap_lifecycle.rs`, copied
from unchanged frozen oracle rows, not a new Bash recording. It spans Oils EXIT,
Brush child EXIT/query/background/DEBUG, and Bashkit ERR suppression plus live
function/source RETURN. Missing behavior is explicitly ignored pending this
contract and can be run with `--ignored`; passing suppression controls stay on.
Next causal checks cover handler-replaces-handler, nested return/exit, lastpipe,
original PIPESTATUS, pre-entry admission failure, cancellation while blocked,
post-side-effect resource failure, snapshot isolation and final refunds.

Unknowns to freeze before claiming support: cross-kind reentry, children created
inside handlers, nested trap mutation/explicit RETURN transfers, top-level
extdebug status 2, EXIT visibility after function unwind, and noexec. The current
engine has no noexec execution gate. Do not infer these answers from the small
matrix or claim Bash command/location metadata already exists.

## Coordinated touch set

This draft touches only this note and the new integration test file. Planned
source regions are Context/command dispatch/failure policy/function calls/child
supervisors in `interpreter.rs`, `interpreter/source.rs`, `interpreter/eval.rs`,
`state/traps.rs`, `runtime_main.rs` and `compat.rs`. Reuse the existing
State status/PIPESTATUS accessors; no new State/Snapshot fields, initializers or
clone-caller changes are planned. Variable lookup/storage/prefix,
assignment helpers, bindings and typed references remain with their owner.
Package/locks/versions, fixture identity, CI and generated evidence are untouched.
EOF callers must migrate together; separate handler fixes and root-only EXIT
are rejected because they leave a wrong owner at real termination.
