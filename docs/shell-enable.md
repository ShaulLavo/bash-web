# Builtin enable state

`enable` lists and changes the availability of builtins implemented by the core shell.
It uses the command catalogue, not a separate list of Bash command names.

- `enable` and `enable -p` list enabled builtins, sorted by name.
- `enable -n` lists disabled builtins.
- `enable -a` lists both groups. Disabled entries have the `enable -n` prefix.
- `enable -s` limits the list to implemented special builtins.
- `enable -n NAME...` disables supported builtins. `enable NAME...` re-enables them.
- `--` ends option parsing. Unsupported options return status 2.
- Unknown names return status 1. Other valid operands still take effect.

Ordinary dispatch, `command`, `builtin`, and `type` consult the same state.
A disabled builtin can resolve to a real external command through PATH.
`builtin` does not bypass disable state. Functions and aliases keep their normal precedence.
Completion filters enabled, disabled, and runnable commands using that state. Its builtin
view still includes disabled names.

Function calls share availability changes with their caller. Subshells, command
substitutions, pipeline children, and background jobs inherit independent copies.
The fixed-size mask is part of the existing shell-state snapshot admission.
No builtin names or per-change heap allocations are retained in the mask.

This does not add dynamic loading, library removal, or unsupported builtin handlers.
The special-builtin list intentionally omits `.`, `source`, and `times` until those
commands have real implementations. Frozen Brush enable case 1 therefore remains a gap.
Cases 2 and 4 are checked against the saved Bash 5.3.15 recordings. Nearby original
controls cover dispatch, snapshots, external fallback, cancellation, and admission.
