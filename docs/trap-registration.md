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

Process substitutions reset active EXIT bindings and caught signal bindings,
keep ignored real signals, and retain DEBUG, ERR and RETURN registrations. When
an ordinary child still has its deferred reset, its process substitution keeps
that reset and EXIT, and keeps caught signals other than INT, QUIT and CHLD.
Its first mutating trap invocation then clears the inherited bindings. An
inherited ignored EXIT surviving an ordinary child's mutation remains visible
through nested process substitutions until explicitly set again. A later ignore
after clearing inherited EXIT has a separate, unsupported Bash quirk. Nested
ordinary children still use deferred reset.

An active-parent process substitution implicitly ignores INT and QUIT without
printing a binding. Repeating an empty action keeps that implicit ignore hidden.
A reset or handler assignment in the substitution clears this provenance, so a
later explicit ignore is printed. Root explicit ignores remain visible. An
ordinary child clears implicit-ignore provenance; nested process substitutions
retain it. A parent with its ordinary-child reset still deferred allows its
first explicit ignore to be printed. These rules affect registration only, not
signal delivery. Errtrace and functrace are not supported.

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

The nested-parent correction adds 77 local recordings to the prior 96. It covers
all caught signal numbers, child execution forms, deferred reset on mutation,
and inherited ignored EXIT ownership. These remain registration-only controls.
The earlier correction receipt is historical; its nested-parent section records
the new source and checks without treating old full-score gains as current.

The implicit-ignore correction adds 78 local recordings to the prior 173, with
all earlier case objects unchanged. Native checks fail 15 of 251 before the
correction and pass all 251 after it. The matching production-Waffle guest also
passes 251. Eight focused trap-state tests pass. The receipt keeps the earlier
checks historical and records the new source and artifact identities separately.
