# Trap registration

`trap` in `bash-web` runs in containment mode. The builtin supports signal listing, read-only queries, resets, and registrations for the uncatchable signals `SIGKILL` and `SIGSTOP`. Any attempt to bind a handler or an ignore disposition to a catchable signal or a pseudo-signal fails with status `1` and writes an explicit diagnostic to stderr.

## Signal specifications and options

`shell/engine/src/builtins/trap.rs` accepts signal numbers `0` through `64` after trimming ASCII whitespace. It accepts case-insensitive names with or without a `SIG` prefix for standard signals, `RTMIN`, `RTMIN+0` through `RTMIN+30`, and `RTMAX-14` through `RTMAX`, plus the bare pseudo-signal names `EXIT`, `DEBUG`, `ERR`, and `RETURN`. The parser accepts numeric `32` and `33` and rejects `SIG32` and `SIG33`. Option parsing stops at `--`, at `-`, or at the first operand that does not begin with `-`.

Option and usage errors write to stderr and exit `2`:

- An unknown option writes `trap: -<opt>: invalid option` and the usage line.
- Both `-p` and `-P` together write `trap: cannot specify both -p and -P`, even when `-l` is also set.
- `-P` with no signal operands writes `trap: -P requires at least one signal name`, even when `-l` is also set.
- `trap -` with no signal operands, or a single operand that does not name a valid signal, writes `trap: usage: trap [-Plp] [[action] signal_spec ...]`.

When `-l` is set without the `-p` and `-P` or bare `-P` errors above, `-l` takes precedence over `-p` and lists signals.

## Supported operations

- **Signal listing.** `trap -l` prints signals `1` through `64`, skips `32` and `33`, formats five entries per line as `<number>) <NAME>` separated by tabs, ends with a newline, and exits `0`.
- **Queries.** `trap` with no operands and `trap -p` print every stored `SIGKILL` and `SIGSTOP` binding as `trap -- '<action>' <NAME>`. The formatter escapes embedded single quotes as `'\''` and prints a bare single quote as `trap -- \' <NAME>`. `trap -P <signal> ...` prints only each stored action string followed by a newline, writes an empty line for an ignored `''` binding, and prints nothing for unbound signals. Because catchable signals and pseudo-signals hold no bindings, querying them prints nothing. An unrecognized signal operand writes `trap: <operand>: invalid signal specification` to stderr, sets the exit status to `1`, and continues to later operands.
- **Resets.** `trap - <signal> ...`, `trap <number> ...`, and `trap <signal>` clear bindings. Reset mode triggers when the first operand is `-`, when the first operand is a nonempty ASCII decimal integer that names a valid signal, or when there is a single operand that names a valid signal. Clearing a stored `SIGKILL` or `SIGSTOP` handler drops its `Rc<Action>` reference. The engine refunds the retained storage allocation when the last reference drops, including references held by child snapshots. Resetting a valid catchable signal or pseudo-signal exits `0` and runs `prepare_mutation` on `state.traps`.
- **Uncatchable signal bindings.** `trap` accepts nonempty action strings and empty-string `''` ignore bindings for signal `9`, `SIGKILL`, and signal `19`, `SIGSTOP`. Nonempty action text reserves retained storage through `admit_temporary` in `shell/engine/src/builtins/trap.rs`, while `''` stores `Binding::Ignored` without an `Action` allocation. Any stored `SIGKILL` or `SIGSTOP` binding disqualifies automatic tail-command `exec` replacement through `state.traps.is_empty()` in `shell/engine/src/interpreter/replacement.rs`.

## Snapshot and reset rules

`Traps` in `shell/engine/src/state/traps.rs` retains state only for `UncatchableSignal::Kill` and `UncatchableSignal::Stop`, plus a `reset_handlers_on_mutation` flag. It preserves GNU Bash snapshot and deferred-reset rules for those two signals:

- **Ordinary child snapshots.** `State::snapshot` in `shell/engine/src/state.rs` calls `Traps::inherited` for subshells, non-`lastpipe` pipeline stages, background commands, and command substitutions. Both handlers and `''` ignores remain query-visible in the child until the first mutating `trap` call runs `prepare_mutation`, which clears inherited `Binding::Handler` entries and keeps `Binding::Ignored` entries.
- **Process substitutions.** `Expansion::process_child` in `shell/engine/src/expand/command.rs` calls `Traps::process_substitution`. From an active parent with no pending deferred reset, `process_substitution` clears `SIGKILL` and `SIGSTOP` handlers immediately and keeps only `''` ignores. From an ordinary child that still has a pending deferred reset, `process_substitution` preserves both the inherited bindings and the deferred reset flag across nested process substitutions until a mutating `trap` call runs `prepare_mutation`.
- **When `prepare_mutation` runs.** `prepare_mutation` runs on every `SIGKILL` or `SIGSTOP` write or reset, on every valid catchable or pseudo-signal reset, and on every invalid signal operand during a mutation or reset call. A rejected catchable or pseudo-signal registration does not call `prepare_mutation`, so inherited `SIGKILL` and `SIGSTOP` bindings and any pending deferred reset remain intact.

## Containment diagnostics and unwritable stderr

For every valid signal other than `9` and `19`, `trap` rejects every non-reset binding. That rejection covers both nonempty action strings and empty-string `''` ignore attempts on all catchable signals and on `EXIT`, `ERR`, `DEBUG`, and `RETURN`.

When a script runs `trap 'echo bye' EXIT` or `trap '' INT`, `trap` writes this diagnostic to stderr for each rejected operand, stores no binding, and exits `1`:

```text
trap: <operand>: trap execution is unsupported
```

When one call mixes allowed, rejected, and invalid operands, `trap` processes every operand in order. It applies valid `SIGKILL` and `SIGSTOP` bindings, writes one diagnostic per rejected or invalid operand, and exits `1`.

`signal_diagnostic` in `shell/engine/src/builtins/trap.rs` writes per-operand `invalid signal specification` and `trap execution is unsupported` messages during queries, resets, and registrations. If stderr is unwritable, such as a read-only descriptor on fd `2`, `signal_diagnostic` ignores the write error so later operands still run and the command exits `1`. `signal_diagnostic` propagates interrupt status `130` and broken-pipe status `141` immediately and aborts the builtin.

Because attempted ignores fail instead of storing a silent disposition, self-targeted `kill` keeps Waffle's default signal dispositions rather than consulting `state.traps`. See [Shell PID and self-signals](self-signals.md).

## What is left out

No event runs a stored trap action in this Rust engine. These features are unsupported:

- Running `EXIT`, `ERR`, `DEBUG`, `RETURN`, or signal handlers.
- Installing ignore dispositions or changing OS and external signal dispositions through `trap`.
- `errtrace` through `set -E` and `functrace` through `set -T`.
- Diagnostic source-line parity and trap-specific syntax-error reporting.

Actual trap execution and real signal dispositions wait for the GNU Bash on Waffle fork milestone.

## Former Bashkit-era registration behavior and frozen artifacts

An earlier Bashkit-era phase of `bash-web` stored and printed bindings for catchable signals and pseudo-signals without running actions. That former wider state machine modeled GNU Bash 5.3.15 registration and visibility rules across all signals, including inherited ignored `EXIT` bindings, catchable signal and pseudo-signal deferred resets, and implicit `INT` and `QUIT` ignore provenance in process substitutions.

Two frozen artifacts preserve that historical record and remain untouched:

- `scripts/fixtures/shell-trap-registration.json` holds 251 local GNU Bash 5.3.15 registration-only observations. Those rows come from 57 original cases, 39 initial repair cases, 77 nested-parent cases, and 78 implicit-ignore cases.
- The [correction receipt](evidence/trap-registration-repair.json) records native and production-Waffle pass counts from that former phase. It also documents four coincidental frozen-score gains that matched stdout and status without proving that traps run or that ignored signals stay ignored.

`scripts/replay/test-own-shell-trap-registration.ts` replays 30 applicable rows from `scripts/fixtures/shell-trap-registration.json` against the release WASI shell through `recordedBashTests` in `scripts/replay/recorded-bash-tests.ts`. Those 30 rows cover empty and single-operand calls, option errors, `-l`, invalid signal names, `RTMIN` and `RTMAX` bounds, numeric aliases, `SIGKILL` and `SIGSTOP` bindings, and nested-parent deferred handlers for signals `9` and `19`.

## Verification

- `shell/engine/src/state/traps.rs` has three unit tests. They check active-parent process substitution, inherited-parent nested process substitution with deferred reset, and storage refund when the last inherited action clears.
- `shell/engine/src/builtins/trap.rs` has one unit test. It checks retained-action storage admission failure and refund across resets and snapshots.
- `shell/engine/src/interpreter/trap_tests.rs` has two session tests. The first checks status `1` rejection with `trap: <operand>: trap execution is unsupported`, empty `trap -p`, zero storage leak, and no handler execution on `exit 4` for `EXIT`, `ERR`, `RETURN`, `DEBUG`, `INT`, and `TERM`. The second checks that a `KILL` action survives an interrupt with status `130` and refunds storage on `trap - KILL`.
- `shell/engine/tests/trap_registration.rs` runs the native `shell-engine` binary to check `KILL` and `STOP` registration, `-P` and `-p` queries, and reset.
- `shell/engine/src/runtime/tests/exec.rs` checks that a rejected `trap : EXIT` leaves automatic tail-command `exec` eligible while a retained `trap : KILL` disqualifies it.
- `scripts/replay/test-own-shell-trap-registration.ts` runs the release WASI shell. It checks status `1` rejection for `EXIT`, `ERR`, `RETURN`, `DEBUG`, `INT`, `TERM`, `HUP`, and `QUIT`, read-only `-p`, `-P`, and `-l` output, `KILL` and `STOP` registration and reset, and mixed-operand rejection. It also checks inherited `KILL` preservation across rejected catchable registrations, inherited reset on invalid signal names, continuation over unwritable stderr diagnostics, and all 30 replayed frozen GNU Bash 5.3.15 rows.
