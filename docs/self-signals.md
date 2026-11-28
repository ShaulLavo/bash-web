# Shell PID and self-signals

The runtime-backed shell expands `$$` and `${$}` to its Waffle process ID.
Subshells and command substitutions retain that identity, as GNU Bash does.
The same expansion works inside a selected parameter operand, such as `${value:-$$}`.
`BASHPID` reports the current Waffle guest PID. Assigning it does not replace the
active PID hook; unsetting it removes that hook. Engine subshells are tasks in
the same guest, so they do not get GNU Bash's distinct forked `BASHPID` values.
An engine-only embedding supplies this identity through `ProcessHost::shell_pid`.
Without a supplied identity, the expansion is empty.

`kill -0 $$` succeeds without sending a signal. Supported terminating signals
sent to that PID use Waffle's self-signal operation. A noninteractive shell keeps
the default INT and TERM dispositions, so `kill -INT $$` and `kill -TERM $$`
publish tagged signal outcomes and execute no later commands. An ordinary
`exit 130` or `exit 143` remains an ordinary exit with that numeric status.
Interactive shells retain their existing interrupt handler.
The caller still owns cleanup. After observing self-termination, it closes and
reaps the shell's runtime job and any separately grouped background children.
Independent sibling jobs survive.

Other numeric kill operands remain synthetic async handles, including `$!`.
The allocator excludes the shell's PID so a handle cannot alias a self-signal.
`%job` operands retain job-group signaling. Arbitrary OS or runtime PID operands,
process-group operands, multiple targets, and signal-trap execution are outside
this support. Self-targets consult the root shell's trap registration, even from
an isolated child. An ignored signal returns success without delivery. A caught
signal returns unsupported status 2 without executing the registered action.
SIGKILL always retains its default action. External signal disposition changes
from trap registration remain unsupported.

Native runtime controls check expansion, snapshot inheritance, signal dispatch,
and distinct async handles. `scripts/replay/runtime/test-own-shell-self-signal.ts` runs the real
installed launcher with ordinary exit controls, tagged INT and TERM outcomes,
descendant cleanup, and a surviving sibling. GNU Bash 5.3.15 provides the direct
noninteractive comparison for PID expansion and self-signals.
