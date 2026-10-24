# printf character conversion

`%c` writes the first byte of its operand, not an integer character code or a
Unicode scalar. `printf '%c' 65` writes `6`. Both C and UTF-8 locales write only
byte `c3` for `é`. An empty or missing operand writes one real NUL byte.

Literal and star widths pad with spaces. `-` or a negative star width pads on
the right. Other accepted flags do not change the character. Precision is parsed
and its star argument consumed, but does not truncate or suppress the byte.
Stars consume width, precision, then the character operand before format reuse.
They retain the existing signed-32 numeric diagnostics and overflow fallback.
Literal counts above signed-32 maximum stop with status 1, after any star
warnings and before rendering the field. `%b` with `\c` keeps its stop behavior.

The implementation borrows one byte or static NUL and uses the existing string
padding path. Fixed 4096-byte buffering, two-pass admission, cancellation, partial
writes and closed-descriptor status ordering are unchanged. Oversized widths
cannot allocate a proportional buffer or write before admission succeeds.

Invalid input bytes have a pre-existing word-decoding limitation. Invalid ANSI-C
byte escapes become Unicode U+00xx before printf receives them, so `$'\xff'`
cannot produce the original `ff` through `%c`. No runtime or parser contract is
changed here. Output from valid UTF-8 input is still byte-exact, even when its
single-byte result is not valid UTF-8.

This is original Rust observed against GNU Bash 5.3.15, not copied upstream code.
`%q`, `%Q`, floats, time, options, `-v`, arrays and locale/runtime changes remain
outside this unit. Raw stdout/status and diagnostics are checked separately.
The existing source-line annotation difference and extra Bash closed-stdout
error diagnostic remain. See [measurement evidence](evidence/printf-character.json).
