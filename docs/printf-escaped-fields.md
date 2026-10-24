# Escaped printf fields

`printf` applies `%b` width to the decoded operand's byte length. A tab, NUL or
high-byte escape counts as one byte. Unicode escapes count the bytes emitted for
the selected character locale. The zero flag pads with spaces, not zeroes.
Negative star widths select left alignment.

```sh
printf '[%8b][%-8b][%08b]\n' 'a\tb' 'a\tb' 'a\tb'
```

The decoded-field walk borrows the operand and reuses the existing escape decoder.
The first walk counts emitted bytes and reports escape diagnostics once, before
padding. The second emits bytes without repeating those diagnostics. Neither walk
buffers the decoded operand. Padding and output retain the existing 4096-byte
writes, admission checks and cancellation checkpoints.

A `\c` escape stops the whole command after this field, including its padding.
It suppresses later format text, fields and reused operands. Precision limits
output bytes, even within a multibyte escape, but does not hide a later `\c` or
escape diagnostic. Zero precision still decodes the operand for those effects.
Literal width or precision above the signed 32-bit maximum warns and recovers
as zero for `%b`. Escape diagnostics come first. A zero precision still decodes
the operand, so `\c` stops the invocation after padding and clears warning status.
Ordinary `%s` literal overflow still stops with status 1.

The bare `%b` path is unchanged.

Scalar `-v` capture uses the same field behavior and retains its existing first-NUL
and valid-UTF-8 storage boundary. This does not add array assignment, float/time
formats or a new locale or runtime contract.

Focused controls are in `shell/engine/tests/words/printf_escaped_fields.rs` and
`scripts/test-own-shell-printf-assignment.ts`. Full frozen measurement and accepted
passing memberships are separate from these targeted comparisons.

## Frozen measurement

One production-Waffle replay of immutable
`ec8b801c8ded5ada99d9be9edc847ff856936ad3` gained two passes against accepted
`6f292e1ecafdb0f1638860092d0f4e96722480ac`, with zero lost passes. Oils remains
1,015. Brush suite increases from 1,007 to 1,008, and Bashkit suite from 1,412
to 1,413. All 9,221 case classifications and frozen identities remain unchanged.
Only the two gained memberships and derived counts change in the baseline;
historical failure payloads stay intact. The unchanged strict comparator passes
offline on the same saved output. See the [measurement receipt](evidence/printf-escaped-fields.json).
