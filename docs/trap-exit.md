# Trap registration and root EXIT

`trap` stores default, ignored, and handler bindings separately. It supports signal
names and numeric aliases, reset, `--`, `-p`, `-P`, and `-l`. Printing quotes actions
so they can be read again. Action text has a retained memory reservation shared by
isolated state snapshots. Removing the final binding refunds that reservation.

`Session::start` remains a persistent submission. `Session::start_script` ends a
complete script and runs its root EXIT action. Explicit exit and errexit also run
the root action. The action sees the terminating status. Ordinary handler results
do not replace it; an explicit handler exit does. The same shell state is used by
functions and eval. Completion is marked before evaluation, preventing reentry.
Interactive EOF finishes the root through the same script entry.

Inherited child handlers remain query-visible until a mutating trap invocation.
Mutation clears inherited handlers but preserves ignores. Inherited EXIT never
runs. Child-installed EXIT execution is deferred for subshells, pipelines,
background commands and substitutions. An experimental implementation retained
pipeline writers through failure cleanup, so those completion hooks were removed.
Signal delivery and ERR, DEBUG and RETURN execution remain unimplemented. Their
registration and query do not claim event execution. Diagnostic source-line parity
and trap-specific syntax-error reporting remain deferred.

The recorded fixture `scripts/fixtures/shell-trap-exit.json` contains local GNU
Bash 5.3.15 observations. Native tests and production-Waffle tests compare status
and stdout, and require empty stderr when Bash produced none. Nonempty diagnostics
are retained as evidence, not claimed as exact stderr parity. CI never invokes its
host Bash as an oracle. Frozen score gains require a separate complete replay and
independent review; these focused tests alone do not establish a zero-loss gain.
