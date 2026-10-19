# Counted scalar read

`read -n count [name]` stops after the requested number of output characters or
an unescaped newline. EOF before either boundary assigns the collected value
and returns 1. Reaching the count returns 0 without reading the next byte,
including a following newline. Zero assigns an empty value without reading.
Decimal counts through 2147483647 accept a sign and surrounding ASCII whitespace;
negative nonzero and invalid counts return 1 before consuming input.

The counted path supports separate and combined `-r`, `-n` and `-u` options and
one scalar destination. Without `-r`, backslash quotes the next character,
backslash-newline contributes nothing, and a trailing backslash at EOF is
removed. NUL bytes do not contribute to the count. An explicit name trims
unquoted IFS whitespace at its ends; the default `REPLY` preserves it.

Character locale selection reuses printf's existing `LC_ALL`, `LC_CTYPE`, `LANG`
precedence. UTF-8 counts Unicode scalar values, not bytes or grapheme clusters.
C/POSIX counts bytes. The engine's scalar values must remain valid UTF-8, so a
C count splitting a multibyte value, malformed UTF-8, or an incomplete UTF-8
character returns unsupported status 2 without assigning a partial value.
Other locale encodings remain unsupported.

The buffer is bounded by `line_bytes` and the count's maximum encoded size.
Both command storage and shared live execution memory admit it before input.
The live ticket stays through assignment and drops on success, failure or
cancellation. Each input byte consumes cooperative work and uses the cancellable
endpoint reader. There is no read-ahead, descriptor probe or metadata inference.

Uncounted reads retain their existing behavior. This change does not implement
uncounted escape processing, multiple destinations, arrays, `-N`, `-d`, timers,
terminal editing or descriptor errno mapping. The frozen scoreboard compares
raw stdout and exit status; it does not score stderr diagnostics. The focused
closed-descriptor control matches status but still lacks Bash's stderr message.

Original regression controls live in `shell/engine/tests/words/read_count.rs`.
Native, WASI, browser and frozen membership measurements are recorded in
[evidence/read-count.json](evidence/read-count.json).
