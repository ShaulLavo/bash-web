# Printf shell quoting

`%q` quotes one operand for Bash shell input. Empty or missing operands become
`''`. Printable shell metacharacters use backslashes. Nonprinting input selects
ANSI-C quoting for the whole word, with named escapes, three-digit octal bytes,
and literal printable characters. `#` requests single quotes for printable
input, including the `"'\\''"` sequence for an embedded single quote. ANSI-C
quoting still wins when the input contains nonprinting characters.

Width counts output bytes and pads with spaces. `-` or negative star width
pads on the right. Zero, plus, space and grouping flags do not change quoting.
Precision on `%q` truncates the quoted output bytes, even inside an escape or
quote. `%Q` instead truncates the original input bytes before choosing quotes.
A zero precision therefore prints nothing with `%q`, but `''` with `%Q`.
Stars consume width, precision and value in that order before format reuse.
Count overflow keeps Bash's warning/status and quoting-specific fallback.

Locale selection uses the existing `LC_ALL`, `LC_CTYPE`, `LANG` precedence.
C quotes high bytes as octal. UTF-8 keeps printable multibyte characters and
quotes incomplete byte sequences, including those cut by `%Q` precision.
Native checks use an owned UTF-8 character classifier without changing process
locale, C.UTF-8 on Linux and en_US.UTF-8 on Darwin. WASI uses its existing musl
Unicode classifier. These classifiers are not identical for every scalar. For example, Bash and native GNU libc quote
unassigned U+0378, while the pinned WASI libc considers it printable. Exact Bash
classification of all unassigned characters is not claimed or repaired here.

The shell's word representation still replaces invalid ANSI-C byte escapes
before printf receives them. `$'\xff'` reaches printf as UTF-8 for U+00FF, not
byte `ff`. The same limitation affects invalid bytes captured by substitution.
No parser, expansion, eval or runtime contract changes are included. Successful
`-v`, help, floats, time, length modifiers, positional formats and padded `%b`
remain outside this unit.

This is original Rust observed against GNU Bash 5.3.15, not copied or adapted
upstream implementation. New native/WASI tests live in
`shell/engine/tests/words/printf_quoting.rs`.
See [the measurement receipt](evidence/printf-quoting.json) for raw-byte controls,
frozen gains and remaining differences. Stderr remains separately retained and
unscored; merged Bash source-line annotations are not hidden in strict scores.

The native Darwin classifier also differs from GNU libc. For the measured
control, Darwin quotes U+00AD, U+200B and U+FEFF but leaves U+2028 printable;
GNU libc does the reverse. The Darwin test keeps an explicit native expectation
and checks it against the installed `/bin/bash` builtin. This platform control
is separate from the frozen GNU Bash 5.3.15 oracle and does not change its ruler.
