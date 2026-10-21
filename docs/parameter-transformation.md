# Parameter transformations

`${name@op}` transforms one scalar, nameref, special or positional parameter:

- `Q`, `K` and `k` quote the value for reuse as shell input. Empty values become
  `''`. A value with an unprintable character uses ANSI-C `$'...'` quoting with
  named escapes and octal bytes; otherwise it uses single quotes, and a lone `'`
  becomes `\'`. Printability follows `LC_ALL`, `LC_CTYPE`, `LANG`: C quotes
  every non-ASCII byte, UTF-8 keeps printable characters.
- `E` decodes `$'...'` escapes. A decoded NUL ends the value. A result that is
  not UTF-8 (`\777`, `\uD800`) fails closed, as do `\u` and `\U` above 0x7f in a
  non-UTF-8 locale.
- `u`, `U` and `L` change case with the same locale mapper as `${v^}`, `${v^^}`
  and `${v,,}`.
- `A` prints an assignment, `name='value'`, or `declare -rx name='value'` when the
  variable is readonly or exported, or `declare name='value'` for a local of the
  current function. A nameref prints its target's name. `a`
  prints those attributes. Special and positional parameters have neither.

Under `set -u` an unset name is an error before the operator is checked. Without
it, an unset name expands to nothing for every operator except `A` and `a`, whose
results can still show the attributes of a declared but unset variable.

Not supported, and failing closed with status 2: arrays, `${@@op}`, `${*@op}`,
`${!name@op}`, prompt expansion `@P`, transformations nested inside another
operand such as `${v:-${x@Q}}`, and invalid operators on set names. Bash reports
the last as a bad substitution. Attributes the state does not store (integer,
case, array) are not reported.

Original Rust in `shell/engine/src/expand/transformation.rs`, observed against
GNU Bash 5.3.15. Tests are in `shell/engine/tests/words/transformation.rs`;
measurement is in [the receipt](evidence/parameter-transformation.json).
