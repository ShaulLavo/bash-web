# Bound nameref attributes

`declare`, `typeset`, and `local` accept `+n` for bound scalar references. The last
`-n` or `+n` option wins. Removing the attribute turns the stored target name into
an ordinary scalar value.

At global scope, removal follows the chain to its last reference. An assignment
operand first writes through the chain. Inside a function, removal changes the
current local directly or creates an unset local that shadows an outer binding.
A local assignment operand replaces the local reference itself.

`-rn`, `-nx`, and `-nrx` attach readonly and export attributes to the reference,
not its target. A readonly reference can still write through to a writable target,
but cannot be retargeted, detached, or removed with `unset -n`. Children receive
an exported reference's immediate target name, not its resolved value.

Attribute-only removal preserves cached special-variable behavior. In particular,
removing the attribute from `IFS` does not recompute the separator used by `$*`.

Bare references without a target, array-element targets, associative arrays,
integer attributes, `-g`, and `+n` combined with other attributes remain outside
this change. Invalid scalar-target statuses are inherited from main through PR #59.

The recorded Bash 5.3.15 controls are in
[`shell-nameref-attributes.json`](../scripts/fixtures/shell-nameref-attributes.json).
After `npm run build:shell` and `npm run build:node-harness`, run
`node --test scripts/test-own-shell-nameref-attributes.ts` to replay them on Waffle.
