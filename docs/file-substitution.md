# Input-only command substitution

`$(<file)` and eligible backticks read a file into expansion without starting a
command. Filename expansion runs against the caller's state. For example,
`x=$(<"${name:=file}")` assigns both `x` and `name`. Missing or ambiguous filenames
produce an empty substitution with status 1. Filename parameter errors retain
the caller's fatal-error behavior.

Eligibility is syntax, before expansion: one simple command, no assignments or
command words, one input redirect to fd 0. Additional redirects, command lists,
backgrounding, negation, groups and words that later expand away keep ordinary
command execution. Bash's `$()` parser normalizes `0<file` and trailing blank
lines; legacy backticks beginning with `0<file` or containing input after their
first complete line do not enable the shortcut. Typed parser metadata retains
these distinctions through the lexer's backtick conversion and scalar assignments.

The file reader uses the same 4,096-byte streaming decoder as ordinary command
capture. It removes trailing newlines, ignores NUL with one warning, carries UTF-8
sequences across reads, and rejects unrepresentable bytes with status 2. Quoting,
IFS splitting and later pathname expansion keep their existing rules. Captures
retain their work, storage and output limits and cooperative cancellation. A file
capture owns its endpoint directly; ordinary substitutions retain their producer
supervisor and cancellation/join protocol. Process-substitution filenames retain
the existing descriptor owner and are drained during cancellation and shutdown.

Native/WASI tests are in `shell/engine/tests/words/file_substitution.rs` and the
parser's `file_substitution.rs`. Build the production guest, then run
`npm run test:file-substitution` to compare the production Waffle runner with
sandboxed GNU Bash 5.3.15 observations recorded in
`scripts/fixtures/shell-file-substitution.json`, the frozen scoreboard's oracle
version. Bash 5.2 also captures backticks beginning with `0<file` and negated
`! <file`, so a host's own Bash is not the oracle. Re-record with
`BASH_FILE_SUBSTITUTION_RECORD=<path>` on a host whose `/usr/bin/bash` is 5.3.15;
the test rejects any other version. These original controls compare exact
stdout and status; stderr is not compared. The measurement receipt is
`docs/evidence/file-substitution.json`.

## Existing descriptor boundary

Regular-file aliases currently reuse the same open description. They do not
reopen a file with an independent offset as GNU Bash does. The following exact
control reproduces through GNU Bash 5.3.15, the native adapter and production
Waffle at pin `fc58a532f0d7a617e631ea4b7580a190915d4ed6`:

```sh
printf 'one\ntwo\n' >f
exec 3<f
x=$(</dev/fd/3)
IFS= read -r y <&3
printf 'x=<%s> y=<%s>\n' "$x" "$y"
```

Bash prints `x=<one\ntwo> y=<one>`, with a literal newline inside `x`. The shell
prints `x=<one\ntwo> y=<>`. Replacing `$(</dev/fd/3)` with
`$(cat </dev/fd/3)` produces the same difference on production Waffle. Both
return status 0. Raw observations are retained in
`/work/reports/bash-web/hill-climb/control/file-substitution/fd-observation.json`.

This family preserves the shared descriptor helper. Independent reopening of
regular-file aliases requires a separate runtime/I/O contract; pipes and
terminals must continue to share their descriptions. No descriptor parity is
claimed, and no path blacklist, offset restoration, case skip or scoring change
is used. Filesystem service stall behavior also remains the existing runtime
boundary described in plan 004.

## Provenance

The parser changes modify the owned Bashkit-derived parser at base
`491c3281f668b76d64b15210b8f5d7bf97244be0`. The eligibility metadata, capture
adapter and tests are original local code, checked against GNU Bash 5.3.15.
The GNU Bash 5.3 `subst.c`, `builtins/evalstring.c` and `parse.y` implementations
were inspected to explain the observed shortcut boundaries; no implementation
was copied. `sources.lock.json` records both classifications separately.
