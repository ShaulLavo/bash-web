# WASI utility processes

`shell-wasi-process` lets a utility execute another WASI program on its caller's
Waffle runtime. It creates no runtime, host process, thread, socket or output relay.
Its imports match Waffle `d0c5f8a1a9a6723c2f9fccf5df8544b8aad84a00`.

## Launch data

`Request` supplies `executable`, `argv`, `env`, `cwd` and `fds`. `argv` includes
argv0, which can differ from the executable path. Empty arguments and an empty
environment stay empty. `cwd` must be absolute. The bridge never changes `PWD`.
Strings must be UTF-8 without NUL. Environment names cannot contain `=`.
Encoded spawn JSON is limited to 1 MiB, including escaping.

`DescriptorBinding { child, parent }` borrows an existing descriptor. Spawn retains
its own binding before returning. The bridge never closes the parent's binding.
Duplicate child targets are invalid. Sparse descriptors and remapping are supported.
`inherited_stdio()` returns bindings for open descriptors 0, 1 and 2 only.

Waffle has no guest import to enumerate inherited descriptors. Utilities that need
all-descriptor inheritance must receive an explicit complete list from their caller.
The stdio helper does not establish that contract. The bridge never scans a guessed
fd range or assumes that fd 3 is the root preopen.

## Lookup and execution

`resolve_executable(program, path, cwd)` uses Waffle's executable-access queries.
The caller passes its final PATH after environment edits. Missing PATH uses
`/bin:/usr/bin`. Empty PATH components mean cwd. A slash bypasses PATH search.
EACCES takes precedence over missing and non-directory search candidates. Other
errors stop the search. Lookup does not load or compile a program. Spawn checks
admission again. Shell-script fallback for ENOEXEC is outside this API.

On `wasm32-wasip1`, `run(&request)` spawns and waits. `spawn(&request)` returns
`Child`, with `pid`, `try_wait`, `wait` and `cancel` methods. Each child owns a new
foreground job. A successful wait collects both the direct child and its job,
including same-job descendants' descriptor and filesystem cleanup fences. `try_wait` is
nonblocking and returns no outcome until that whole job is safe.

`Outcome` distinguishes real exits, signals and startup failures. `shell_status()`
returns actual exit codes unchanged, 128 plus the signal, 127 for startup ENOENT,
and 126 for other startup failures. An error of a host call remains `Error::Host`,
separate from a child's `Outcome::StartFailed`. There is no native execution API.

## Cancellation and cleanup

`wait` consumes handled pending signals through Waffle. It cancels the owned job
with SIGKILL, waits for teardown, then returns `Error::Interrupted(signal)`.
The bridge does not install signal handlers or change signal dispositions.
Default-action signals remain Waffle's responsibility. `cancel` kills the job and
collects it; repeated cancellation or waits return the cached outcome.
Dropping an unfinished `Child` also cancels and collects it. Explicit cancellation
lets callers observe cleanup errors; Drop reports a cleanup failure on stderr.
Rust Drop cannot run after fatal guest unwinds or process exit. At this pinned
provider, killing the caller's job does not kill the independent job this API
creates. Killing an owned job also does not include descendants that deliberately
create separate jobs. Utility integration with automatic ancestor cancellation
is gated until the host links owned jobs to caller termination. Killing an owned
job does not signal the utility's siblings or parent job.

Executable queries are consumed on completion and canceled on interruption or an
error before completion. There are no retries, timeouts or buffered stdout copies.

## Current integration limits

The delivered Shell `guestLauncher` adds or overwrites `PWD` with the requested cwd.
Waffle's generic preview1 bootstrap has no independent cwd initialization, so libc
starts at `/`. The wire preserves both supplied fields, but that adapter cannot
execute arbitrary programs with independent cwd and environment. Utility callers
must reject those modes until the host supplies a real cwd bootstrap contract.
An empty environment and custom PWD cannot be claimed on the delivered adapter.

The usage fixture uses Waffle's generic worker with an environment-preserving test
adapter and root cwd. It checks exact argv0 and environment, explicit sparse and
remapped descriptors, relocated root-preopen access, PATH queries, typed failures,
live cancellation and Drop cleanup. It does not certify the gated modes above.

## Admission and verification

Guests importing `runtime_proc` use Waffle's trusted cooperative module path.
Register a lazy compiled-module loader with `cooperative: true`. The third-party
source-byte interrupt rewriter deliberately rejects the reserved `runtime_proc`
namespace. Utility installers must select their existing cooperative installation
path and retain interrupt checkpoints. The bridge checks interrupts in blocking
waits and lookups; the enclosing program remains responsible for its own CPU loops.

Run `cargo test --locked --manifest-path shell/Cargo.toml -p shell-wasi-process`
for codec tests. Build the WASI fixture with
`node shell/wasi-process/tests/build-fixture.mjs`, then run
`WASI_PROCESS_FIXTURE=.build/wasi-process-target/wasm32-wasip1/release/examples/process_fixture.wasm bun shell/wasi-process/tests/browser.mjs`.
These commands require the repository's installed dependencies, SDK34 and a
Playwright Chromium installation. Substantial runs use the machine's job queue.
The browser runner closes its runtime, browser and localhost server and removes
its temporary bundle and profile directory on success, failure or interruption.
