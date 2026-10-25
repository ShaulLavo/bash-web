# Parameter transformations

`${name@op}` transforms one scalar, nameref, `$?` or positional parameter:

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

Bash fixes the locale when `LC_ALL`, `LC_CTYPE` or `LANG` is assigned, so a
consulted locale variable that is a nameref is unsupported and fails with status 2.

Not supported, and failing closed with status 2: arrays (including `PIPESTATUS`
and namerefs to subscripts), `${@@op}`, `${*@op}`, `${!name@op}`, and invalid
operators on set names. Bash reports invalid operators as a bad substitution. `${#@op}` never reaches this code: the shell
exits with status 1 and "bad substitution: invalid parameter expansion" when the
expansion is reached; earlier commands still run. Attributes the state does not store (integer,
case, array) are not reported.

Scalar transformations also work inside selected parameter operands, including
`${v:-${x@Q}}`.

## Prompt decoding

`P` decodes prompt escapes before expanding parameters, arithmetic, command
substitutions, and backticks. Quotes in the prompt remain literal. The result
then follows the enclosing expansion's quoting and splitting rules.
`shopt -u promptvars` disables the substitution step, including in subshells.

Supported escapes are `\a`, `\e`, `\n`, `\r`, `\\`, three-digit octal bytes,
`\[`, `\]`, `\s`, `\w`, and `\W`. Octal output must form UTF-8; NUL bytes
are skipped. `\D{literal}` accepts a nonempty format without `%` directives.
Working directories come from shell state. `HOME` abbreviates their prefix,
and a positive `PROMPT_DIRTRIM` limits the trailing directory components.
Directory and identity text cannot introduce new substitutions.

`\u`, `\h`, `\H`, and `\$` require nonempty `USER`, `HOSTNAME`, or a numeric
`EUID` from shell state. Missing facts fail with status 2. These variables are
not initialized with invented user names, host names, or IDs. Bash obtains
some of these facts outside the environment; that host integration remains open.
Time and date directives, history and command numbers, job count, terminal name,
and shell-version escapes are unsupported and fail with status 2.
Prompt decoding and nested expansion share the existing work, storage, recursion,
and cancellation limits. Recorded production-Waffle tests run with
`node --test scripts/test-own-shell-prompt.ts`.

Original Rust in `shell/engine/src/expand/transformation.rs`, observed against
GNU Bash 5.3.15. Tests are in `shell/engine/tests/words/transformation.rs`;
measurement is in [the receipt](evidence/parameter-transformation.json).
