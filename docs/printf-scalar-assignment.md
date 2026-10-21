# Printf scalar assignment

`printf -v NAME FORMAT ARG...` and attached `-vNAME` save formatted output in
an existing shell scalar or create one. Repeated `-v` options select the last
name. `--` ends option parsing, including after the name. The following argument
is the format, even if it looks like another option. No stdout write occurs,
so a closed stdout descriptor does not prevent assignment.

Names use the existing ASCII shell identifier rules. Missing names or formats
and invalid names return 2 without changing the variable. Assignment follows
the shell's existing dynamic local scope, nameref resolution, readonly checks,
temporary prefix restoration and IFS cache updates. With `x=prefix printf -v x`,
the existing builtin prefix guard restores the outer value. Bash instead keeps
the printf assignment. The shared builtin guard has no selective durable-write
contract, so this existing binding boundary remains explicit in the controls. A readonly target returns 1
and retains its value. Numeric warnings still diagnose and assign the formatted
partial result with status 1. `%b` with `\c` keeps the formatter's existing
stop-output and status rules.

The existing formatter still runs its budgeted preflight and emission passes.
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
This is original local Rust observed against GNU Bash 5.3.15, not copied code.

See [the measurement receipt](evidence/printf-scalar-assignment.json). Focused
controls compare raw stdout and status, and separately compare stderr after
removing only Bash source-line annotations. This unit adds no stdout normalization
and leaves the frozen path-normalization and stderr policies unchanged. No case,
fixture, exclusion or deadline changes.
