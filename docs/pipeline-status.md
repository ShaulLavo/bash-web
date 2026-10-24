# Pipeline status

`PIPESTATUS` contains the actual exit code of each completed foreground pipeline
stage, in source order. It starts empty. Ordinary commands replace it with one
status. Brace groups, `case` commands and function definitions keep the
last list published by an executed command. Arithmetic commands, `[[ ... ]]` and
subshells publish their own status.

```bash
false | true
printf '%s\n' "${PIPESTATUS[*]}" # 1 0
```

Expansion and `declare -p PIPESTATUS` read the list before the current command
publishes its result. Declaration output copies a charged, bounded snapshot
before writing. Pipeline children and command substitutions use the existing
isolated state snapshots.

`$?` remains the pipeline's aggregate result. `pipefail` selects the rightmost
nonzero stage status; `!` negates the aggregate, not the stage list. The engine
uses its joined stage outcomes and does not infer success for missing children.

The list is bounded by the engine's pipeline-stage limit, 128 by default.
Other control-command wrappers keep their existing behavior. Unsupported
parameter transformations remain unsupported. This change adds no
process metadata, Waffle interface, or trap behavior.
