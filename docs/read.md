# Scalar read

`read [-r] [-u fd] [-n count] [-N count] [name ...]` reads one logical line. It assigns
successive IFS fields to scalar destinations, clears destinations beyond the
available fields, and gives the final destination the remaining source text.
IFS whitespace collapses; other IFS delimiters preserve empty fields. Empty IFS
puts the whole line in the first destination. With no names, `REPLY` keeps the
whole line without splitting or trimming.

Without `-r`, backslash protects the next character from splitting and trimming.
Backslash-newline continues the logical line; a trailing backslash at EOF is
removed. NUL bytes are ignored. EOF assigns the collected value and returns 1;
a newline or the requested count returns 0. Invalid first names return 1 without
consuming input. A later invalid name leaves earlier assignments in place and
later destinations unchanged. A readonly destination stops assignment the same
way; it returns 2 for `REPLY` or a non-final name and 1 for the final name.
Its Bash diagnostic is not printed yet. Options stop at the first destination.

`-n` counts output characters and stops without reading the next byte, including
a following newline. Zero assigns empty values without reading. Decimal counts
through 2147483647 accept a sign and surrounding ASCII whitespace; negative
nonzero and invalid counts return 1 before input.

Counted character locale selection reuses printf's `LC_ALL`, `LC_CTYPE`, `LANG`
precedence. UTF-8 counts Unicode scalar values, not grapheme clusters. C/POSIX
counts bytes. Invalid or incomplete UTF-8 returns 2 before assignment because
engine scalars must be valid UTF-8. Other locale encodings remain unsupported.

One incremental reader serves counted and ordinary reads. Its byte buffer and
escape-protection bitmap are admitted against command storage and shared live
memory before input. `line_bytes` bounds the retained record. A borrowed field
cursor returns source spans without a field vector or delimiter placeholders.
It reuses expansion's admitted IFS character snapshot, so a multibyte IFS
character matches only that whole character, as Bash does in a UTF-8 locale.
Like expansion, it does not model C-locale byte membership.
Assignments copy only their final bytes, so local values cannot retain the
record's unused capacity. Every input byte and field scan uses cooperative work;
reads use cancellable endpoints without read-ahead or descriptor probing.

Raw exact-count reads with `-r -N count` in C/POSIX locale request chunks of at
most 4096 bytes. Each request stays within the remaining count and stops no later
than the first byte beyond `line_bytes`. NUL bytes do not count. The scratch
buffer is admitted against command storage and live memory before any input.
Per-byte cooperative checkpoints remain active, so cancellation can consume at
most one in-flight chunk beyond the last checkpoint. No unread buffer survives
the command, and aliases observe the next byte immediately. Delimiter, UTF-8 and
non-raw reads retain one-byte requests.

Arrays, `-d`, timers, terminal editing and descriptor errno diagnostics
remain outside this implementation. The frozen ruler compares stdout bytes and
status, not stderr. General attributes and nameref behavior belong to state.

Controls are in `shell/engine/tests/words/read_count.rs`, its scalar test module,
and `scripts/test-own-shell-read-scalar.ts`. The scalar field/remainder rules and
selected examples adapt pinned Bashkit's read implementation; provenance is in
`sources.lock.json`. Byte protection, runtime admission and cancellation are
original adapters. Historical counted-read evidence is in
[evidence/read-count.json](evidence/read-count.json).
