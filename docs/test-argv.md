# Scalar test arguments

`test` and `[` parse expanded command arguments in the engine builtin layer.
They do not use the separate `[[ ]]` parser. `[` first requires and removes its
final `]` argument.

Bash applies argument-count rules before its general expression grammar. A
three-argument binary comparison takes priority over grouping or negation.
Thus `test '(' = ')'` compares two different strings and returns 1.

Larger expressions recognize negation and grouping before binary comparisons.
`test 0 -eq 0 -a '(' = ')'` treats `=` as a parenthesized one-argument test and
returns 0. The same distinction applies to `==`. Binary comparison still takes
priority over unary predicates, and `-a` binds more tightly than `-o`. Both sides
are evaluated, including errors on a logically unselected side.

Parenthesized subexpressions with one through four arguments use Bash's small
argument-count rules. Bash 5.3.15's one-argument subgroup path reads the first
original argument rather than the subgroup operand. Consequently,
`test '' -o '(' = ')'` returns 1. The recorded controls preserve this behavior
and Bash's subgroup-closing scan, including malformed nested argument counts.
The engine uses admitted operator frames rather than recursive futures.

The 605 observations in `scripts/fixtures/shell-test-argv.json` were recorded
with signed GNU Bash 5.3.15. Native and patched-WASI tests load that fixture.
The production-Waffle driver is `scripts/test-own-shell-test-argv.ts`. The
scoreboard discovers it automatically. It batches the matrix in one shell
session and checks the two exact Oils scripts independently.
