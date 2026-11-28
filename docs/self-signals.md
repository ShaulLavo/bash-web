# Shell PID and self-signals

The runtime-backed shell expands `$$` and `${$}` to its Waffle process ID from `WasiAbi::shell_pid` in `shell/engine/src/runtime/wasi.rs`. Subshells and command substitutions copy that `shell_pid` into their state snapshots, so `$$` keeps the root shell PID as GNU Bash does. The same expansion works inside a selected parameter operand, such as `${value:-$$}`.

`BASHPID` reads `shell_pid` dynamically in `shell/engine/src/state.rs` while its special hook is active. Assigning to `BASHPID` does not replace that hook, and `unset BASHPID` disables the hook. Engine subshells run as async tasks inside the same Waffle guest rather than forked processes, so `BASHPID` reports the guest PID instead of GNU Bash's distinct forked subshell PIDs. An engine-only embedding supplies the PID through `ProcessHost::shell_pid`. Without a supplied PID, `$$` and `BASHPID` expand to empty strings.

## Default Waffle self-signal dispositions

When `kill` targets the shell's own PID, `Context::signal_shell` in `shell/engine/src/interpreter.rs` handles the call directly:

- `kill -0 $$` exits `0` without delivering a signal.
- Supported terminating signals are `HUP`, `INT`, `QUIT`, `KILL`, and `TERM`, numbered `1`, `2`, `3`, `9`, and `15`. Each calls `ProcessHost::signal_self`, which invokes Waffle's `proc_signal` self-signal operation in `shell/engine/src/runtime/wasi.rs`.
- Other recognized signals such as `CHLD`, `CONT`, `STOP`, `TSTP`, `TTIN`, `TTOU`, `USR1`, `USR2`, `ALRM`, `PIPE`, and numeric signals `4` through `127` outside `9` and `15` write `kill: unsupported signal action` to stderr and exit `2`. Invalid signal names write `kill: invalid signal` and exit `1`, and usage errors write `kill: invalid signal` and exit `2`.

`Context::signal_shell` does not consult `state.traps`. Because `trap` rejects new handlers and ignore attempts for every catchable signal with status `1`, no catchable signal disposition changes through `trap`. See [Trap registration](trap-registration.md).

A noninteractive shell keeps Waffle's default signal dispositions. Sending `kill -INT $$` or `kill -TERM $$` publishes a tagged signal outcome with code `2` and status `130` for `INT`, or code `15` and status `143` for `TERM`, and runs no later commands. A failed `trap '' INT` or `trap 'handler' INT` before `kill -INT $$` leaves the default disposition unchanged, so the self-signal still terminates the shell. An ordinary `exit 2`, `exit 130`, or `exit 143` stays an ordinary exit with that numeric code rather than a signaled outcome.

Interactive shells install Waffle's interrupt handler at startup through `abi.handle_interrupts()` in `shell/engine/src/runtime_main.rs`.

The caller owns process-group cleanup after self-termination. After observing the signaled outcome, the caller closes and reaps the shell's runtime job and any separately grouped background children. Independent sibling jobs keep running.

## Other targets and limits

Other numeric `kill` operands, including `$!`, name synthetic async job handles. The interpreter's job ID allocator skips `shell_pid` so an async handle cannot collide with a self-signal. `%job` operands retain job-group signaling.

These features are unsupported in this Rust engine:

- Arbitrary OS or runtime PID operands and process-group operands.
- Multiple target operands in one `kill` invocation.
- Changing signal dispositions through `trap` or running signal handlers.

Actual signal-trap execution and trap-driven signal dispositions wait for the GNU Bash on Waffle fork milestone.

## Verification

Native runtime unit tests in `shell/engine/src/runtime/tests.rs` check PID expansion, snapshot inheritance, `BASHPID` assignment and `unset`, distinct async job handles, `kill -0 $$`, and self-signal dispatch after rejected `trap` registrations.

`scripts/replay/runtime/test-own-shell-self-signal.ts` runs the installed WASI shell on Waffle. It checks ordinary exit controls for `2`, `130`, and `143`, rejected `trap` ignore and handler attempts followed by default `SIGINT` self-termination, tagged `INT` and `TERM` outcomes with no later command output, descendant cleanup, and a surviving sibling process. GNU Bash 5.3.15 provides the noninteractive comparison for PID expansion and default self-signal termination.
