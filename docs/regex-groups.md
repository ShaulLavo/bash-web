# Grouped conditional ERE

`[[ value =~ pattern ]]` supports ASCII ERE groups, nested alternatives and
`*`, `+`, `?`, `{n}`, `{n,}`, `{n,m}` on groups as well as ordinary atoms.
Empty groups and alternatives can match empty text. `^` and `$` refer to the
whole value, including inside alternatives. Quoted or escaped punctuation stays
literal. The parser keeps its existing regex-word handling for group spaces,
operator-looking text and variable expansion.

```bash
pattern='^((ab|c){2,3})+$'
[[ abc =~ $pattern ]] && echo matched
[[ '(a|b)' =~ '(a|b)' ]] && echo literal
```

This is a boolean matching slice. It does not publish captures or update
`BASH_REMATCH`. Capture arrays and POSIX submatch selection belong to variable
state work. Backreferences remain unsupported with status 2. Callers that need
capture results must treat that as an explicit missing feature.

The existing ASCII input and locale domain is unchanged: C, POSIX, C.UTF-8 and
C.utf8. Non-ASCII input, other locales, collating/equivalence elements and GNU
stacked quantifiers remain unsupported. Unbalanced groups are rejected.

Interval counts above 32,767 return status 2, including for empty groups.

A resource-admitted expression arena and an iterative compiler emit the existing
Thompson states. At most 64 groups may be active. Every scan/compiler iteration
charges the shared work account and checks cancellation; vectors reserve storage
before growth. Finite repetitions can expand the state graph only within that
account. Empty repeated groups terminate through the existing visited-state
closure. No recursive matching or host regex fallback is used.

The implementation and new controls are original local code based on bash-web
`361992834804c5d9325022ddc3580f5e9899bcee`, not copied upstream. GNU Bash
5.3.15 supplies behavior observations. Production-Waffle controls live in
`scripts/test-own-shell-regex-groups.ts`; native/WASI controls live in
`shell/engine/tests/words/regex.rs`. The frozen score retains its existing cases,
oracle, identities, skips, deadlines and per-case loss gate.

The full frozen production-Waffle replay at source
`ab1378ab8db7dda387e26e7477687e62a2c8c05e` gains eight Oils, four Brush and
two Bashkit cases with zero lost cases. The immutable-main control first
reproduces every committed pass. Only the 14 gained outcome fields and derived
counts change; historical payloads remain. See the
[measurement receipt](evidence/regex-groups.json) for exact IDs, identities,
and commands.
