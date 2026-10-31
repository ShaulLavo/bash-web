# Scalar read

`read [-r] [-u fd] [-n count] [-N count] [-d delimiter] [-t timeout]`
reads one logical line into its following scalar names. It assigns
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
reads use cancellable endpoints without read-ahead.

Raw exact-count reads with `-r -N count` in C/POSIX locale request chunks of at
most 4096 bytes. Each request stays within the remaining count and stops no later
than the first byte beyond `line_bytes`. NUL bytes do not count. The scratch
buffer is admitted against command storage and live memory before any input.
Per-byte cooperative checkpoints remain active, so cancellation can consume at
most one in-flight chunk beyond the last checkpoint. No unread buffer survives
the command, and aliases observe the next byte immediately. Delimiter, UTF-8 and
non-raw reads retain one-byte requests.

`-d` uses the first delimiter byte. An empty delimiter selects NUL. `-N`
ignores the delimiter. `-p prompt` prints to stderr only for a terminal input.
`-s` has no effect on redirected input and returns 2 for a terminal because
silent terminal input is not implemented.

## Read timeouts

`-t timeout` applies a deadline to the whole read, not to each byte. A positive
`TMOUT` scalar supplies the deadline only when no `-t` is present. Namerefs work
for `TMOUT`. Unset, invalid, negative, and converted-zero `TMOUT` values are
ignored without a diagnostic. Explicit invalid `-t` values return 1 in option
order. A missing argument returns 2. Repeated valid options use the last value.

Timeouts use GNU Bash 5.3.15's decimal conversion. An optional sign and one dot
are accepted, including empty components that convert to zero. Whitespace and
exponents are invalid. Fractions truncate to six digits. Integer accumulation
wraps at 64 bits, then applies the sign and rejects negative signed components
before narrowing seconds to 32 bits. Thus `4294967296` converts to zero, but
`-4294967296` is invalid. No floating-point rounding or indefinite overflow
fallback is used.

A converted-zero explicit `-t` only observes descriptor readiness. It consumes
no bytes and changes no destination, even for an invalid destination name.
Buffered input and regular files are ready, including EOF. An empty pipe is
ready only after its writers close. Write-only regular and null descriptors can
be ready even though an actual read fails. A live pipe write end and captured
output are not read-ready. Exported buffered input delegates readiness to its
host without inspecting the original bytes. Missing descriptors and unsupported
observations return 1. This path neither prints a prompt nor allocates a record.

Positive timeouts ignore canonical regular descriptions, including buffered
here-documents and here-strings. Pipes and terminal input can expire. Expiry
assigns the accumulated partial record through the normal field and destination
rules and returns 142. Assignment errors keep their normal precedence. EOF
before expiry returns 1. A fired deadline wins over queued but unread bytes.
Bytes already returned by a read remain part of the record. Pending Ctrl+C wins
over expiry and retains the existing cancellation behavior.

One Waffle executor timer serves the whole read and is armed before input.
Both WASI driver loops pass the canonical deadline timeout to the existing
runtime poll between executor turns. Busy pipelines cannot starve the timer.
Completion, timeout, cancellation, and dropping the operation release the timer,
readiness waiter, and admitted record buffer.

Interactive `TMOUT` auto-logout, arrays, terminal editing, and descriptor errno
diagnostics remain outside this implementation. The frozen ruler compares stdout bytes and
status, not stderr. General attributes and nameref behavior belong to state.

Controls include `shell/engine/tests/words/read_count.rs`, its scalar test module,
`words/read_timeout.rs`, and `scripts/test-own-shell-read-timeout.ts`.
The timeout replay uses new recorded GNU Bash 5.3.15 observations, and the live
runtime controls cover idle and busy deadlines plus borrowed-runtime reuse. The scalar field/remainder rules and
selected examples adapt pinned Bashkit's read implementation; provenance is in
`sources.lock.json`. Byte protection, runtime admission and cancellation are
original adapters. Historical counted-read evidence is in
[evidence/read-count.json](evidence/read-count.json).
