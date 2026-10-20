# printf integer operands

Bare `%d` and `%i` convert operands to signed 64-bit decimal. Missing operands
supply zero without a warning. An explicitly empty operand prints zero and warns.
Both conversions accept signs, leading ASCII whitespace, decimal, leading-zero
octal, hexadecimal and Bash 5.3 binary prefixes. Trailing whitespace is invalid.
A leading single or double quote takes the following character code, or zero if
there is no character. C uses its first byte; UTF-8 locales use its code point.

Invalid text prints the valid numeric prefix, or zero when there are no digits,
and returns status 1. Overflow saturates to the corresponding signed-64 endpoint.
An invalid suffix takes diagnostic precedence over the range warning. Diagnostic
selection follows the original operand spelling, including the signed and uppercase
hexadecimal distinctions documented for [string stars](printf-string-fields.md).
Star width and precision retain their distinct signed-32 range and -1 fallback.

The lexical scanner is shared, not the range policy. Decimal output uses a fixed
20-byte stack array. The existing printer admits the complete repeated operation,
including diagnostics, before emitting anything, and delivers fixed-size chunks.
Numeric warnings to closed stderr do not stop output. Cancellation and stdout
errors remain failures. A later `%b` operand with `\c` clears numeric-warning status
but cannot hide an actual output failure or rejected admission.

Numeric fields, unsigned/radix output conversions, floats, time and `-v` remain
unsupported. The existing missing source-line annotation in diagnostics remains.
Separate stdout/status comparisons are strict; normalized diagnostic comparisons
remove only Bash's source-line annotation and retain raw bytes as evidence.

This is original local code observed against GNU Bash 5.3.15, not an upstream
implementation. Native/WASI tests cover conversion, range, diagnostics, aliased
streams, cancellation, silent admission rejection and real pipe write failure.
See `docs/evidence/printf-integer-operands.json` for measured frozen memberships,
artifact hashes, checks and cleanup ownership.
