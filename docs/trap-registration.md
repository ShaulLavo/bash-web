# Trap registration and execution

`trap` stores default, ignored, and handler bindings across 68 slots in `shell/engine/src/state/traps.rs` and `shell/engine/src/builtins/trap.rs`. Execution lives in `shell/engine/src/interpreter/trap_action.rs`, with host signal wiring in `shell/engine/src/runtime.rs`, `shell/engine/src/runtime/wasi.rs`, and `shell/engine/src/runtime_main.rs`.

## Registration, query, and storage

`trap` accepts signal names, numeric aliases from `0` through `64`, resets, `--`, `-p`, `-P`, and `-l`. A reset uses `-` as the action, passes a single signal specification, or starts with a numeric signal. Signal names match case-insensitively with or without a `SIG` prefix for signals `1` through `64`, and `RTMIN+0` through `RTMIN+30` map to slots `34` through `64`. The special slots are `EXIT` at `0`, `DEBUG` at `65`, `ERR` at `66`, and `RETURN` at `67`.

- Combining `-p` and `-P` fails with status `2`.
- Passing `-P` without a signal specification fails with status `2`.
- Unknown options fail with status `2` and print the `trap` usage line.
- Invalid signal specifications fail with status `1`, while remaining operands still run.
- Default printing with `trap` or `trap -p` quotes actions so they can be read again, using `trap -- '...' NAME`, or `trap -- \' NAME` for a single apostrophe. `trap -P` prints the raw action text.

Action text reserves memory on the shell storage budget when registered. Isolated state snapshots share the retained `Action` handle, and the reservation refunds only when the last reference drops, including references held by child snapshots. A failed storage admission leaves existing bindings and the budget unchanged.

## Signal and event availability

Slot acceptance depends on the event and whether `trap` runs in the root shell or in an isolated child.

- **`EXIT`, `ERR`, and `RETURN`.** Registration, ignore, and reset all succeed in root and child environments.
- **`KILL` and `STOP`.** Registration, ignore, and reset on signal `9` and signal `19` succeed in root and child environments to preserve Bash registration compatibility. `trap` does not alter host signal dispositions for `9` or `19`, and `SIGKILL` and `SIGSTOP` still cannot be ignored or caught on delivery.
- **`DEBUG`.** Only resets such as `trap - DEBUG` or `trap DEBUG` succeed. Setting a handler or ignore fails with status `1`, prints `trap: <name>: trap execution is unsupported in this shell`, and leaves the binding unchanged.
- **Root signals `1` through `64`, excluding `9` and `19`.** The root shell sends `Default`, `Ignore`, and `Handle` dispositions to `ProcessHost::signal_disposition`. If the host rejects a disposition, `trap` fails with status `1`, prints `trap: <name>: trap execution is unsupported in this shell`, and leaves the binding unchanged.
- **Child signals `1` through `64`, excluding `9` and `19`.** Isolated children accept resets on any signal and accept `INT`, signal `2`, registration or ignore for compatibility without modifying the root process disposition. Non-reset registrations on other real signals fail with status `1` and the same unsupported diagnostic.

## Inheritance, tracing, and process substitutions

Ordinary isolated children, meaning subshells, pipeline stages, background commands, and command substitutions, inherit bindings with all slots marked inactive. Inherited handlers stay visible to `trap -p` without executing.

On the first mutating `trap` call in an ordinary child, the engine clears inherited `EXIT` and signal handlers, and clears untraced `DEBUG`, `ERR`, and `RETURN` bindings for both handlers and ignores. Ignored `EXIT` bindings, ignored real signals, and traced special bindings survive that mutation.

When an isolated child starts, `errtrace`, enabled via `set -E`, `set -o errtrace`, or `shopt -s extdebug`, activates inherited `ERR` bindings. Either `functrace`, enabled via `set -T` or `set -o functrace`, or `shopt -s extdebug` activates inherited `RETURN` bindings. That tracing flag also marks inherited `DEBUG` registrations as traced, though `DEBUG` still does not execute.

Shell functions hide untraced `ERR` bindings when `errtrace` is off, and hide untraced `DEBUG` and `RETURN` bindings when both `functrace` and `extdebug` are off. When a function returns, the engine restores each hidden binding unless the function modified that slot.

Process substitutions start with all slots inactive, activate traced special bindings on start, and follow these registration rules:

- From an active parent, a process substitution resets active `EXIT` bindings and caught real-signal bindings, keeps ignored real signals, and retains `DEBUG`, `ERR`, and `RETURN` registrations.
- From an ordinary child whose deferred reset has not fired, a process substitution keeps that deferred reset and `EXIT`, and keeps caught signals other than `INT`, `QUIT`, and `CHLD`. Its first mutating `trap` call then clears the inherited bindings.
- An inherited ignored `EXIT` that survived an ordinary child's mutation remains visible through nested process substitutions until `EXIT` is set again.
- From an active parent, a process substitution implicitly ignores `INT` and `QUIT` without printing a binding. Repeating an empty ignore keeps the implicit ignore hidden. Resetting the signal or assigning a handler clears that provenance, so a later explicit ignore prints. Root explicit ignores stay visible. An ordinary child clears implicit-ignore provenance, while nested process substitutions keep it. A parent whose ordinary-child reset is still deferred lets its process substitution's first explicit ignore print.

## Trap execution

A trap event never re-enters itself while already active, and cancelled contexts skip dispatch. Before running an action, the engine saves `$?` and `PIPESTATUS` against execution storage, sets `$?` to the triggering status, disables tail-call `exec`, and evaluates the action string through `eval::read` with source name `trap`.

If the handler completes with normal control flow, the engine restores `$?` and `PIPESTATUS` and keeps the triggering outcome. If the handler leaves with `exit`, `return`, `break`, `continue`, or an abort, that outcome replaces the triggering outcome. If parsing or evaluating the action fails, the engine prints the diagnostic and returns the triggering outcome.

### EXIT

In the root shell, an active `EXIT` handler runs on explicit `exit`, at the end of a `-c` command string, at the end of a named script file, and when a persistent or interactive shell finishes on EOF through `Session::finish`. Persistent `Session::start` submissions do not run `EXIT` at submission end unless `exit` was requested. Pending root signal traps run before `EXIT` at foreground completion.

Inside an `EXIT` handler, `exit` with no argument preserves the triggering exit status. Passing `exit N` replaces the final shell exit status with `N` modulo 256.

Isolated children, including subshells, command substitutions, process substitutions, isolated pipeline stages, and background commands, run their own `EXIT` handler before completing. Inherited `EXIT` handlers remain inactive and do not run in children. For an isolated pipeline stage or background command consisting of a single literal simple command, the engine skips retaining child state for `EXIT` unless the command is a shell function or one of `eval`, `source`, `.`, `command`, `builtin`, or `trap`.

### ERR

The engine dispatches `ERR` at command boundaries for the same commands that `set -e` checks: simple commands, non-negated pipelines, `((...))`, `[[...]]`, and subshells. Failures where `errexit` is suppressed do not trigger `ERR`, including `if`, `while`, and `until` conditions, negated pipelines, and the left side of `&&` or `||`.

Only commands that finish with normal flow and a non-zero exit status trigger `ERR`. Under `set -e`, `ERR` still runs before the abort unwinds to `EXIT`. Pending root signal traps run before `ERR` at the command boundary, and if a signal handler changes the flow or status, `ERR` is skipped. Inside functions and isolated children, `ERR` runs only when `errtrace` or `extdebug` is enabled, or when that scope set its own `ERR` handler.

### RETURN

The engine dispatches `RETURN` at the end of a shell function or a `source` or `.` file when execution completes with normal flow or `return`. Dispatch happens before the frame unwinds:

- Inside a function, the `RETURN` handler sees the function's `local` variables before they are restored.
- Inside a sourced file, the `RETURN` handler runs before the source frame unwinds.

`RETURN` does not run when a sourced file fails to parse or when execution leaves via `exit` or an abort. Inside functions and isolated children, inherited `RETURN` traps run only when `functrace` or `extdebug` is enabled.

### Root signal delivery through Waffle

In a Waffle-backed root shell, `trap` maps `Default`, `Ignore`, and `Handle` bindings to Waffle `proc_signal` modes `0`, `1`, and `2`. When resetting a signal that the guest registered at startup, `SIGINT` in interactive shells or `SIGWINCH` when `--prompt-host` is active, `WasiAbi::signal_disposition` keeps host mode `Handle` so built-in interrupt and window-resize handling continue working while `Runtime` clears the signal from its trapped set and drops any pending trap bit for it.

`Runtime::collect_signals` drains delivered signals from `WasiAbi::interrupted()`. Signals in the trapped set are queued in `pending_traps` and cancel `trap_signal_ready`. The root shell drains queued signals in ascending signal-number order at command boundaries, at foreground completion, and while idle at an interactive prompt. At an idle prompt, `runtime_main.rs` wakes the editor with `Wake::Trap` and calls `Session::dispatch_pending_traps` without overwriting `$?` to `130`. If a handler changes control flow, draining stops and that flow takes over.

Blocking `read` and interruptible `wait` on user jobs wake when `trap_signal_ready` fires and return `128 + signal` without terminating a waited-on child. The queued signal handler then runs at the command boundary with `$?` equal to `128 + signal`. See [Shell PID and self-signals](self-signals.md) for `kill` targeting `$$` and external signal delivery.

## Left out

- `DEBUG` trap execution and non-reset registration. Only resets are accepted.
- Signal trap execution inside isolated child environments, including subshells, pipeline stages, background jobs, command substitutions, and process substitutions. Non-reset child registrations for real signals other than `INT`, `KILL`, and `STOP` fail with status `1`.
- Diagnostic source-line parity and trap-specific syntax-error reporting parity with GNU Bash.
- Bash's separate quirk when ignoring `EXIT` again in a child after clearing an inherited `EXIT` binding.

## Verification and historical controls

Current execution behavior is checked by native session and runtime tests in `shell/engine/src/interpreter/trap_tests.rs` and `shell/engine/src/runtime/tests.rs`, plus Waffle launcher tests in `scripts/replay/runtime/test-own-shell-self-signal.ts`. Those suites cover persistent `EXIT`, `-c` and EOF `EXIT`, `ERR` with `errexit` before `EXIT`, traced `RETURN` reading function locals before unwind, retained storage refunds, self-targeted and externally delivered `INT`, `TERM`, `HUP`, and `QUIT` handlers running before `EXIT`, and a caught `TERM` interrupting `wait` without killing its child.

The pinned fixture `scripts/fixtures/shell-trap-registration.json` and the [correction receipt](evidence/trap-registration-repair.json) remain historical registration-only controls recorded against local GNU Bash 5.3.15 for rows whose output cannot depend on an action running. The fixture holds 251 observations in total: the original 57 rows, 39 repair rows, 77 nested-parent rows, and 78 implicit-ignore rows. Native tests in `shell/engine/tests/trap_registration.rs` and Waffle tests in `scripts/replay/test-own-shell-trap-registration.ts` replay all 251 rows. For the 63 rows listed in `scripts/owned-fixtures/trap-registration-rejections.json`, those tests assert the `trap execution is unsupported in this shell` diagnostic. For the remaining 188 rows, they compare status and stdout against the Bash recording and require empty stderr when Bash produced none. CI does not invoke host Bash as an oracle.
