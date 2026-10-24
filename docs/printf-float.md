# Floating printf conversions

The core builtin accepts `%e`, `%E`, `%f`, `%F`, `%g` and `%G`. Flags, literal
and star widths, and literal and star precisions use the existing field parser.
Missing values are zero. Empty or partially parsed values warn and set status 1.
Decimal and hexadecimal operands, signed zero, infinity, NaN and quoted character
operands follow the recorded Linux GNU Bash 5.3.15 behavior.

`%f` rounds to fractional digits. `%e` uses one leading digit and a signed
exponent with at least two digits. `%g` rounds to significant digits, chooses
fixed or scientific notation, and removes trailing fractional zeroes unless
`#` is present. Default precision is six; `%g` treats zero precision as one.
Rounding is nearest, ties to even. `+` takes precedence over space. `-` disables
zero width fill. Width zeroes follow the sign. Infinity and NaN ignore zero fill.
`#` preserves a decimal point, including at precision zero.

## Numeric representation

This is original Rust, not an upstream implementation or a host-libc binding.
Finite values use a 64-bit binary significand and an exponent, with separate
infinity and NaN variants. Software binary80 rounding preserves the pinned Linux
oracle's precision and range on WASI without a new dependency or runtime API.
A private base-2 integer handles decimal and hex rational conversion. Parsing
keeps 12,000 significant digits and a sticky tail, enough to distinguish binary80
rounding breakpoints. Decimal exponents saturate; range checks bound integer
scaling. Inexact subnormal conversions report the recorded range warning.

Formatting uses exact integer arithmetic. Low requested precision takes a decimal
prefix plus a sticky tail from a normalized rational. A floating logarithm only
chooses a scale; exact comparisons correct it before digit generation. Larger
precisions use the finite value's exact decimal expansion. Implicit zero runs
are streamed through the existing fixed-size printer, not allocated by precision.
Big-integer quotients use word-wise long division and charge work per quotient
word times divisor length rather than 64 bit-serial rounds.
Storage and numeric work use the existing command budgets. Expensive operands
can exhaust those budgets and fail before output, just like other builtin work.
The limits are unchanged.

## Verification and exclusions

`scripts/fixtures/shell-printf-float.json` contains 132 local recordings, including
17 selected frozen scored failures and two generated 3,000-operand cost controls. It identifies the exact Bash version and
binary SHA-256. Native tests and `scripts/test-own-shell-printf-float.ts` compare
status, stdout and stderr without running a live Bash oracle in CI. Native
controls also cover admission, numeric work, chunking, pipe delivery and
cancellation. The parent owns the hosted full-score comparison and review.

The implementation stays in the printf modules. It does not change scalar
assignment, runtime facts, integer formatting or the two-pass output contract.
`%a`, time formats, length modifiers, locale grouping and array destinations
remain outside this family.
