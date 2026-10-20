# printf integer fields

`%d`, `%i`, `%u`, `%o`, `%x` and `%X` accept literal or `*` width and precision.
Width is a minimum total byte count, including a sign or radix prefix. Precision
is the minimum digit count. An omitted precision or a negative star precision
uses the ordinary integer spelling. Precision zero suppresses zero-valued digits.

- `-` pads on the right and overrides `0`. Negative star width also pads right.
- `+` requests a sign on signed decimal and overrides the space flag.
- Space adds a leading space to nonnegative signed decimal without `+`.
- `0` fills the width with zeroes after the sign or hex prefix. Any nonnegative
  precision disables this width fill, but still supplies precision zeroes.
- `#` adds `0x` or `0X` for nonzero hex. Octal gains a leading zero only when
  precision has not already supplied one. `%#.0o` with zero still prints `0`.
  Decimal ignores `#`; unsigned conversions ignore `+` and space.

Repeated and combined flags are accepted. A sign can remain when zero precision
suppresses zero digits, so `%+.0d` with zero prints `+`. Stars consume width,
precision, then value before format reuse. Missing operands default to zero;
explicit empty numeric operands warn. Stars keep the existing signed-32 range
and -1 overflow fallback, separate from signed/unsigned-64 value conversion.
Literal counts above signed-32 maximum stop printf with status 1 after integer
stars and the value have supplied any numeric warnings. No field is rendered.
Values keep the existing [signed](printf-integer-operands.md) and
[unsigned](printf-unsigned-radix.md) parsing and diagnostic rules.

The shared field parser also handles `%s` without changing its byte precision.
Integer rendering uses a fixed 22-byte digit buffer and borrowed sign/prefix
bytes. Spaces and zeroes use fixed 4096-byte chunks. The original first pass
admits all output, warnings and work before writing. Large widths or precisions
do not allocate proportionally, skip admission, or bypass cancellation.
Numeric warnings, closed stderr, merged descriptor ordering, partial writes and
`%b` with `\c` retain the existing printer behavior.

This is original Rust observed against GNU Bash 5.3.15, not copied upstream code.
Floats, time formats, locale grouping, `%c`, `-v` and runtime changes are excluded.
Raw stdout/status and stderr comparisons remain separate. The existing missing
Bash source-line annotation and extra Bash closed-stdout diagnostic are unchanged.
See [measurement evidence](evidence/printf-integer-fields.json).
