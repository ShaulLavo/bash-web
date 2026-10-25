# Browser integration

`bash-web` runs its WASI shell in a browser worker. It provides shell semantics
and the shell-specific guest/terminal adapter, not a second browser runtime.
The application creates one shared Waffle runtime for the page, gives that
runtime to its shells, and disposes it when the page's consumers have stopped.

## Embedding contract

For the steps, see [Embed a shell in a page](guides/embed-in-a-page.md). The API is in the [API reference](reference/api.md). This section states the contract that the adapter keeps.

Use a browser-capable bundler for the TypeScript entry and its worker imports. The required `waffle` peer is pinned to the exact Git commit in `peerDependencies.waffle` in `package.json`, and the development dependency uses the same commit. There is no local runtime-tree alias or vendored runtime fallback. Run `npm run test:installed-waffle` after installation to verify the prepared Node exports. Browser-only CI installs without lifecycle scripts and checks the source export declarations separately.

Supply `script` to execute a command instead of starting the persistent
interactive editor. `cwd` and `env` set shell startup state. `wasmUrl` and
`workerUrl` let an embedding select its shell asset and worker location rather
than relying on the default asset layout. `terminal` can supply an existing
`SharedBridge`; otherwise shell creation supplies its own terminal bridge.
`signal` cancels pending startup only; after `createShell` resolves, stop that
shell with `await shell.dispose()`. A rejected asset fetch does not permanently
poison later explicit shell admission: a subsequent creation can retry loading
that asset. There is no automatic retry loop.

`createShell` requires Waffle's actual `Runtime`, not an unrelated object with a
`startProcess` method. The shell adapter imports the peer's public APIs. It
never calls `createRuntime`, creates a hidden runtime, or takes ownership of the
runtime the application passed in.

A shell's `done` promise reports its exit code and any launch/runtime diagnostic.
For a failed executable start, the shell owns the command-specific diagnostic
and inherited fd 2 lifetime. Waffle reports typed startup failure to a
`runtime_proc` parent without writing generic bytes to child stdio, including
failures during executable resolution or lazy loading before adapter entry.
The full error remains in host diagnostics; Waffle still owns the cleanup fence
and worker stop. Host roots retain their existing generic reporting policy.
Guest stderr after entry and post-start failures remain ordinary worker output
and failures. `interrupt()` addresses that shell's foreground
execution; it must not terminate unrelated background jobs or other shells sharing
the runtime. `await dispose()` stops that shell and joins its locally observed
shell-adapter worker cleanup. This does not guarantee physical cleanup of descendants
launched through foreign adapters; a generic root-scoped runtime teardown join is not
implemented.
`diagnostics()` observes the shell, while
`runtimeSnapshot(runtime)` from the package root synchronously observes the
shared runtime without creating a process service. The application remains
responsible for `await runtime.dispose()` once the shared runtime is no longer
needed.

## Demo terminal activity

The demo requires `Atomics.waitAsync` on the page. It subscribes to the bridge's
wake counter instead of polling an idle terminal. Output, freed input capacity,
phase changes and shutdown publish activity. Each task drains at most 32 KiB,
then schedules another task if output remains. Bursts share one scheduled task.
Sampling the counter before draining prevents a publication during subscription
from being missed. Closing the session releases its pending wait and suppresses
later callbacks. Final output drains before the exited or failed state is shown.
Memory metrics update on activity, not on a separate sampling timer.

This policy belongs to the demo's `BrowserSession`, not to `createShell` or the
borrowed Waffle runtime. There is no polling fallback for older browsers.

## Storage ownership, waiting and disposal

The application owns storage selection and the runtime lifetime; Waffle owns
storage locks, recovery and filesystem workers. The demo's `mountBrowser` borrows
`{ runtime }` without disposing it, or accepts an `acquireRuntime()` factory
returning `{ runtime, ready, dispose }`. A factory lease owns its preparation
and must provide idempotent, awaited disposal even if preparation is still
pending. Without either option, the host creates and owns one runtime. Its `mode`
option accepts `"fast"` or `"memory"`. If omitted, `?mode=` selects that owned
runtime's mode, defaulting to FAST when the query parameter is absent. SAFE and
unknown values reject with `UNSUPPORTED_VFS` before runtime creation. An explicit
option takes precedence over the query. Borrowed runtimes and factory leases never
read the mode selector. Their owner selects storage.

FAST uses IndexedDB checkpoints. Memory mode is nonpersistent and loses all changes
when its owner stops. This selection does not certify SAFE, bounded FAST pressure,
or the failed-close native storage matrix.

`src/browser/storage.ts` observes `runtime.filesystem.state` before shell
admission. `opening` and `waiting` are not shell failures: the host shows
“Waiting for another tab to release storage…” and keeps input disabled until
storage is ready. The observer preserves an existing `onStateChange` callback
and detaches its own listener after readiness, cancellation or failure. The
shell's 60-second startup timeout begins **after** storage is ready. Initial
`opening` has its own separate total 60-second guard; expiry reports “Browser storage
did not become ready within 60 seconds.” A lock grant without ownership waiting does
not extend this initial budget. Entering `waiting` disarms that guard.
Waiting may last indefinitely while another tab owns the workspace, and the typed
state remains `waiting` through recovery. After ownership waiting, the passive
`filesystem-lock-acquired` milestone starts a fresh 60-second active-recovery guard,
separate from both opening and shell startup. Repeated waiting states or milestones
cannot erase or extend it.
Expiry reports “Browser storage recovery did not finish within 60 seconds.”
Ownership release normally lets the same runtime recover and continue without a
reload. Readiness, failure, disposal and cancellation clear both guards and detach
the milestone listener. Storage `failed`/`disposed` states are terminal, not a fallback
to empty storage.

The demo installs `createStorageStartup()` before creating its owned runtime or
calling its runtime factory, so even a grant before the consumer subscribes retains
its recovery budget. A borrowed runtime that is still opening needs its owner to
create that signal before runtime construction, forward `onStartupStage` to its
`observe` callback, and pass the same signal as `mountBrowser({ runtime, storageStartup })`.
A borrowed ready runtime needs no startup signal. The guard measures elapsed time
from local receipt of acquisition; worker timestamps are forwarded unchanged to
diagnostics, not compared against another realm's clock.

`storage-wait-requested` and `storage-wait-resolved` describe only this consumer's
storage-readiness await. They remain distinct from `runtime-lease` preparation,
which also joins caller registration, and from all existing runtime milestones.
They are fixed, passive diagnostics: observers cannot delay startup or reject it,
and callbacks from a stopped generation cannot contaminate the next start.

Backend contention policy belongs to the runtime owner, not the shell. At the
pinned Waffle revision, OPFS waits and rejects takeover; IndexedDB defaults to
takeover with optional `whenBusy: "wait"`. See Waffle's
[storage ownership contract](https://github.com/ShaulLavo/waffle/blob/250967060c0268950266fc5afb85be2170fb8ed3/docs/storage.md).

Restart/stop cancels admission, joins pending session creation and awaits
`BrowserSession.dispose()` before releasing an owned lease or creating its
replacement. Session disposal stops only the shell and removes local observers;
it does not dispose a borrowed runtime. The owner must `await runtime.dispose()`
when its final consumer stops, including while waiting for storage: Waffle then
cancels queued filesystem work and joins worker cleanup/ownership release.
Do not treat a shell exit or an unawaited dispose call as that ownership fence.
Pending IndexedDB opens can be cancelled under either busy policy. Restart awaits that
cleanup before acquiring its replacement runtime, including after the opening guard expires.

## Terminal and host responsibilities

The root package exports the shell facade and terminal bridge helpers. The
terminal's byte transport is independent of terminal rendering: `src/browser/`
contains the demonstration page, renderer integration, input/resize forwarding,
and browser controls. Those are host concerns, not shell semantics or a runtime
implementation.

Only workers perform blocking waits. The page publishes input and drains output
through bounded shared buffers, so a worker blocked in WASM does not need a page
callback to make progress. Terminal transport must preserve backpressure; do not
turn streamed output into an unbounded whole-command string. The demo's terminal
newline handling is separate from shell output bytes.

The shell adapter's bounded terminal path must not be confused with a generic
foreign adapter's callback-based terminal writes. That path can acknowledge more
bytes than fit in the shared ring. Global and per-root `droppedTerminalBytes`
counters and visible console errors expose the loss; they do not make it
lossless. Closing that gap needs synchronous accepted-byte/EAGAIN semantics
and root-scoped teardown in Waffle.

Diagnostics attach manual pipe observers without taking relay, endpoint or
disposal ownership. Their pipe counts cover requests observed from the shell
root, not every descendant's pipes: Waffle handles child-worker process messages
internally, so nested shell-created pipes are not included. A zero count is not
proof that the entire process tree has no live pipes. Closed observations are
reclaimed on a 100 ms sweep rather than waiting for another snapshot; retiring
the root clears its timer. The counts come from observed messages, not from
Waffle-owned read-only snapshots.

The browser host cancels and joins pending shell admission on startup timeout or
session disposal, without disposing a borrowed runtime. It explicitly falls back
to a Canvas terminal when WebGPU is exposed but no GPU adapter is available.

Waffle owns filesystem authority, process records, descriptors, pipes, signals,
and lifecycle fences. Shell-specific files in `src/runtime/` connect those APIs
to the shell guest, including inherited descriptors, terminal access, and shell
phase notifications. Their location does not make them a copied runtime package.
Waffle places preopens in the lowest free descriptors before instantiation and
preserves inherited numbers literally. All WASI builds select the shared patched
sysroot; the Rust std test guests retain its libc scanner, while the browser
shell uses its original direct-WASI adapter and the fixture CLI needs no
filesystem scanner. No shell adapter relocates preopens or supplies synthetic
prestat metadata. See [guest libc and build provenance](wasi-libc.md).

## Serve the assets

The browser uses the **`shell-runtime.wasm`** binary, built from the local
`shell/` workspace. The default served asset is:

```text
/programs/shell-engine.wasm
```

This binary is distinct from the stand-in CLI used by the standalone WASI
verification harness. Do not substitute the CLI at the browser asset URL.
The CLI's original fixture adapter keeps `/usr` read-only, matching the frozen
Bash sandbox, while its working directory and `/tmp` remain writable. That
standalone policy does not change the caller-owned browser filesystem.

The default worker is the package's already-bundled `dist/shell-worker.js`,
resolved relative to the package, not a raw `.ts` worker or a Vite-specific
`?worker&url` import. Package preparation and the browser build emit that asset;
the final browser-output step preserves it. Supply `workerUrl` to use another
emitted JavaScript worker URL. The default shell WASM URL is the origin-root
path `/programs/shell-engine.wasm`; `wasmUrl` overrides it.

The build also bundles Waffle's public `waffle/browser/fs-worker` entry into
`.build/browser/fs-worker.js` and `dist/fs-worker.js`. Both stable worker files
are restored after Vite replaces `dist`; the demo uses the emitted filesystem
worker URL. Applications must serve their bundled filesystem worker and pass
its URL as `createRuntime({ filesystem: { workerURL } })`, as in the example.
That runtime option is distinct from `createShell`'s shell `workerUrl` option.
Bundling the public dependency entry does not vendor a runtime source tree.

Host the page and workers in a secure context (HTTPS, or localhost for local
development), with cross-origin isolation enabled for `SharedArrayBuffer`:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Ensure the shell asset, worker scripts, terminal assets, and any externally
registered guests satisfy that policy. Serve WASM as `application/wasm`; do not
let an HTML fallback route answer a missing program URL. The host's content
security policy must permit the worker/WASM loading strategy it uses.

### Optional external programs

The application registers the programs it wants with its Waffle runtime.
`createShell` does not know Bun, register aliases, or provide an external-program
registry of its own. A host can use Bun's guest adapter and guest binary as a
separate integration. Every registered executable must resolve to its actual
program, not to the shell binary as a placeholder.

Waffle registration keys are canonical absolute file paths, such as `/bin/tool`;
keys such as `tool`, `/bin/./tool`, and `/bin//tool` are rejected. The caller
creates the regular file with `runtime.filesystem.writeFile` before executing it.
A zero-byte marker is sufficient: registration supplies the program source or
module and does not create, replace, or delete filesystem entries. Removing a registration leaves its file behind but makes it non-runnable.

Register external programs at canonical absolute paths and create their regular
files yourself. For example, an integration that supplies its own Waffle guest
launcher and WASM bytes can install `/bin/tool` on the page's existing runtime:

```ts
import type { GuestLauncher, Runtime } from "waffle";

async function registerTool(runtime: Runtime, launch: GuestLauncher, source: Uint8Array) {
  runtime.registerAdapter("tool:preview1", launch);
  await runtime.filesystem.mkdirp("/bin");
  await runtime.filesystem.writeFile("/bin/tool", new Uint8Array());
  runtime.registerProgram("/bin/tool", { adapter: "tool:preview1", source });
}
```

The marker contents are not the program: Waffle loads the registered source.
The shell's default `PATH=/bin` finds `tool`; do not register a bare `tool` alias.
Registration does not create or preserve the marker. Deleting it prevents future
execution; an existing file without a registration, or a directory, is not
runnable. See [lookup details](#optional-external-programs)
for lookup and exit-status behavior.

The shell, not Waffle spawn, searches `PATH` for bare commands. It queries each
candidate's live executable access asynchronously, without loading the module,
and chooses the first runnable file. Missing candidates, unregistered files and
directories do not hide a later runnable candidate. Relative `PATH` components
and empty components (including an empty `PATH`) resolve against the current
working directory. A command containing `/` is tried directly, without a `PATH`
search. Like GNU Bash 5.3.15, PATH search ignores directory candidates: a search
containing only directories and missing candidates produces status 127. A
non-executable regular-file candidate produces status 126 if no runnable
candidate follows it. Explicit directory paths still fail with 126.

Executable selection is separate from the program's arguments: resolving `tool`
to `/bin/tool` still delivers `tool` as `argv[0]`. Command queries preserve Bash's
selected path spelling, including relative components. Temporary PATH bindings
follow the shell's effective assignment and nameref rules without changing the
caller's PATH after the invocation.

Lookup snapshots, candidates and pending request strings count toward both the
local PATH-storage limit and the session's shared live-execution-memory limit.
Dropped temporaries release their storage tickets; retained candidates and
requests stay charged through their consumers. One command-wide PATH scan-work
allowance covers every operand of a query. Cancelling a parked access request
releases its strings and storage tickets without releasing another task's
allocations.

Direct paths also walk the live filesystem before canonical registration lookup.
Thus `/missing/../bin/tool` cannot skip a missing intermediate, and traversing a
regular file as a directory or giving it a trailing slash fails with 126.
Deleted registered files fail with 127; replacing a registered file with a
directory fails with 126. Neither case can run a previously cached module. This
is Waffle's executable access/admission contract, not a claim that marker files
implement Unix permission bits or that arbitrary unregistered WASM files run.

The production `mountBrowser` default remains program-free: it creates the page
runtime, and the shell adapter supplies only its own canonical
`/programs/shell-engine.wasm` registration and caller-owned marker. The acceptance
page separately installs `/bin/test-guest`, `/programs/test-guest.wasm`,
`/bin/test-spin`, and `/programs/test-spin.wasm`. There are no bare-name registry
aliases; its normal `test-guest` and `test-spin` commands exercise shell `PATH`
search.

This package contains **no Bun guest, launcher, runtime implementation, or guest
license payload**. The public launcher/worker APIs and hash-verified guest
descriptor needed by the external Bun acceptance cases are not yet available at
a published dependency pin. There is no Bun host package dependency; affected
Bun-specific cases retain their intent and are explicitly pending rather than
passing external-program evidence.

The generic browser host has no specific external-program knowledge. No Bun
worker, broker, subprocess transport, or import-slot implementation is copied
into this repository to substitute for the missing package surface. Once the
external launcher is published, the acceptance harness can compose it with the
same page-owned Waffle runtime and obtain its guest through the external
package's verified descriptor. Bun guest identity, payload, licenses and
integrity verification belong to that external package, not the shell library.

`tests/helpers/bun-fixture.ts` records the expected composition contract through
an injected `installBunAdapters(runtime, { workerUrl, wasmUrl? })` function. Its
lease owns installer cleanup and the single runtime's disposal. This is an
original test fixture, not an implementation or a claim that those package
exports are already published.

## Build and verify

Install the [build prerequisites](development.md#prerequisites), including
wasi-sdk 34.0, CMake and Ninja for the shared patched-libc sysroot. From a checkout
with `npm ci` completed, run:

```sh
npm run test:browser:package
npm run build:browser
npm run typecheck:browser
npm run test:runtime:terminal
npm run test:browser
```

`test:browser:package` is the inexpensive packaging gate: it checks agreement
between peer/development/source-lock pins and the absence of copied runtime/Bun
implementation sources, Bun guest binaries, and Bun guest license payloads. Install the
Playwright browsers selected by the browser test configuration before running
browser acceptance. The shell-only build, Rust/WASI tests, and frozen
compatibility replay remain separate gates; see [development and architecture](development.md#build-and-test).

Browser acceptance covers real worker execution and terminal transport. It is
not a new frozen compatibility score or permission to regenerate oracle data.
Keep tests explicitly marked pending as pending; a test skipped for an inherited
runtime limitation is not passing evidence. Chromium and Firefox results do not
establish Safari behavior. Safari still requires verification on an actual Mac.

### Browser test scope

The current Playwright listing (`playwright test --list`) contains 113 unique
cases configured once for Chromium and once for Firefox: 226 configured
executions, with 210 runnable executions and 16 unchanged configured skips. This is
configuration inventory, not final browser acceptance evidence; a configured or
runnable case is not a passing result.

| Suite                               | Configured cases | Runnable cases | Missing public Bun API | Original known failures | New engine/Waffle pending |
| ----------------------------------- | ---------------: | -------------: | ---------------------: | ----------------------: | ------------------------: |
| Shell                               |               12 |             11 |                      0 |                       0 |                         1 |
| External commands                   |               26 |             24 |                      2 |                       0 |                         0 |
| Pipelines                           |               24 |             23 |                      1 |                       0 |                         0 |
| Runtime                             |               38 |             34 |                      1 |                       3 |                         0 |
| Startup diagnostics                 |                4 |              4 |                      0 |                       0 |                         0 |
| Storage lifecycle                   |                7 |              7 |                      0 |                       0 |                         0 |
| Worker assets and renderer fallback |                2 |              2 |                      0 |                       0 |                         0 |
| **Unique cases**                    |          **113** |        **105** |                  **4** |                   **3** |                     **1** |
| **Chromium + Firefox executions**   |          **226** |        **210** |                  **8** |                   **6** |                     **2** |

The `command` and byte-exact `printf` external-guest cases are runnable following
the functions and printf units.
Six external-command cases run now that the pinned Waffle revision
(`ba968a6f86468d03394792a3e9c447dfc713c279`) and the shell's asynchronous
executable access/PATH-search support are in place:

- **Unregistered files fail with 126.** Existing regular files require a program
  registration; the command host stays usable after the rejection.
- **Relative executable lookup.** Explicit `./test-guest` resolves against the
  shell's current directory.
- **Dot-segment executable lookup.** A live filesystem walk resolves
  `/bin/../bin/./test-guest` to its canonical registration.
- **Missing relative executable.** A missing explicit path fails with 127 without
  starting a guest.
- **Deleted registered executable.** Deleting a registered marker prevents
  execution and produces 127.
- **Registered directory replacement.** Replacing a registered marker with a
  directory prevents execution and produces 126.

Six additional original cases exercise PATH candidate skipping and relative/empty
components; denied-versus-missing search status and recovery; regular-file
intermediates/trailing slashes; root-parent traversal; a missing intermediate
before `..`; and shared `command -v`/`-V` lookup, including a deleted marker.
Rejected paths must not emit guest output or leave a child worker.
The registration helper's unit regressions separately check canonical-only keys,
caller-created markers before guest registration, and cancellation during marker
creation. Enabling a case is not evidence that it has passed a browser run.

One engine case is skipped: `$$` and `BASHPID` report a stable PID and the shell
stays alive. It is skipped because the engine needs an authoritative PID hook.

The four Bun API skips remain separate from the skipped PID case, and the three inherited known-failure fixmes remain unchanged.

Generic WASI guests exercise pipeline/capture/substitution, terminal and binary
transport, cancellation, write order, raw-terminal handoff, memory, and nested
spawn/stdin contracts. These are generic shell/runtime tests, not Bun support.
The additional original nested-spawn case checks inherited pipeline input and
status, actual child completion, worker cleanup, and zero remaining observed
root-created pipes. That last assertion does not inspect descendant-created pipes.
The [inherited-descriptor matrix](test-guests.md#inherited-descriptor-browser-regression-gate)
adds 15 original runtime cases across the rebuilt shell and both test guests:
filesystem read/create/readback with persistent fd 3, sparse bindings 10–12,
occupied fds 3–9, nested shell inheritance, and per-guest `3<&0` input. These
30 configured browser executions are independent of the external Bun fixmes.

The 26 source exclusions are explicit scope differences, not newly passing
coverage:

- **16 reference-engine comparison cases:** eight baseline cases plus five
  Bashkit-terminal and three Bashkit cases. This package does not ship those
  engines or their comparison UI.
- **Two cost-profile cases:** Brush and just-bash startup/performance timelines
  belong to the removed comparison host.
- **One just-bash common-fixture duplicate:** the shell-facing fixture remains;
  the separate reference-engine execution does not.
- **Seven Brush-specific core cases:** multiline bracketed-paste behavior;
  combining/grapheme editing; canonical stdin/unsupported-job policy; terminal
  read modes; canonical joined-emoji deletion; canonical text-presentation-symbol
  deletion; and bulk `mapfile`/shared-position Unicode reads. They describe the
  old host/editor or its policy, not demonstrated behavior of this shell host.

The normal-exit raw-guest → shell → next-guest terminal handoff case is retained,
not excluded. Shell-owned terminal-ring, terminal-metadata and output-transform
unit regressions remain here; Bun host-slot, nested-Bun and guest-libc internals
belong to the external guest package rather than copied owner-internal suites.

### Inherited descriptor ownership

`Runtime::stdio` borrows launch bindings by duplicating them. Its caller still owns
and must close the originals. The shell guest instead calls `Runtime::take_stdio`
once. That operation duplicates every launch binding before closing the originals.
If duplication fails, it releases the partial copies and leaves the originals intact.
After transfer, both bootstrap methods reject reuse of the launch snapshot.

The session owns the resulting logical table. Genuine aliases retain their shared
open description until the last alias closes. Private directory preopens are not
launch bindings and remain with the WASI adapter. Duplication preserves file offsets.

The interactive editor borrows current stdin and stdout only while reading a
command, then drops those references before execution. Diagnostics borrow current
stderr only while writing. Closing or replacing the final inherited pipe binding
therefore delivers EOF or EPIPE without waiting for shell exit. The standalone
Node fixture in `scripts/test-own-shell-inherited-ownership.ts` runs the compiled
guest against pinned Waffle descriptors, pipes and polling. It checks peers while
the guest is paused and resumes it afterward. It does not replace worker or browser
transport coverage.

### Descriptor predicates

The shared `test`, `[` and `[[ ]]` unary predicates query open descriptions.
`-p /dev/stdin`, `/dev/stdout` and `/dev/fd/N` recognize both shell-local pipe
ends and transported runtime pipe ends. `-t N` recognizes terminal descriptors.
Closed or missing descriptors are false. Decimal operands accept surrounding
ASCII whitespace and a sign; malformed or signed-64-bit-overflow operands report
`integer expected` and status 2. For `[[ ]]`, that status participates in logical
negation and short circuiting. Other predicate capability errors are unchanged.

The guest calls Waffle's `runtime_proc.fd_kind` on the endpoint's physical handle,
not its logical shell binding. It does not read, reopen, duplicate or retain the
endpoint. Category 0 is other/unknown, never FIFO. Preview1's filetype decoding and
unrelated filesystem predicates are unchanged. Native endpoint/mock tests check
payload, EOF and private-handle routing; `runtime-shell.spec.ts` separately covers
real WASI children, both transported pipe ends, remaps, runtime terminals, files,
closed handles, diagnostics, and worker/pipe retirement.

### Pending external-program coverage

Four Bun-specific cases explicitly skip while the public package surface is
missing: real Bun command lookup; Bun's Node filesystem APIs with nonzero exit,
working directory and exported environment; a yielding Bun producer's EPIPE
status; and nested `Bun.spawn` stdin inheritance. Each is configured for Chromium
and Firefox (eight skipped executions). Generic source guests do not stand in for
these Bun behaviors.

Separately, three pre-existing cases retain known-failure annotations, each
configured for Chromium and Firefox (six known-failure executions, not six
different defects). Their original limitations remain relevant after the public
launcher is available:

- **Bun nonstandard inherited descriptors and shared file offsets:** the external
  Bun payload must be rebuilt and verified with the shared patched-libc scanner
  before these real-Bun assertions can run. bash-web does not build that payload;
  passing its own guests' descriptor matrix would not establish Bun behavior.
- **Bun fd-3 root-preopen discovery:** the external guest has the same rebuild and
  publication prerequisite. Current Waffle returns `BADF` for open non-preopens;
  patched libc distinguishes them from holes with `fd_fdstat_get`. This is not
  a local `NOTSUP` or adapter-relocation limitation. Both Bun executions remain
  explicitly pending external-package delivery, without synthetic metadata.
- **Ctrl+C of Bun.spawn descendants without killing unrelated background work:**
  the legacy guest descendant path still needs shared process/job admission and
  confirmed cooperative cleanup. Both browser executions remain pending; a root
  exit alone is not proof that its foreground descendants have stopped.

The imported integration also had known limits: synchronous Preview1 filesystem metadata
operations can block on a stalled service; device nodes and per-child canonical
terminal editing are not fully implemented. Shared process-directory capacity
is finite (1,024 lifetime slots at the pinned runtime). These are not solved by
moving the shell package or changing import names. Consult the current enabled
and pending browser tests and Waffle's documented capabilities before relying on
any of these paths. Do not fabricate a regular `/dev/null` file or successful
preopen metadata to conceal a missing shared-runtime feature.

## Source provenance

The direct import source is the retired `ShaulLavo/brush-web` prototype at
`a2a4e96f8f771fdd088303535a36c0f43869d10a`. That repository is not a dependency
or a required provenance link: the imported content is retained in `bash-web`
from this browser integration port onward. The local host checkpoint
`50c2e35a61ba8caf1ef3edbbf4a5bdd346b191a6` removed relocated shell material but
left the imported `src/` and `tests/` source unchanged. It is not a different
browser implementation pin.

The direct host revision and the original Bun source revision are distinct.
Adapted Bun source comes from
[`ShaulLavo/bun-wasm`](https://github.com/ShaulLavo/bun-wasm/tree/8d3d416aa9cb23718ed3487a33d0b06e8e373672/web/src)
at `8d3d416aa9cb23718ed3487a33d0b06e8e373672` (MIT). This port preserves that
upstream identity while changing the shared-runtime boundary to the required
Waffle peer. It does not import the prototype's old Brush host, comparison
engines, or vendored `@bun-wasm/runtime` tree.

What the repository contains, by origin:

- **Original code.** The shell facade and bridge, the worker executor, the terminal
  launcher and admission code, the browser host, the storage-readiness adapter,
  the test guests, the build and verification scripts, and the notice aggregator.
  The prototype's embedding adapters are maintained here.
- **Adapted from Bun** (MIT, pinned above). The root lifecycle (`web/src/runner.ts`)
  and the bounded terminal stream (`web/src/runtime-terminals.ts`). Both are
  reduced to shell-specific code on top of the application-supplied Waffle runtime;
  a local cooked-input policy from the prototype's `src/wasi-host.ts` is restored
  on top of the terminal stream.
- **Shared libc patch, not copied.** wasi-libc `libc-bottom-half/sources/preopens.c`
  at `2e6fb9d8ee0cdf9e431fbcabe8af3115de000a13` (wasi-sdk 34.0), patched by
  Waffle's `patches/wasi-libc/preopen-scan.patch`. Builds consume Waffle's patch
  and builder; see the [classified ledger](wasi-libc.md).
- **External shared runtime, not vendored.** Waffle `250967060c0268950266fc5afb85be2170fb8ed3`,
  as the required peer and the identical development pin. The application imports
  `createRuntime` from Waffle's package root.
- **Pinned terminal source.** The Ghostty WebGPU revision and archive checksum
  under `terminal` in `sources.lock.json`, with its included WASM notices.

Exact pins, checksums, import mappings, classifications, and reasons are recorded
under `waffle` and `browserRuntime` in
[`sources.lock.json`](../sources.lock.json). Retain
[Third-party notices](../THIRD_PARTY_NOTICES.md) and generated distribution
notices with copied assets. The frozen shell scoreboard, oracle/baseline and differential-generator records
are unchanged by the browser integration.

## Startup diagnostics

The test page exposes `window.bashWeb.snapshot().startup` as soon as the workbench
mounts, before a shell session exists. Each start has its own generation, a bounded
map of first-observed stage timestamps, and a `pending` list of started awaits with
no observed completion. Timestamps use `performance.timeOrigin + performance.now()`
so page and worker observations share a high-resolution epoch clock. `last` is the
latest timestamp, not a claim about which concurrent task is blocking startup.
Waffle filesystem milestones retain their original worker timestamps. Pending runtime
waits pair connection receipt, IndexedDB open, writer-lock acquisition, and epoch
completion with their observed requests; worker creation alone is not a pending await.
The demo passes its observer to runtime creation, and custom `acquireRuntime` factories
receive it to pass to `createRuntime({ onStartupStage })` themselves. A pre-created
borrowed runtime does not have earlier startup events reconstructed.

Browser test failures print pending stages and attach the full snapshot as
`browser-startup-diagnostics`. Shell embeddings may supply `onStartupStage` to
`createShell` for the same non-blocking observations. Observer throws and rejected
returns are ignored; observers are never awaited. Observers must not abort or start/stop
shell or runtime control, matching [Waffle's passive observer contract](https://github.com/ShaulLavo/waffle/blob/250967060c0268950266fc5afb85be2170fb8ed3/docs/runtime-startup.md).
No polling or history is kept by the observer hook.
An absent marker means unobserved, not pending. In particular, a borrowed runtime
or cached shell registration may have completed work before observation began.
Restart clears timestamps and ignores callbacks from the stopped generation.

## Startup-scoped diagnostic ownership

The original Rust process adapter observes Waffle 0.0.50's non-consuming
`runtime_proc.start_status` with CHILD_START (poll kind 6). The interpreter retains
only redirected stderr during pending startup. It emits START_FAILED diagnostics
before releasing that endpoint, then separately awaits terminal and job cleanup.
Successful entry releases the diagnostic copy before terminal wait; retaining it
until exit can prevent pipe EOF when a producer waits for downstream acknowledgement.
Cancellation before entry leaves the terminal wait's actual exit/signal authoritative.
Fork errors use parent stderr, deliberately closed stderr stays closed, and real
exits 126/127 are not reclassified as startup failures.

Waffle 0.0.50 makes quiet child startup reporting independent of the adapter's
`startFailed` hook. The hook is nevertheless retained: host-initiated adapter
spawns can have a bookkeeping parent without an admitted `runtime_proc`
transport, and the runtime deliberately preserves generic stderr on that path.
Removing the explicit adapter policy changes that supported host-spawn behavior.
The five host-broker modes distinguish this policy from its real default-writer
negative control, post-entry failure and genuine exits 126/127. They do not assert
that a runtime child needs the hook to stay quiet.

The original `src/runtime/lazy-start.test.ts` regression uses the real
`WorkerProcessClient` notification and broker admission path, without registering
any controller hook. Metadata succeeds before a lazy `WebAssembly.CompileError`;
there are zero adapter launches, guest start errno 45 and typed host ENOEXEC 8.
Both terminal and pipe remain empty, the pipe reaches EOF, and the host receives
one full error retaining the original cause and stack. A host-root control keeps
the generic stderr line. These are original API-level tests, not copied upstream
runtime code or test implementations. The browser composition registers a
separate lazy executable at `/bin/test-lazy-start-failure`; exact complete pipe
and regular-file captures reject runtime text or stack bytes, alongside closed
fd 2, actual exits 126/127 and worker-baseline checks.

The compatibility-cleanup Node fixture installs its Worker prototype hooks before
importing the production compatibility entrypoint and requires an observed dispatch
message. Its deliberate interceptor-bypass control rejects missing observation;
the standalone CLI path uses Node WASI, not the browser Waffle executor. Production
`src/runtime/worker.ts` only sets `host.onmessage` and invokes Waffle bootstrap; it
does not replace postMessage or supply a version-specific custom host.
