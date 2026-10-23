# Associative arrays

`declare -A h` creates a string-keyed array. Quoted keys stay shell words rather
than arithmetic expressions. Reads and assignments do not split fields or
expand pathnames.

```bash
declare -A h=(['a b']='one two' [key]=value)
h[key]+=tail
h+=([new]=added)
printf '%s\n' "${h['a b']}" "${h[key]}" "${!h[@]}"
unset 'h[new]'
```

Compound assignments accept explicit key/value entries or alternating keys and
values. A replacement clears earlier entries; `+=` retains them. An unmatched
last key receives an empty value. A scalar assignment addresses key `0`.
Functions can use `local -A` bindings, and subshell writes stay isolated.

The state layer stores an associative binding as an immutable shared string map.
An assignment stages a complete admitted copy before publication. The existing
assignment journal handles cancellation and resource rollback. This first
implementation copies on each element update; it makes no performance claim.

The map currently enumerates keys in lexical order, not Bash's hash-table order.
Key and value iteration use the same order. Declaration printing, arithmetic
array access, associative declaration through a nameref, `-v`, and whole-array
transformations remain outside this change.

The recorded Bash 5.3.15 fixtures run against the production guest through Waffle:

```sh
npm run build:shell
npm run build:node-harness
node --test scripts/test-own-shell-associative.ts
```

Native controls in `shell/engine/tests/words/associative.rs` cover scopes,
substitutions, readonly bindings, rejected updates, cancellation, and rollback.
