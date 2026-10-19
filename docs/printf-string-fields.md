# printf string fields

`%s` accepts a decimal width, optional decimal precision, or `*` operands for either.
A width pads with spaces without truncating; precision limits the number of bytes.
An omitted precision or a negative star precision leaves the string intact.
A negative star width or the `-` flag pads on the right. The valid string flags
`+`, space, `#`, `0` and apostrophe do not otherwise change the output. Repeated
flags are accepted. Precision can split a UTF-8 sequence, in both C and UTF-8 locales.

Stars consume operands before the string. Missing operands supply zero for stars
and an empty string for `%s`. Explicitly empty numeric operands are invalid.
Star integers follow Bash 5.3's signed decimal, octal, hexadecimal, binary and
quoted-character rules, not shell arithmetic expressions. Invalid suffixes retain
the parsed prefix and set status 1; out-of-range star values become -1 with status 1.
Overflow in a literal field stops printf with status 1. Numeric diagnostics use the
existing adapter prefix, not Bash's source-line annotation.

## Ownership and limits

The original field parser borrows the format and operands. It feeds the existing
byte printer, not libc or a reconstructed string. Its first walk admits all output
and work before writing; oversized padding is rejected before walking its spaces.
The delivery walk uses fixed 4096-byte chunks, cancellation and endpoint backpressure.
Both walks resolve the same operands and produce the same bytes. Dispatch continues
to own the printer's live memory charge. Allocation/work failures emit no output;
I/O errors and delivery cancellation can retain only a genuinely written prefix.

Bare `%d` and `%b` are unchanged. This does not add numeric field formatting, `%q`,
`%c`, floats, time directives, `printf -v`, option parsing or echo/read behavior.
The old unsupported-field regression now uses `%08d` instead of the newly supported
`%08s`; its assertions and unsupported-conversion coverage are unchanged.

The native/WASI `words::printf_fields` tests cover byte edges, argument consumption,
field overflow, output admission, chunking and cancellation in both walks. The
existing 1,122-case printf and 492-case echo replays remain strict and unchanged.
See `sources.lock.json` for original-local provenance and the approved shell plan
for measured frozen real-Waffle memberships.
