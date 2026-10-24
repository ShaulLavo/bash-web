# Default Bash echo

`echo` consumes a prefix of option arguments containing only `n`, `e` and `E`.
A whole argument must be valid before it changes state. `-n` suppresses the final
newline; the last `-e` or `-E` enables or disables escapes. The first ordinary or
unknown option argument ends option parsing. `--` and a lone `-` are operands.

With `-e`, echo writes raw bytes for control letters, `\\`, `\0nnn` and
`\xHH`. Unlike printf `%b`, nonzero-prefixed octal is literal. `\u` and `\U`
reuse the existing C/POSIX and UTF-8 locale behavior, including Bash's non-scalar
and legacy UTF-8 encodings. An incomplete escape stays literal without a printf
diagnostic. `\c` stops the whole invocation, including later operands and newline.
`xpg_echo`, POSIX mode and other locale encodings are not added.

## Ownership and limits

`builtins.rs` delegates only echo output to the existing byte printer in
`builtins/printf.rs`. Its explicit `Echo` mode keeps printf's format and `%b`
rules separate. Option parsing and both output walks cooperate with cancellation.
The first walk admits work and total output before writing. The second uses
constant storage and endpoint backpressure. The existing dispatch frame admits
and refunds the fixed 4096-byte buffer; it is not charged twice. Small output is
one logical write. I/O errors, output caps and cancellation can leave a genuine
streamed prefix, never a fabricated successful completion or recovery flush.

## Reproduce

Build with the repository's WASI SDK and patched-libc workflow, then replay:

```sh
npm run build:node-harness
npm run test:fuzz-shell-echo
npm run fuzz:shell-echo:ci -- --shell "$CARGO_TARGET_DIR/release/shell-cli"
npm run fuzz:shell-echo:ci -- --waffle \
  --shell "$CARGO_TARGET_DIR/wasm32-wasip1/release/shell-runtime.wasm"
```

The original 492-case matrix records GNU Bash 5.3.15 raw stdout and status.
Replay validates generated case identity, source hashes, healthy results and
canonical raw-byte encoding. It has no unsupported class or output normalization.
The native Rust controls also cover admission failure, cancellation during both
walks, large binary output, cap recovery, EPIPE, closed descriptors, write sizes
and execution-memory refund. Existing printf fixtures stay unchanged.

See `sources.lock.json` for the original-local classification. Exact gained IDs, source and artifact hashes are in
[the measurement receipt](evidence/echo-options.json).
