# Trap registration

`trap` stores default, ignored, and handler bindings separately. It supports signal
names and numeric aliases, reset, `--`, `-p`, `-P`, and `-l`. Printing quotes actions
so they can be read again. Action text has a retained memory reservation shared by
isolated state snapshots. The reservation is refunded when the final action
reference is released, including references held by snapshots.

Inherited child handlers remain query-visible until a mutating trap invocation.
Mutation clears inherited handlers and ignored DEBUG, ERR and RETURN bindings.
It preserves ignored EXIT and signal bindings. Subshells, pipeline stages,
background commands and command substitutions use this deferred reset.

Process substitutions reset all EXIT bindings and caught signal bindings
immediately, keep ignored real signals, and retain DEBUG, ERR and RETURN
registrations. Their next mutation does not clear these retained special bindings.
Nested ordinary children still use deferred reset. Errtrace and functrace are not
supported.

No event runs a stored action. EXIT, ERR, DEBUG, RETURN and signal execution are
not implemented. Registering them records and prints the binding only; a shell
that ends with an EXIT handler does not run it. EXIT execution is approved for a
later, separately designed family. Diagnostic source-line parity and
trap-specific syntax-error reporting are also deferred.

The recorded fixture `scripts/fixtures/shell-trap-registration.json` contains local
GNU Bash 5.3.15 observations for rows whose output cannot depend on an action
running. Native tests and production-Waffle tests compare status and stdout, and
require empty stderr when Bash produced none. Nonempty diagnostics are retained
as evidence, not claimed as exact stderr parity. CI never invokes its host Bash
as an oracle. Frozen score gains require a separate complete replay and
independent review; these focused tests alone do not establish a zero-loss gain.

The [correction receipt](evidence/trap-registration-repair.json) records 96 focused
native and production-Waffle checks. It preserves the original 57 observations
and adds 39 Bash 5.3.15 rows. Historical frozen gains are not a qualification of
the corrected head. Four historical gains match stdout and status without proving
trap execution or active signal-ignore behavior. Current-main integration and
frozen qualification remain with the coordinator.
