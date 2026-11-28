# Trap registration

`trap` in `bash-web` runs in containment mode. The builtin supports read-only queries, signal listing, resets, and registration for the uncatchable signals `SIGKILL` and `SIGSTOP`. Any attempt to install a handler or an ignore disposition for a catchable signal or a pseudo-signal fails with status `1` and writes an explicit diagnostic to stderr. Actual trap execution belongs to the GNU Bash on Waffle fork milestone.

## Supported operations

`shell/engine/src/builtins/trap.rs` accepts signal numbers `0` through `64`, case-insensitive names with or without a `SIG` prefix, `RTMIN+0` through `RTMIN+30`, `RTMAX-14` through `RTMAX`, and the bare pseudo-signal names `EXIT`, `DEBUG`, `ERR`, and `RETURN`. These invocations fail with status `2` and write a diagnostic or usage line to stderr: an unknown option, both `-p` and `-P` together, `-P` with no signal operand, or `trap -` with no signal operand.

- **Listing.** `trap -l` prints signals `1` through `64`, skips `32` and `33`, formats five entries per line as `<number>) <NAME>`, and exits `0`.
- **Queries.** `trap` with no operands and `trap -p` print every stored binding as a reusable `trap -- '<action>' <NAME>` line. The formatter escapes embedded single quotes as `'\''` and prints a bare single quote as `trap -- \' <NAME>`. `trap -P <signal> ...` prints only each stored action string followed by a newline, writes an empty line for an ignored binding, and omits unbound signals. An unrecognized signal operand writes `trap: <operand>: invalid signal specification` to stderr and exits `1`.
- **Resets.** `trap - <signal> ...`, `trap <signal>`, and `trap <number> ...` clear bindings to default across catchable signals, pseudo-signals, `SIGKILL`, and `SIGSTOP`. A reset runs when the first operand is `-`, when the first operand is an ASCII decimal number that names a valid signal, or when there is a single operand that names a valid signal. Clearing a stored action releases its reference, and the engine refunds the retained memory reservation when the last `Rc<Action>` reference drops, including references held by isolated snapshots.
- **Uncatchable signal compatibility.** `trap` accepts nonempty action strings and empty-string `''` bindings for signal `9`, `SIGKILL`, and signal `19`, `SIGSTOP`. Those bindings stay stored, appear in `trap`, `trap -p`, and `trap -P`, and clear on reset. Action text reserves retained storage through `admit_temporary` in `shell/engine/src/builtins/trap.rs`. Any stored trap binding also disqualifies automatic tail-command `exec` replacement in `shell/engine/src/interpreter/replacement.rs`.

## Containment diagnostics for catchable and pseudo-signals

For every signal other than `9` and `19`, `trap` rejects every non-reset binding. That rejection covers both nonempty handler strings and empty-string `''` ignore attempts on all catchable signals and on `EXIT`, `ERR`, `DEBUG`, and `RETURN`.

When a script runs `trap 'echo bye' EXIT` or `trap '' INT`, `trap` writes this diagnostic to stderr for each rejected operand, stores no binding for that operand, and exits `1`:

```text
trap: <operand>: trap execution is unsupported
```

When one call mixes allowed operands with rejected or invalid operands, `trap` processes every operand in order. It applies valid `SIGKILL` and `SIGSTOP` bindings, prints one diagnostic per rejected or invalid operand, and exits `1`.

Because attempted ignores fail instead of storing a silent disposition, self-targeted `kill` keeps Waffle's default signal dispositions rather than consulting `trap` state. See [Shell PID and self-signals](self-signals.md).

## What is left out

No event runs a stored trap action in this Rust engine. These features are unsupported:

- Running `EXIT`, `ERR`, `DEBUG`, `RETURN`, or signal handlers.
- Installing ignore dispositions or changing OS and external signal dispositions through `trap`.
- `errtrace` via `set -E` and `functrace` via `set -T`.
- Diagnostic source-line parity and trap-specific syntax-error reporting.

Actual trap execution and real signal dispositions wait for the GNU Bash on Waffle fork milestone.

## Historical Bashkit-era registration observations

Earlier Bashkit-era work in `bash-web` stored and printed bindings for catchable signals and pseudo-signals without running actions. That phase modeled GNU Bash 5.3.15 registration and visibility rules in `shell/engine/src/state/traps.rs`:

- Subshells, pipeline stages, background commands, and command substitutions kept inherited bindings query-visible until the first mutating `trap` call, which cleared inherited handlers and ignored `DEBUG`, `ERR`, and `RETURN` bindings while keeping ignored `EXIT` and real signal bindings.
- Process substitutions reset active `EXIT` and caught signal bindings, kept ignored real signals, and kept `DEBUG`, `ERR`, and `RETURN` bindings. A process substitution under an ordinary child with a pending deferred reset kept that reset, `EXIT`, and caught signals other than `INT`, `QUIT`, and `CHLD`.
- An inherited ignored `EXIT` that survived an ordinary child's mutation stayed visible through nested process substitutions until set again.
- An active-parent process substitution hid implicit `INT` and `QUIT` ignores until a reset or handler assignment cleared that provenance.

The `Traps` state machine and its eight unit tests remain in `shell/engine/src/state/traps.rs`, though the contained `trap` builtin no longer permits registering catchable or pseudo-signal bindings.

Two frozen artifacts preserve that historical record and remain untouched:

- `scripts/fixtures/shell-trap-registration.json` holds 251 local GNU Bash 5.3.15 registration-only observations. Those rows come from 57 original cases, 39 initial repair cases, 77 nested-parent cases, and 78 implicit-ignore cases.
- The [correction receipt](evidence/trap-registration-repair.json) records native and production-Waffle pass counts from that phase. It also documents four coincidental frozen-score gains that matched stdout and status without proving that traps run or that ignored signals stay ignored.

CI never invokes host Bash as an oracle, and the current replay test no longer replays `scripts/fixtures/shell-trap-registration.json`.

## Verification

Four test suites check current containment behavior against the working code:

- `shell/engine/src/interpreter/trap_tests.rs` checks that registering `EXIT`, `ERR`, `RETURN`, `DEBUG`, `INT`, and `TERM` returns status `1`, writes `trap: <operand>: trap execution is unsupported`, leaves `trap -p` empty, leaks no execution storage, and runs no action on `exit 4`. It also checks that a `KILL` action survives an interrupted command and refunds storage on `trap - KILL`.
- `shell/engine/tests/trap_registration.rs` runs the native `shell-engine` binary to check `KILL` and `STOP` registration, `-P` and `-p` queries, and reset.
- `scripts/replay/test-own-shell-trap-registration.ts` runs the release WASI shell to check status `1` rejection for `EXIT`, `ERR`, `RETURN`, `DEBUG`, `INT`, `TERM`, `HUP`, and `QUIT`, read-only `-p`, `-P`, and `-l` output, and `KILL` and `STOP` registration and reset.
- `shell/engine/src/builtins/trap.rs` checks action storage admission and refund, and `shell/engine/src/runtime/tests/exec.rs` checks that a rejected `trap : EXIT` leaves tail-command `exec` eligible while a retained `trap : KILL` disqualifies it.
