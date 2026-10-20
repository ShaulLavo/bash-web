# printf unsigned and radix operands

Bare `%u`, `%o`, `%x` and `%X` accept unsigned 64-bit operands and print decimal,
octal, lowercase hex and uppercase hex. Missing operands give zero without a
warning. Explicit empty operands print zero and warn. The format repeats while
operands remain, including mixed signed, unsigned and string conversions.

Operands accept signs, leading ASCII whitespace, decimal, leading-zero octal,
hexadecimal and Bash 5.3 binary prefixes. A leading quote takes the next byte in
C or code point in UTF-8. Trailing bytes, including whitespace, are invalid.
Malformed operands retain their valid prefix and select diagnostics from the
original spelling, as with [signed operands](printf-integer-operands.md).

The parser retains a checked unsigned magnitude, including an explicit overflow
state distinct from exact `u64::MAX`. In-range negative magnitudes wrap modulo
2^64. Overflow of either sign prints `u64::MAX` and warns. An invalid suffix takes
precedence over a range warning without changing the fallback value. Signed
conversions retain their signed-64 saturation; string stars retain signed-32
limits and their -1 fallback. The common parser returns the 64-bit bit pattern;
only signed consumers interpret it as a signed integer.

All integer output uses a fixed 22-byte stack buffer, enough for maximum octal.
The existing two-pass printer admits the complete operation before delivery,
including diagnostics and repeated formats. It streams through fixed-size chunks
with cancellation and actual I/O failures preserved. Failed numeric warnings on
closed stderr do not stop output. `%b` with `\c` clears numeric-error status only
after successful operand processing; it cannot hide output or admission failures.

[Integer flags, width and precision](printf-integer-fields.md) are also supported.
Floats, time and `-v` remain unsupported.
No runtime or locale implementation changes. The existing Bash source-line
annotation difference and extra Bash closed-stdout diagnostic remain disclosed.
Raw stdout/status, raw stderr and normalized diagnostics are separate checks.

This is original Rust observed against GNU Bash 5.3.15, not copied upstream code.
See `docs/evidence/printf-unsigned-radix.json` for frozen memberships and checks.
