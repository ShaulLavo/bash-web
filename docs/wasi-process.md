# WASI utility processes

`shell-wasi-process` provides the Rust process API for a WASI guest on its caller's
Waffle runtime. Ordinary source-byte utility integration is gated by admission.
It creates no runtime, host process, thread, socket or output relay.
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

Waffle's `runtime_proc` has no import to enumerate inherited descriptors. The Shell
worker separately supplies `shell_terminal.inherited_fd(index: i32) -> i32` to its
own guests. `inherited_shell_descriptors()` uses that existing import and its `-1`
end marker to return the complete launch bindings. It excludes private preopens
and supports sparse large descriptors without scanning their numeric range.
Callers must use it only with the Shell worker. A generic Waffle worker does not
provide that namespace. Other callers must supply an explicit complete list.
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

The public ordinary-program path is `Runtime.registerProgram(path, { adapter,
source })`. Shell's `installUtility(..., { execution: "wasi" }, { source })` uses
that path and the delivered `guestLauncher` and worker. Waffle P rewrites these
bytes for interruption before compiling them. Pre-existing `runtime_proc` imports
fail with `Cannot instrument WebAssembly: reserved import namespace runtime_proc`.
The browser test submits the actual Rust fixture bytes through the production
installer and observes `{ kind: "start-failed", code: 8, error: "ENOEXEC" }`.
Host outcomes use Linux errno numbers. P's `proc/start-errno.ts` and
`proc/abi.ts:481` encode this as WASI errno 45 for the Rust `StartFailed(45)` outcome.

P also publicly supports trusted cooperative modules with `Runtime.registerProgram`
and `{ adapter, module, cooperative: true }`. The preserved ABI fixture uses that
path with explicit interruption checkpoints. This proves the imports and wire
contract against real browser workers. It does not prove ordinary raw-WASI utility
execution. Switching env, find or xargs to compiled modules would bypass the
ordinary admission requirement and is not implemented or recommended here.

The same browser run installs a launch probe through the production installer and
worker. The probe uses `shell_terminal.inherited_fd` without pre-existing
`runtime_proc` imports and runs through source admission. It reports libc cwd `/` for requested
cwd `/workspace`, and observes injected `PWD=/workspace` for both an empty
environment and a supplied `PWD=/different`. This separates the launcher limits
from admission and from the cooperative ABI fixture.
The probe also checks complete inherited bindings at 0, 1, 2, 3, 9 and 1,000,000
through the committed Rust helper on the delivered worker.

## Needs from other tracks

- Ordinary source admission for a guest importing the existing `runtime_proc`
  signatures. The rejection is at Waffle P `interrupt/rewriter-internal.ts:518`,
  reached from `runtime.ts:405-407`. No additional process operation or guessed
  namespace is needed. Admission policy and instrumentation belong to the host.
- Independent cwd bootstrap that preserves the supplied environment. P's
  `browser/worker.ts::RuntimeWorkerRequest` has no cwd field. Shell's
  `src/runtime/worker-launcher.ts::guestLauncher` overlays `PWD` instead.
- Fatal-owner child-job cleanup. `spawn(json_ptr, json_len) -> i32` with `job: 0`
  creates an independent job. `kill_job(job: i32, signal: i32) -> i32` targets
  members of that job only, at P `proc/supervisor.ts:701` and
  `proc/worker-client.ts:600`. Fatal guest termination cannot run Rust Drop.
  A host lifecycle owner must link and collect owned jobs before utility consumers
  can claim automatic cancellation. Joining the caller's job would include the
  waiting caller itself and cannot replace this ownership contract.

These gates leave the committed codec, explicit descriptor bindings, status
mapping, and live-owner wait/cancel API usable for qualified callers. Env, find
and xargs execution remain unmodified until their complete requirements are met.

Run `cargo test --locked --manifest-path shell/Cargo.toml -p shell-wasi-process`
for codec tests. Build the WASI fixture with
`node shell/wasi-process/tests/build-fixture.mjs`, then run
`WASI_PROCESS_FIXTURE=.build/wasi-process-target/wasm32-wasip1/release/examples/process_fixture.wasm bun shell/wasi-process/tests/browser.mjs`.
These commands require the repository's installed dependencies, SDK34 and a
Playwright Chromium installation. Substantial runs use the machine's job queue.
The browser runner closes its runtime, browser and localhost server and removes
its temporary bundle and profile directory on success, failure or interruption.
