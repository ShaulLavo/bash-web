# Original browser acceptance guests

These small, dependency-free Rust programs exercise generic WASI process behavior.
They are original test fixtures, not Bun implementations, aliases, adapters copied
from upstream, or evidence of Bun API support. Both target `wasm32-wasip1`.

## Build and registration

The repository build script owns compilation and copies the release artifacts into
`public/programs/`. Do not check the generated WASM into source. To build directly
from the repository root, use the shared build queue with this command:

```sh
source /work/projects/bun-wasm/env.sh
unset CARGO_ENCODED_RUSTFLAGS RUSTFLAGS CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS
export CARGO_TARGET_DIR="$PWD/.build/test-guest"
cargo build --manifest-path tests/guest/Cargo.toml --locked --release \
  --target wasm32-wasip1 -j2
```

Register `test-guest` through the harness's existing `bash-web:preview1` adapter,
using a compiled module with `cooperative: true`. It calls Waffle's real
`runtime_proc` imports directly and checks interruption at bounded CPU/I/O/poll
boundaries. Its `spin` mode is **cooperative**, not instrumentation coverage.

Register `test-spin` separately with `source: bytes`. It has only WASI imports,
prints and flushes its optional first argument as a line, then runs an infinite
CPU loop with no cooperative checks. Waffle's ordinary source admission must
instrument this binary. Do not mark it cooperative or provide a Bun command alias.

## Commands

All arguments are ordinary argv strings, not scripts. Output described as a line
has a trailing LF. Successful commands exit 0 unless documented; argument and I/O
errors print `test-guest: ...` on stderr and exit 2. Status arguments must be 0–255.

| `test-guest` arguments                                | Behavior                                                                                                                                                                                                         |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `emit <text> [count=1] [exitStatus=0]`                | Write raw UTF-8 text `count` times, with no added LF, then exit with the requested status.                                                                                                                       |
| `emit-bytes [byte,...]...`                            | Write decimal bytes, accepting commas or separate arguments, with no added LF.                                                                                                                                   |
| `cat`                                                 | Copy stdin to stdout as binary until EOF, handling partial writes/backpressure.                                                                                                                                  |
| `fd-read <fd>`                                        | Copy the specified inherited descriptor to stdout until EOF.                                                                                                                                                     |
| `fd-write <fd> <text>`                                | Write raw text to the specified inherited descriptor.                                                                                                                                                            |
| `yes [text=y]`                                        | Repeatedly write text plus LF; ignore SIGPIPE and exit **23** on EPIPE.                                                                                                                                          |
| `ticker <count> <ms> [prefix=tick]`                   | Emit `prefix 0`, `prefix 1`, etc.; wait only **between** writes. Count 0 is infinite.                                                                                                                            |
| `sleep <ms>`                                          | Interruptible wait using runtime process polling in at most 10 ms slices.                                                                                                                                        |
| `spin [marker]`                                       | Optionally emit marker as a line, then perform CPU work, checking interruption every 4096 iterations.                                                                                                            |
| `exit [status=0]`                                     | Exit immediately with the specified status.                                                                                                                                                                      |
| `bytes [path]`                                        | Read stdin or a file and emit `BYTES:` followed by decimal comma-separated bytes.                                                                                                                                |
| `count [path]`                                        | Read stdin or a file and emit `COUNT:<byteLength>:<LFCount+1>`.                                                                                                                                                  |
| `delayed-count <ms> [prefix=COUNT]`                   | Emit `READER_WAITING` to stderr, sleep, deliberately accumulate stdin in memory, then emit `prefix:<byteLength>:<LFCount+1>`.                                                                                    |
| `repeat-byte <byte> <count>`                          | Emit the specified byte using bounded 8192-byte chunks.                                                                                                                                                          |
| `produce <chunks> <chunkSize> [byte=97]`              | Write each complete chunk, then emit `WRITTEN:<zeroBasedIndex>` to stderr.                                                                                                                                       |
| `pattern <blockSize> <blocks> <modulus>`              | Write block i filled with byte `i % modulus`. Modulus is 1–256.                                                                                                                                                  |
| `check-pattern <blockSize> <modulus>`                 | Check the preceding pattern incrementally on stdin; emit `COUNT:<byteLength>:<true\|false>`. Block size must be positive.                                                                                        |
| `read-line [prefix=INPUT:] [readyMarker]`             | Optionally emit readiness line, read bytes through the first CR/LF or EOF, then emit prefix plus lossy UTF-8 input (excluding terminator).                                                                       |
| `read-exact <n> [prefix=PARTIAL:] [readyMarker]`      | Optionally emit readiness line, read up to n bytes or EOF, then emit prefix plus lossy UTF-8 input.                                                                                                              |
| `zero-read`                                           | Perform a real zero-length stdin read; emit `ZERO_READ:0`.                                                                                                                                                       |
| `fd-types`                                            | Query actual WASI terminal types; emit `STDIOTTY:<0\|1>:<0\|1>:<0\|1>` for stdin/stdout/stderr.                                                                                                                  |
| `write-order [count=3]`                               | Alternate stdout `OUT:<i>` then stderr `ERR:<i>`, starting at 0.                                                                                                                                                 |
| `context [envKey]`                                    | Emit `CWD:<cwd>` and, when a key is given, `ENV:<value>` (empty when absent).                                                                                                                                    |
| `argv [arg]...`                                       | Emit each argument as `ARGV:<zeroBasedIndex>:<JSON-string>`.                                                                                                                                                     |
| `write-file <path> <text> [exitStatus=0]`             | Write raw text through Rust std/WASI filesystem support, then exit with the requested status.                                                                                                                    |
| `unlink <path>`                                       | Remove the file through Rust std/WASI filesystem support.                                                                                                                                                        |
| `exists <path>`                                       | Emit `EXISTS:true` or `EXISTS:false`; propagate errors other than not-found.                                                                                                                                     |
| `spawn <executable> [arg]...`                         | Spawn through the actual runtime ABI, inherit env/cwd and fds 0–2, wait for the child and reap its job, then propagate child status.                                                                             |
| `spawn-kill <delayMs> <signal> <executable> [arg]...` | Spawn as above, wait, send the actual numeric signal to the child, then wait/reap and propagate its status.                                                                                                      |
| `spawn-json <request>`                                | Pass a JSON SpawnRequest directly to the ABI, wait/reap, and propagate status; permits testing explicit inherited descriptor mappings. Use a new job (`job:0` or `job:-1`), since this mode reaps its owned job. |

The preview1 ABI has no process `chdir` operation. The browser adapter provides the
actual process cwd as `PWD`; `context` and relative filesystem paths use that
explicit launch context. This is not a claim that Rust std `current_dir` implements
a separate browser cwd facility. Spawn helpers create a **new foreground job**;
they do not claim an implicit same-job inheritance API. For a signaled child the
fixture propagates status `128 + signal`. The fixture does not rewrite traps as
signals, implement its own process host, or silently treat a Bun-specific skip as
covered.
