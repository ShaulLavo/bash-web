# Shell PID and self-signals

The runtime-backed shell exposes its Waffle process ID through `$$`, `${$}`, and `BASHPID`, and delivers self-targeted and external signals through Waffle's `proc_signal` ABI. Implementation lives in `shell/engine/src/builtins.rs`, `shell/engine/src/interpreter.rs`, `shell/engine/src/runtime.rs`, `shell/engine/src/runtime/wasi.rs`, and `shell/engine/src/runtime_main.rs`.

## PID expansion

`$$` and `${$}` expand to the shell's Waffle process ID, including inside selected parameter operands such as `${value:-$$}`. Subshells and command substitutions keep the root shell's `$$`, matching GNU Bash.

`BASHPID` reports the current Waffle guest PID. Assigning to `BASHPID` does not replace the active PID hook, while `unset BASHPID` removes that hook so later expansions are empty. Because engine subshells run as tasks inside the same Waffle guest, they do not get distinct forked `BASHPID` values.

Engine-only embeddings supply the shell PID through `ProcessHost::shell_pid`. When no host supplies a PID, `$$` and `BASHPID` expand to empty strings.

## Self-signals with `kill`

`kill` accepts signal `0` and terminating signals `HUP` as `1`, `INT` as `2`, `QUIT` as `3`, `KILL` as `9`, and `TERM` as `15`, by number or case-insensitive name with an optional `SIG` prefix. Other recognized signal names, namely `CHLD`, `CONT`, `STOP`, `TSTP`, `TTIN`, `TTOU`, `USR1`, `USR2`, `ALRM`, and `PIPE`, and other numbers from `4` through `127` fail with status `2` and print `kill: unsupported signal action`. Unknown names or out-of-range numbers fail with status `1` and print `kill: invalid signal`. Invalid argument syntax fails with status `2`.

When the target operand matches `$$`:

- `kill -0 $$` succeeds with status `0` without delivering a signal.
- Self-targets always check the root shell's trap table, even when `kill` runs inside an isolated child such as a subshell.
- If the root shell ignores that signal and the signal is neither `KILL` nor `STOP`, `kill` returns status `0` without calling `signal_self`.
- If the root shell has a registered trap handler for that signal, `trap` has already set Waffle's process disposition to `Handle` via `proc_signal` mode `2`. `kill` calls `signal_self` via `proc_signal` mode `3`, `Runtime::signal_self` collects the signal immediately, and the root shell runs the handler at the command boundary before the next command executes. See [Trap registration and execution](trap-registration.md#root-signal-delivery-through-waffle).
- If the signal keeps its default disposition, or is `SIGKILL`, `signal_self` delivers it through Waffle. In a noninteractive shell, default `INT` and `TERM` terminate the shell with tagged signal outcomes, `kind: "signaled"` with code `2` or `15` and status `130` or `143`, and run no later commands. An ordinary `exit 130` or `exit 143` remains an ordinary exit with `kind: "exited"`.

Interactive shells register an initial `SIGINT` handler on startup via `WasiAbi::handle_interrupts` and keep that interrupt behavior even after `trap - INT`.

After observing self-termination, the caller still owns closing and reaping the shell's runtime job and any separately grouped background children. Independent sibling jobs survive.

## External root signal delivery

External callers, such as Waffle's `processes().kill(pid, signal)`, deliver signals to the root shell through the same Waffle disposition and interrupt queue. When the root shell has a handler registered for a signal:

- The delivered signal wakes a blocking `read` or interruptible `wait` on a user job with status `128 + signal` without terminating a waited-on child.
- The root shell runs the handler at the next command boundary, at foreground completion ahead of any `EXIT` trap, or while idle at an interactive prompt.

## Other `kill` operands and limits

Other numeric `kill` operands remain synthetic async job handles, including `$!`. The handle allocator excludes the shell's PID so an async handle cannot alias `$$`. `%job` operands continue to signal shell job groups.

The following are not supported:

- Arbitrary external OS or runtime PID operands.
- Process-group targets.
- Multiple target operands in one `kill` invocation.
- Signal-trap delivery inside isolated child environments, including subshells, pipeline stages, background jobs, command substitutions, and process substitutions.

## Verification

Native runtime tests in `shell/engine/src/runtime/tests.rs` check `$$` and `BASHPID` expansion, snapshot inheritance, ignored and caught self-signal dispatch, and non-aliasing async handles.

`scripts/replay/runtime/test-own-shell-self-signal.ts` runs the installed Waffle launcher and checks:

- Ordinary exits with codes `2`, `130`, and `143`.
- Ignored self-signals, including from a subshell that resets its local copy, and caught self-signals running their handler before the next command.
- External delivery of `INT`, `TERM`, `HUP`, and `QUIT` running handlers before `EXIT`.
- A caught `TERM` interrupting `wait` with status `143` without terminating the waited-on background child.
- Default `INT` and `TERM` self-signals publishing tagged signal outcomes, descendant cleanup, and a surviving sibling.

Noninteractive `$$` expansion and default self-signal termination were originally compared against GNU Bash 5.3.15.
