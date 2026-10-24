# bash-web packaging direction

Status: Approved (owner, 2026-10-17; browser integration direction 2026-10-18).

`bash-web` is the shell package. The shell is a WASM program that a runtime
runs; it is never the runtime itself. Browser process, filesystem, pipe,
network, and page lifecycle services belong to the separate `waffle` package.

## Package boundary

Applications import `createRuntime` from `waffle`, create one shared runtime
per page, and pass that exact instance to `createShell({ runtime })` from
`bash-web`. The JavaScript shell entry imports Waffle's public APIs.
It must not create an implicit runtime, accept an unrelated structural stand-in
as the runtime owner, or duplicate Waffle's shared services.

`waffle` is a required peer dependency pinned to the published commit
`c458a488bba70855c27a2921c2665c7150ef2090` from
`git+https://github.com/ShaulLavo/waffle.git`. Use that exact same pin as a
development dependency for the package's own builds and checks. Remove the
optional-peer marker with the importing JavaScript entry. Runtime implementation
sources are not vendored in this repository.

The shell facade borrows its runtime; a shell's disposal closes its process,
not the page's runtime or other shells. The application disposes the runtime
once its consumers have stopped. Guest workers and shell-specific ABI adapters
may live in `src/runtime/`; they import Waffle for shared filesystem, descriptor,
process, pipe, signal, and lifecycle authority. The shell starts through the supplied
runtime and knows no specific external programs. The application registers the
programs it wants, such as a Bun guest, separately from shell creation.

## Browser integration

Move the own-shell browser integration from `ShaulLavo/brush-web` main revision
`a2a4e96f8f771fdd088303535a36c0f43869d10a` into this package. This brings the
runtime-injected facade, guest/worker adapters, terminal demo, and own-shell
browser acceptance coverage together with the shell they exercise. It is not a
port of the reference engines or the old Brush host. Terminal rendering, browser
controls, and demo state remain separate host concerns in `src/browser/`.

Build `shell-runtime.wasm` from the maintained local shell workspace and serve
it at `/programs/shell-engine.wasm`. Keep it distinct from the stand-in CLI used
by the standalone shell harness. Bundle the shell worker into
`dist/shell-worker.js` for ordinary package consumers; the browser build must
preserve that output rather than serve a raw TypeScript or Vite-specific worker
entry. Bundle Waffle's public `waffle/browser/fs-worker` entry as
`dist/fs-worker.js` too, preserve both stable assets after the browser build,
and pass the application's emitted filesystem worker URL to
`createRuntime({ filesystem: { workerURL } })`.

For the initial delivery, the public Bun installer/worker and verified guest
descriptor are not yet available at a published dependency pin. Include no Bun
host package dependency, copied implementation, guest binary, guest source pin,
or guest-license payload in the shell library. Retain affected Bun-specific tests
with explicit missing-public-API reasons. Wire the external package's launcher
and hash-verified guest descriptor into the test harness once published, on the
same page-owned Waffle runtime. Tiny original source-built test programs may
exercise generic pipeline/process contracts without pretending to be Bun. This
gap must not be described as passing Bun integration or closed browser acceptance.

Document original embedding adapters separately from adapted Bun browser
sources, including both the direct host import revision and the original Bun
source revision. Keep the terminal's existing archive/revision pin. See
[Browser integration](../docs/browser-runtime.md) for the embedding contract,
asset requirements, limitations, and source classifications.

## Execution and acceptance

- Keep Node `>=26.7.0` as the JavaScript tooling baseline.
- Provide `test:browser:package`, `build:browser`, `typecheck:browser`,
  `test:runtime:terminal`, and `test:browser` commands alongside the existing
  standalone shell commands.
- Exercise the browser shell with the same pinned Waffle peer used by consumers;
  do not alias imports to a local copied runtime tree.
- Preserve browser tests' explicit pending cases and limitations. Passing enabled
  browser tests is not evidence that skipped runtime work or Safari has passed.
- Preserve `plans/004-own-shell.md`, extraction history, all frozen scoreboard
  entries/evidence, and generator manifests/fixtures unchanged. Browser integration
  adds gates; it does not recapture or replace standalone compatibility evidence.
- Keep generated distribution notices with the browser assets, including the
  terminal, imported adapter notices, and Waffle. Do not add Bun guest-license
  payloads when the external program itself belongs to another package.

This is the approved implementation direction, not a completion or merge record.
The integration still needs its build, type, terminal, browser, and existing
shell gates verified, review resolved, and the resulting PR merged.

## Approved follow-up: generic terminal backpressure and scoped teardown

The browser adapter currently surfaces, rather than hides, output loss from a
foreign Waffle adapter. A bounded reproduction registers a guest through the
generic Waffle preview1 executor (without bash-web's `resolveTerminal` hook),
then performs one `fd_write` of `OUTPUT_CAPACITY + 1` bytes to inherited stdout
while the page ring is empty. The callback-based Waffle terminal codec reports
all bytes accepted while the bash-web ring retains only `OUTPUT_CAPACITY`; the
adapter now increments `runtimeSnapshot().droppedTerminalBytes`, increments the
root counter, and emits a visible console diagnostic instead of claiming that
all bytes were written. This is an observability guard, not a lossless fix.

The target Waffle follow-up must provide a bounded, synchronous terminal
capability with explicit accepted-byte/EAGAIN semantics before `fd_write`
returns. The preferred shape is a runtime-owned finite shared terminal endpoint
(or existing pipe endpoint plus preserved web-terminal provenance) in the
terminal token, with worker-side write admission and wake-up; a `void`
`postMessage` callback or an unbounded page queue is not sufficient. This endpoint
also owns proper terminal input discipline: cooked readers receive ICRNL
(carriage-return to newline translation) and canonical echo, while the shell's
line editor can request raw passthrough. Bash-web restores its predecessor's
terminal-host behavior in a bounded local adapter, not a full tty. Its per-worker
CRLF state does not span cloned buffer wrappers: add a regression that splits a
CRLF pair across a reader handoff between workers and require one cooked newline
from the runtime-owned endpoint. This local restoration is not a substitute for
that endpoint. The same follow-up should provide
a per-runtime-root teardown join that fences active
and reserved descendants, late accepted launches, controller stops, and
physical handles while excluding unrelated roots. Until those public contracts
land, bash-web does not claim lossless foreign-adapter output or full physical
teardown of descendants; its shell-owned cleanup is tracked locally.

## Approved follow-up: runtime-owned process and pipe introspection

Expose read-only process and pipe snapshots from Waffle, the owner of both
tables. Its supervisor already exposes `table`; consumers should not need to
observe or intercept worker messages to reconstruct runtime state. The snapshot
must distinguish live pipes, process ownership and descendant membership without
retaining endpoints, pumping relays, or changing disposal authority.

The current limitation is exact: at Waffle `c458a488`,
`browser/process-broker.ts:436-442` consumes child `runtime-proc` messages and
returns without calling `WorkerLaunchOptions.onMessage`. Bash-web's
`src/runtime/diagnostics.ts:99` therefore observes root-shell pipe requests, but
not pipe requests created inside a nested shell worker. A root snapshot can
report zero observed pipes while a descendant still owns a live pipe. Existing
zero-pipe browser assertions are limited to the observed root-created pipes;
they do not establish whole-tree pipe cleanup.

Add a Waffle regression that holds a nested worker's pipe live, verifies its
appearance in the read-only runtime snapshot with the correct process/root
identity, then closes both ends and verifies its removal. Bash-web can consume
that snapshot after the API lands. Do not add a message-spying hook or a second
pipe registry in the shell adapter to fill this debug-telemetry gap.
