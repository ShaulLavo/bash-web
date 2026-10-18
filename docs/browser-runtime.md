# Browser integration

`bash-web` runs its WASI shell in a browser worker. It provides shell semantics
and the shell-specific guest/terminal adapter, not a second browser runtime.
The application creates one shared Waffle runtime for the page, gives that
runtime to its shells, and disposes it when the page's consumers have stopped.

## Embed a shell

Use Node 26.7.0 for the frozen compatibility oracle and CI; newer Node
versions may work for development tooling. Use a browser-capable bundler for the
TypeScript entry and its worker imports. Install the required `waffle` peer at
the exact pin in `package.json`:

```text
git+https://github.com/ShaulLavo/waffle.git#8bfc767d6097cf3c741092328573460a3047d114
```

The package's development dependency uses that same published commit. There
is no local runtime-tree alias or vendored runtime fallback.

```ts
import { createRuntime } from "waffle";
import { createShell } from "bash-web";

// This URL serves Waffle's bundled public filesystem-worker entry.
const runtime = createRuntime({
  filesystem: { workerURL: new URL("/fs-worker.js", location.href) },
});
const shell = await createShell({ runtime });

// Connect shell.terminal to the application's terminal UI.
// The host forwards input/resize and drains output without blocking the page.

// Stop this shell without disposing other consumers of the same runtime.
await shell.dispose();

// At page teardown, the application owns shared-runtime disposal.
await runtime.dispose();
```

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
`interrupt()` addresses that shell's foreground execution; it must not terminate
unrelated background jobs or other shells sharing the runtime. `await dispose()` stops
that shell and joins its locally observed shell-adapter worker cleanup. This does
not guarantee physical cleanup of descendants launched through foreign adapters;
a generic root-scoped runtime teardown join remains approved follow-up work.
`diagnostics()` observes the shell, while
`runtimeSnapshot(runtime)` from the package root synchronously observes the
shared runtime without creating a process service. The application remains
responsible for `await runtime.dispose()` once the shared runtime is no longer
needed.

## Storage ownership, waiting and disposal

The application owns storage selection and the runtime lifetime; Waffle owns
storage locks, recovery and filesystem workers. The demo's `mountBrowser` borrows
`{ runtime }` without disposing it, or accepts an `acquireRuntime()` factory
returning `{ runtime, ready, dispose }`. A factory lease owns its preparation
and must provide idempotent, awaited disposal even if preparation is still
pending. Without either option, the demo creates and owns one runtime.

`src/browser/storage.ts` observes `runtime.filesystem.state` before shell
admission. `opening` and `waiting` are not shell failures: the host shows
“Waiting for another tab to release storage…” and keeps input disabled until
storage is ready. The observer preserves an existing `onStateChange` callback
and detaches its own listener after readiness, cancellation or failure. The
shell's 60-second startup timeout begins **after** storage is ready. Initial
`opening` has its own separate 60-second guard; expiry reports “Browser storage
did not become ready within 60 seconds.” Entering `waiting` disarms that guard.
Waiting may last indefinitely while another tab owns the workspace, and the typed
state remains `waiting` through recovery. The passive `filesystem-lock-acquired`
milestone starts a fresh 60-second active-recovery guard, separate from both opening
and shell startup. Repeated waiting states or milestones cannot erase or extend it.
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
[storage ownership contract](https://github.com/ShaulLavo/waffle/blob/8bfc767d6097cf3c741092328573460a3047d114/docs/storage.md).

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
lossless. The [approved follow-up](../plans/005-bash-web-packaging.md#approved-follow-up-generic-terminal-backpressure-and-scoped-teardown)
requires synchronous accepted-byte/EAGAIN semantics and root-scoped teardown.

Diagnostics attach manual pipe observers without taking relay, endpoint or
disposal ownership. Their pipe counts cover requests observed from the shell
root, not every descendant's pipes: Waffle handles child-worker process messages
internally, so nested shell-created pipes are not included. A zero count is not
proof that the entire process tree has no live pipes. Closed observations are
reclaimed on a 100 ms sweep rather than waiting for another snapshot; retiring
the root clears its timer. The [approved introspection follow-up](../plans/005-bash-web-packaging.md#approved-follow-up-runtime-owned-process-and-pipe-introspection)
will replace message-derived pipe counts with Waffle-owned read-only snapshots.

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

Install the [build prerequisites](getting-started.md#build-and-test), including
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

### Migrated browser scope

The current Playwright listing (`playwright test --list`) contains 106 unique
cases configured once for Chromium and once for Firefox: 212 configured
executions. This is configuration inventory, not final browser acceptance
evidence; a configured or runnable case is not a passing result.

| Suite                               | Configured cases | Runnable cases | Missing public Bun API | Original known failures | New engine/Waffle pending |
| ----------------------------------- | ---------------: | -------------: | ---------------------: | ----------------------: | ------------------------: |
| Shell                               |               12 |             11 |                      0 |                       0 |                         1 |
| External commands                   |               26 |             24 |                      2 |                       0 |                         0 |
| Pipelines                           |               19 |             18 |                      1 |                       0 |                         0 |
| Runtime                             |               38 |             34 |                      1 |                       3 |                         0 |
| Startup diagnostics                 |                3 |              3 |                      0 |                       0 |                         0 |
| Storage lifecycle                   |                6 |              6 |                      0 |                       0 |                         0 |
| Worker assets and renderer fallback |                2 |              2 |                      0 |                       0 |                         0 |
| **Unique cases**                    |          **106** |         **98** |                  **4** |                   **3** |                     **1** |
| **Chromium + Firefox executions**   |          **212** |        **196** |                  **8** |                   **6** |                     **2** |

The `command` and byte-exact `printf` external-guest cases are runnable following
the functions and printf units.
Six formerly pending external-command cases are now enabled by Waffle #10 at
`ba968a6f86468d03394792a3e9c447dfc713c279` and the shell's asynchronous executable
access/PATH-search unit:

| Activated case                   | Contract now exercised                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Unregistered files fail with 126 | Existing regular files require a program registration; the command host remains usable after rejection. |
| Relative executable lookup       | Explicit `./test-guest` resolves against the shell's current directory.                                 |
| Dot-segment executable lookup    | A live filesystem walk resolves `/bin/../bin/./test-guest` to its canonical registration.               |
| Missing relative executable      | A missing explicit path fails with 127 without starting a guest.                                        |
| Deleted registered executable    | Deleting a registered marker prevents execution and produces 127.                                       |
| Registered directory replacement | Replacing a registered marker with a directory prevents execution and produces 126.                     |

Six additional original cases exercise PATH candidate skipping and relative/empty
components; denied-versus-missing search status and recovery; regular-file
intermediates/trailing slashes; root-parent traversal; a missing intermediate
before `..`; and shared `command -v`/`-V` lookup, including a deleted marker.
Rejected paths must not emit guest output or leave a child worker.
The registration helper's unit regressions separately check canonical-only keys,
caller-created markers before guest registration, and cancellation during marker
creation. Enabling a case is not evidence that it has passed a browser run.

The remaining engine pending case and its exact reason string is:

| Case                                                             | Reason                                                                                           |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `$$` and `BASHPID` report a stable PID and the shell stays alive | `Pending plan 004 $$/BASHPID runtime identity unit: the engine needs an authoritative PID hook.` |

The original four Bun API skips remain separate from the remaining engine pending
case, and the three inherited known-failure fixmes remain unchanged.

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

| Classification                                                      | Source and destination                                                                                                                                                                                                              | Local changes and reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Original embedding adapters, imported and maintained here           | Prototype `src/{shell.ts,bridge.ts,shell-terminal-output.ts}` and `src/runtime/{guest-imports.ts,terminal-admission.ts,limits.ts}`                                                                                                  | Inject the actual Waffle runtime; retain bounded terminal transport, newline handling, truthful preopen/control imports, launch-binding enumeration, and process-local terminal admission. The facade does not create a runtime or register Bun. These are original adapters, not a copied upstream shell interpreter.                                                                                                                                                                                                                                                                                                                        |
| Adapted root lifecycle with original shell-host integration         | Bun `web/src/runner.ts` → prototype `src/runtime/browser-runtime.ts` → `src/runtime/shell-host.ts`                                                                                                                                  | Retain shell-specific launch/outcome fencing; replace the prototype's runtime owner and program registry with the application-supplied Waffle runtime. Shared lifecycle authority belongs to Waffle.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Original shared-terminal launcher                                   | Prototype `src/runtime/{browser-runtime.ts,subprocess-broker.ts}` → `src/runtime/worker-launcher.ts`                                                                                                                                | Delegate launch to Waffle's `service.launchWorker`, retaining a terminal consumer and wiring controller quiesce/revoke/stop hooks. Waffle owns generic lifecycle and process/descriptor transport. The earlier source broker derives from Bun `web/src/subprocess-broker.ts` at `8d3d416…`; no generic broker is retained here.                                                                                                                                                                                                                                                                                                               |
| Original package entry, diagnostics, and targeted regressions       | `src/index.ts`, `src/runtime/diagnostics.ts`, `src/runtime/{diagnostics.test.ts,terminal.test.ts,shell-host.test.ts,worker.test.ts,child-status.test.ts}`                                                                           | Export the shell facade and borrowed observations, including dropped-terminal-byte counters. Manual pipe observations reclaim closed entries on a 100 ms sweep without relay/disposal ownership; retiring a root clears its timer. Original diagnostics regressions check the closed getter before any snapshot and verify root retirement stops the timer. New original regressions cover terminal streams, cancelable startup/admission retry, typed child startup status, memory telemetry and locally scoped cleanup, not foreign-adapter teardown guarantees or copied upstream suites.                                                  |
| Shell-specific worker executor                                      | Prototype `src/runtime/worker.ts` → `src/runtime/worker.ts`; earlier integration lineage: Bun `web/src/worker.ts`                                                                                                                   | Reduce the imported shell integration to a small original `WorkerExecutor` passed to the published `waffle/browser/worker` bootstrap. Keep shell imports/phase/memory observations only; Waffle owns generic WASI/descriptor/process/pipe/signal setup and worker cleanup. No generic runtime implementation is copied.                                                                                                                                                                                                                                                                                                                       |
| Adapted bounded terminal stream and original prototype input policy | Bun `web/src/runtime-terminals.ts` → `src/runtime/runtime-terminals.ts` via the prototype; original prototype `src/wasi-host.ts` cooked-input policy                                                                                | Retain `createBridgeTerminal`, the bounded shared-terminal stream adapter, and restore cooked carriage-return/newline handling while preserving raw editor input. Local CRLF state is shared by endpoints referencing the same buffer wrapper in one worker, not a generic cross-worker tty discipline. Remove the local descriptor/terminal codec: Waffle owns that codec and transport.                                                                                                                                                                                                                                                     |
| Original external-program acceptance harness                        | `tests/browser-main.ts` and `tests/helpers/{test-programs.ts,bun-fixture.ts}`                                                                                                                                                       | The page owns the shared runtime and source-guest lease. Register the compiled cooperative `test-guest` and source-admitted/instrumented `test-spin` only at canonical absolute paths after writing their marker files, through the existing shell adapter on that same runtime, without copying runtime or ABI-host implementations. Bare commands exercise shell PATH search, not registry-only aliases. The injected Bun installer contract exposes the missing public capability explicitly; four genuinely Bun-specific cases remain skipped, with no Bun dependency or payload. The generic production host knows no specific programs. |
| Original browser host and regressions                               | Prototype `src/{main.tsx,session.ts,style.css,shell-terminal-output.test.ts}` → `src/browser/{main.tsx,session.ts,style.css,terminal-output.test.ts}`; `tests/{pipelines.acceptance,runtime-shell,external-commands,shell}.spec.ts` | Keep renderer and page controls outside the shell facade and remove reference-engine UI. Reuse the root library's `TerminalNewlines` rather than copying a second transformer into the page. Tests exercise the real shell asset and preserve explicit pending external-program cases; they do not replace frozen shell evidence.                                                                                                                                                                                                                                                                                                             |
| Original consumer storage-readiness adapter                         | `src/browser/storage.ts`, `src/browser/{session.ts,main.tsx}`, and `tests/browser-main.ts`                                                                                                                                          | Observe Waffle ownership/recovery states before shell admission, guard initial opening separately from shell startup, preserve existing observers, and cancel local waits. Borrow app runtimes or accept owner-supplied leases; await session and owned-lease disposal on restart/stop. No storage backend, ownership lock or persistence implementation copied.                                                                                                                                                                                                                                                                              |
| Original prototype terminal/guest-adapter unit regressions, adapted | Prototype `src/runtime/{terminal.test.ts,guest-imports.test.ts}` → `tests/{terminal.unit.ts,guest-imports.unit.ts}`                                                                                                                 | Retain shell-owned bounded-ring/admission/terminal metadata cases with public Waffle APIs. Bun host-slot and real-guest libc internals remain external-package tests, not copied shell-library suites.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Original browser configuration, adapted                             | Prototype `playwright.config.ts`, `vite.config.ts`, `tsconfig.json`, `index.html`, and the browser sequence in `.github/workflows/ci.yml` → the same destinations                                                                   | Build/serve/test the own-shell page with the required Waffle peer; drop reference-engine setup without replacing existing standalone shell gates.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Original prototype build helpers, adapted                           | Prototype `scripts/{sources.mjs,build-shell-browser.mjs,test-runtime-terminal.mjs}` → the same destinations                                                                                                                         | Preserve terminal/archive verification, remove Brush submodule setup and Bun payload handling, build the local shell runtime directly, and select the new adapter unit paths.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Original prototype server/build-output helpers, imported/adapted    | Prototype `scripts/{serve.mjs,finish-build.mjs}` → the same destinations                                                                                                                                                            | Retain server isolation; preserve the prebundled shell worker after the browser build clears its output.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Original bundled worker builder                                     | `scripts/build-worker.mjs`                                                                                                                                                                                                          | Emit `.build/browser/{shell-worker,fs-worker}.js` and stable `dist/{shell-worker,fs-worker}.js` from the shell-specific executor and Waffle's public filesystem-worker entry. Restore both after Vite; the app supplies the filesystem URL to its runtime. No copied runtime source or raw TypeScript worker contract.                                                                                                                                                                                                                                                                                                                        |
| Original worker-asset and renderer regressions                      | `tests/worker-assets.spec.ts`                                                                                                                                                                                                       | Check that production startup loads one emitted filesystem worker, stable worker URLs serve JavaScript, and a browser with no available WebGPU adapter opens a usable Canvas terminal. These are new original tests, not imported suite cases.                                                                                                                                                                                                                                                                                                                                                                                                |
| Original source-built test guests and builder                       | `tests/guest/{Cargo.toml,Cargo.lock,README.md,src/main.rs,src/bin/test-spin.rs}` and `scripts/build-test-guest.mjs`                                                                                                                 | Build `test-guest` for cooperative generic process-ABI exercises and `test-spin` with only WASI imports and a genuine no-checkpoint CPU loop to exercise source interrupt admission. JSON encoding, ABI callers and finite libc-backed filesystem/literal-descriptor probes are original. Link both against Waffle's patched sysroot and verify final scanner code; publish ignored test assets, not Bun substitutes or shell-library program payloads.                                                                                                                                                                                       |
| Shared wasi-libc port, maintained externally                        | Upstream `libc-bottom-half/sources/preopens.c` at wasi-libc `2e6fb9d8ee0cdf9e431fbcabe8af3115de000a13` (wasi-sdk 34.0); Waffle `patches/wasi-libc/preopen-scan.patch`                                                               | Consume Waffle's single patch and builder, never a local copy. Skip occupied non-preopens via fdstat, stop at the first hole and preserve fatal errors; see the [classified ledger](wasi-libc.md).                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Original WASI build and final-artifact tooling                      | `scripts/{wasi-build.ts,verify-wasi-guests.ts,build-shell.ts}`, shell/browser/test/scoreboard build callers, and `.cargo/config.toml`                                                                                               | Select the shared patched sysroot for every Rust WASI compile/final link with self-contained libc disabled; prove patched scanner calls or original Rust WASI import identities and check the 256 MiB memory maximum in final artifacts, including archived scoreboard-migration builds. No upstream builder implementation copied.                                                                                                                                                                                                                                                                                                           |
| Original inherited-descriptor browser regression matrix             | `tests/runtime-shell.spec.ts` and `tests/guest/src/{main.rs,bin/test-spin.rs}`                                                                                                                                                      | Check filesystem access alongside literal inherited fd 3, sparse/occupied layouts, nested shells and input inheritance for every rebuilt guest. Existing shell operations through the original Rust WASI adapter and ordinary libc-backed fixture probes, not external Bun evidence.                                                                                                                                                                                                                                                                                                                                                          |
| Original browser notice aggregator                                  | `scripts/browser-notices.mjs`                                                                                                                                                                                                       | New distribution integration collecting shell, terminal, peer and npm notices; no additional upstream code copied.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Original browser packaging regressions                              | `scripts/test-browser-package.mjs`                                                                                                                                                                                                  | Verify peer/development/lock pin identity and the absence of copied runtime/Bun implementation sources or Bun payloads before the browser build; no upstream tests copied.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| External shared runtime, not vendored                               | Waffle `8bfc767d6097cf3c741092328573460a3047d114`                                                                                                                                                                                   | Required peer plus identical development pin. The application imports the single `createRuntime` from Waffle's package root.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Pinned terminal source                                              | Ghostty WebGPU source/archive pin under `terminal` in `sources.lock.json`                                                                                                                                                           | Retain the existing terminal source revision/archive checksum and its included WASM notices; do not substitute an unpinned terminal build.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

Exact pins, checksums, import mappings, classifications, and reasons are recorded
under `waffle` and `browserRuntime` in
[`sources.lock.json`](../sources.lock.json). Retain
[Third-party notices](../THIRD_PARTY_NOTICES.md) and generated distribution
notices with copied assets. The extraction records, plan 004, frozen shell
scoreboard, oracle/baseline, and differential-generator records are independent
historical evidence and are unchanged by the browser integration.

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
shell or runtime control, matching [Waffle's passive observer contract](https://github.com/ShaulLavo/waffle/blob/8bfc767d6097cf3c741092328573460a3047d114/docs/runtime-startup.md).
No polling or history is kept by the observer hook.
An absent marker means unobserved, not pending. In particular, a borrowed runtime
or cached shell registration may have completed work before observation began.
Restart clears timestamps and ignores callbacks from the stopped generation.
