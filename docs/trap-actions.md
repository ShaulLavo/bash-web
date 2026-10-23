# ERR and RETURN actions

The interpreter runs ERR actions after failed commands, before `errexit` stops
execution. Conditions, negation and non-final AND/OR commands suppress ERR.
Pipelines run one parent ERR action for a failed pipeline. Failures inside a
traced function or compound pipeline stage can run their own actions too.

`set -E` and `set -o errtrace` inherit ERR into functions and isolated execution.
`set -T` and `set -o functrace` inherit RETURN. Without those options, functions
hide their caller's handler. A handler installed inside a function survives the
call. Removing a hidden handler restores the caller's binding.

RETURN runs before function locals and positional arguments are restored. Its
`$?` is the last command status before an explicit `return`, not that builtin's
operand. An action's ordinary status does not replace the command status. An
explicit `exit`, or `return` from an ERR action, still controls execution. Actions retain
PIPESTATUS and cannot recursively invoke the same event.

Stored text uses the admitted eval reader, including its depth, storage, work and
cancellation limits. Cancellation drops the running-event guard and the function
frame. Later session submissions can run traps again.

The recorded Bash 5.3.15 fixture `scripts/fixtures/shell-trap-actions.json` runs
natively and through production Waffle. Source-file RETURN, EXIT, DEBUG,
source-line metadata, recursive RETURN control flow, and runtime signal delivery
remain separate work.
