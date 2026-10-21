# Printf scalar assignment

`printf -v NAME FORMAT ARG...` and attached `-vNAME` save formatted output in
an existing shell scalar or create one. Repeated `-v` options select the last
name. `--` ends option parsing, including after the name. The following argument
is the format, even if it looks like another option. No stdout write occurs,
so a closed stdout descriptor does not prevent assignment.

Names use the existing ASCII shell identifier rules. Missing names or formats
and invalid names return 2 without changing the variable. Assignment follows
the shell's existing dynamic local scope, nameref resolution, readonly checks
and temporary prefix restoration. Direct IFS writes refresh its special caches.
Printf through a nameref to IFS remains an open correctness blocker. The
current implementation retains the prior membership map and quoted `$*`
separator, but that does not establish Bash-compatible splitting for this
family. Repeated identical commands in Bash 5.3.15 produce different fields
when the prior IFS is set, including default, custom and empty values. Unset
prior IFS behaves differently. Ordinary `ref=:` still refreshes splitting.
See the exact observations and confirmed stale-pointer cause in
[plan004](../plans/004-own-shell.md#indirect-ifs-review-blocker).
With `x=prefix printf -v x`,
the existing builtin prefix guard restores the outer value. Bash instead keeps
the printf assignment. A readonly target returns 1
and retains its value. Numeric warnings still diagnose and assign the formatted
partial result with status 1. Malformed `\x`, `\u` and `\U` escapes in the
format or `%b` warn without failing assignment, even with stderr closed.
Cancellation and a real broken diagnostic pipe still abort before assignment.
`%b` with `\c` keeps the formatter's existing stop-output and status rules.

Preflight counts stdout bytes separately from diagnostics, then admits the exact
capture size, variable key and binding storage before allocation or output.
Capture memory also uses the shared live execution budget. State assignment
commits only after emission and cancellation checks finish. Output, command
storage or execution budget failure and cancellation leave the previous value.
The capture guard releases its live allocation on success, error or cancellation.

Scalars remain Rust UTF-8 strings. A NUL truncates the stored result at its first
occurrence, as in Bash. Non-UTF-8 bytes before that NUL return 2 without replacing
the prior value. No lossy decoding is used. Bash can store those bytes; closing
that existing representation gap is outside this unit. Ordinary stdout printf
continues to emit arbitrary bytes unchanged.

Array lvalues are rejected without evaluation or mutation. Integer attributes,
time and floating-point formats and help rendering are not added. Unsupported
conversions retain their existing diagnostic and status 2, and scalar assignment
retains the supported prefix that the formatter produced before the conversion.

See [the measurement receipt](evidence/printf-scalar-assignment.json). Focused
controls compare raw stdout and status, and separately compare stderr after
removing only Bash source-line annotations. This unit adds no stdout normalization
and leaves the frozen path-normalization and stderr policies unchanged. No case,
fixture, exclusion or deadline changes.

The full replay in that receipt measured `286dd4cd0bc59410bda90348992044812a208dd3`.
The later warning fix and incomplete indirect-IFS change alter production bytes. Their focused
checks and 392 affected frozen-case comparisons are separate evidence, not a
second full replay or a new score claim.
