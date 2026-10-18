# bash-web

`bash-web` is a WASM-first bash-compatible shell: a Rust parser and shell
engine, a browser embedding adapter, and standalone verification. Its original
shell commits, fixtures, oracle observations, and compatibility harness are
preserved.

The shell is a WASM program, not a browser runtime. The separate
[`waffle`](https://github.com/ShaulLavo/waffle) package owns filesystem, process,
pipe, and page lifecycle services. Create **one runtime per page**, then pass it
to each shell. The shell adapter imports Waffle; it does not vendor a runtime or
create a second runtime behind the application's back. Applications register
external programs with their runtime; the shell does not register Bun or other
programs implicitly.

```ts
import { createRuntime } from "waffle";
import { createShell } from "bash-web";

// Serve the bundled Waffle filesystem worker at this application-owned URL.
const runtime = createRuntime({
  filesystem: { workerURL: new URL("/fs-worker.js", location.href) },
});
try {
  const shell = await createShell({ runtime, script: "printf 'hello\\n'" });
  try {
    const result = await shell.done;
    console.log(result.code);
  } finally {
    await shell.dispose();
  }
} finally {
  await runtime.dispose();
}
```

This is a browser/bundler entry, not a Node shell launcher. Serve the shell
and guest assets with the isolation headers described in
[Browser integration](docs/browser-runtime.md). Omitting `script` starts the
persistent interactive editor; the host connects the shell's terminal byte
bridge to its UI. Terminal rendering and demo controls live in `src/browser/`,
separate from the shell facade.

`waffle` is a **required peer dependency**, pinned to the published Git commit
`b1f2b7dddb32eb52c6423c0ab12dc2e21ea699ea`:
`git+https://github.com/ShaulLavo/waffle.git#b1f2b7dddb32eb52c6423c0ab12dc2e21ea699ea`.
The development dependency uses the same pin so local builds and tests exercise
the same runtime applications supply.

## Build and test

Prerequisites are Node 26.7.0, npm, Rust 1.98.1 through rustup, and
wasmtime for WASI tests. The frozen compatibility oracle requires exactly
Node 26.7.0; CI and standalone verification use that version.

```sh
git clone https://github.com/ShaulLavo/bash-web.git
cd bash-web
rustup toolchain install 1.98.1 --profile minimal --component rustfmt --target wasm32-wasip1
npm ci
npm run build:shell
npm run test:rust
npm run test:shell:wasi
```

Build and check the browser integration separately:

```sh
npm run test:browser:package
npm run build:browser
npm run typecheck:browser
npm run test:runtime:terminal
npm run test:browser
```

Browser tests require the Playwright browsers used by their configured projects.
The browser build publishes the real `shell-runtime.wasm` at
`/programs/shell-engine.wasm` and bundled JavaScript workers at
`dist/shell-worker.js` and `dist/fs-worker.js`. The filesystem worker is built
from Waffle's public `waffle/browser/fs-worker` entry; applications own its served
URL and pass it to `createRuntime`. The browser shell is not the stand-in CLI. This package
contains no Bun launcher, runtime implementation, guest binary, or guest-license
payload. Bun-specific browser cases remain pending until the external package
publishes the required installer/worker APIs and verified guest descriptor; see
[the current boundary and limitations](docs/browser-runtime.md).

The shell-only CI also runs the native and WASI suites, size ceiling,
scoreboard runner tests, generator source tests and fixed fixture replays.
Run the individual shell fuzz replays with the `:ci` scripts in
`package.json`; they use only the committed generator and fixture bytes.

The frozen compatibility score can be replayed without downloading corpora,
installing GNU Bash, or installing browser assets. The full compatibility CI job
also runs sandbox and transport tests, which require bubblewrap and Python 3:

```sh
BASH_COMPAT_BASE_REF=$(git rev-parse HEAD) npm run compat:shell
```

For explicit maintenance capture, prepare the pinned corpus sources only with
`npm run prepare:shell-corpus`. That command verifies archive checksums and
does not build an engine. Capture itself requires Linux, GNU Bash 5.3.15,
bubblewrap, Python's standard library, and the `yaml` package.

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
shell or runtime control, matching [Waffle's passive observer contract](https://github.com/ShaulLavo/waffle/blob/b1f2b7dddb32eb52c6423c0ab12dc2e21ea699ea/docs/runtime-startup.md).
No polling or history is kept by the observer hook.
An absent marker means unobserved, not pending. In particular, a borrowed runtime
or cached shell registration may have completed work before observation began.
Restart clears timestamps and ignores callbacks from the stopped generation.

## Repository layout

- `shell/` contains the parser and WASI shell engine.
- `src/shell.ts` exposes the runtime-injected browser shell API.
- `src/runtime/` contains guest/worker embedding adapters that import Waffle.
- `src/browser/` contains the terminal demo and page-level UI concerns.
- `tests/` contains browser acceptance tests.
- `scripts/` contains browser build helpers, the shell runner, scoreboard,
  provenance checks, and differential generators.
- `scripts/fixtures/` contains frozen generator inputs; do not regenerate them
  during ordinary maintenance.
- `docs/evidence/` contains frozen oracle, baseline, and classification data.
- `docs/extraction/` preserves the shell extraction's commit mapping and records.
- `plans/004-own-shell.md` records the approved shell work, and
  `plans/005-bash-web-packaging.md` records the package boundary.

The pinned source revisions, archive checksums, and implementation
classifications are in [`sources.lock.json`](sources.lock.json). Keep the
generated `dist/THIRD_PARTY_NOTICES.txt` with distributions; shell-only notices
can be regenerated with `npm run notices:shell`. See
[Third-party notices](THIRD_PARTY_NOTICES.md) and the
[browser source provenance](docs/browser-runtime.md#source-provenance) for the
browser adapters, peer runtime, and terminal notices.

## Host boundary

A shell owns shell semantics and its own process handle. It borrows the page's
runtime; closing a shell must not dispose that runtime or unrelated shells.
The page owns runtime disposal. Waffle owns shared services and their teardown;
terminal rendering, browser controls, and asset serving remain host concerns.
Browser acceptance complements the frozen shell scoreboard and never replaces
or regenerates its oracle, baseline, classifications, or generator fixtures.
