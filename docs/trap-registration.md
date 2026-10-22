# Trap registration

`trap` stores default, ignored, and handler bindings separately. It supports signal
names and numeric aliases, reset, `--`, `-p`, `-P`, and `-l`. Printing quotes actions
so they can be read again. Action text has a retained memory reservation shared by
isolated state snapshots. The reservation is refunded when the final action
reference is released, including references held by snapshots.

Inherited child handlers remain query-visible until a mutating trap invocation.
Mutation clears inherited handlers but preserves ignores. Subshells, pipeline
stages and substitutions see the parent's bindings this way.

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
