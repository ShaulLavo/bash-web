# Getting started

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
[Browser integration](browser-runtime.md). Omitting `script` starts the
persistent interactive editor; the host connects the shell's terminal byte
bridge to its UI. Terminal rendering and demo controls live in `src/browser/`,
separate from the shell facade.

`waffle` is a **required peer dependency**, pinned to the published Git commit
`f2bb4bbb727fcf74f4ad1c2792e7aea6bbac2d18`:
`git+https://github.com/ShaulLavo/waffle.git#f2bb4bbb727fcf74f4ad1c2792e7aea6bbac2d18`.
The development dependency uses the same pin so local builds and tests exercise
the same runtime applications supply.

## Build and test

Prerequisites are Node 26.7.0, npm, Rust 1.98.1 through rustup, wasmtime for
WASI tests, and wasi-sdk **34.0** for every WASI guest build. Rebuilding its libc
also needs CMake **3.26+**, Ninja, curl, tar, patch, sha256sum, Linux setsid,
GNU timeout, and flock. The frozen compatibility oracle requires exactly Node
26.7.0; CI and standalone verification use that version. See
[guest libc and build provenance](wasi-libc.md) for the shared patch, final-link
requirements, cache ownership, and cleanup.

On the development PC, verify the data mount and free space before downloading
or building, and admit heavy work through the shared build queue. Put toolchains,
Playwright browsers, and caches on the data SSD; the following paths are PC
examples, not downloads performed by these commands:

```sh
findmnt -T /work
df -h /work
export PATH=/work/cache/wasm-tools/cmake/bin:/work/cache/wasm-tools/ninja:$PATH
export WASI_SDK_PATH=/work/cache/wasi-sdk-34.0-x86_64-linux
export WASI_LIBC_SCRATCH_ROOT=/work/tmp
export PLAYWRIGHT_BROWSERS_PATH=/work/cache/ms-playwright
```

Use your installed SDK/tool/cache locations on other hosts.

```sh
git clone https://github.com/ShaulLavo/bash-web.git /work/projects/bash-web
cd /work/projects/bash-web
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

Browser tests require the Playwright browsers used by their configured projects:

```sh
npx playwright install chromium firefox
```

For the standalone demo after building, run `npm run serve`; it listens at
`http://127.0.0.1:4187` by default (`PORT` overrides the port). A remote preview must use an owner-reachable private app URL, not this
host's localhost address.
The browser build publishes the real `shell-runtime.wasm` at
`/programs/shell-engine.wasm` and bundled JavaScript workers at
`dist/shell-worker.js` and `dist/fs-worker.js`. The filesystem worker is built
from Waffle's public `waffle/browser/fs-worker` entry; applications own its served
URL and pass it to `createRuntime`. The browser shell is not the stand-in CLI. This package
contains no Bun launcher, runtime implementation, guest binary, or guest-license
payload. Bun-specific browser cases remain pending until the external package
publishes the required installer/worker APIs and verified guest descriptor; see
[the current boundary and limitations](browser-runtime.md).

The shell-only CI also runs the native and WASI suites, size ceiling,
scoreboard runner tests, generator source tests and fixed fixture replays.
Run the individual shell fuzz replays with the `:ci` scripts in
`package.json`; they use only the committed generator and fixture bytes.

The frozen compatibility score can be replayed without downloading corpora,
installing GNU Bash, or installing browser assets. A fresh WASI build still needs
the installed Waffle dependency and patched-libc build prerequisites above. The full compatibility CI job
also runs sandbox and transport tests, which require bubblewrap and Python 3:

```sh
BASH_COMPAT_BASE_REF=$(git rev-parse HEAD) npm run compat:shell
```

For explicit maintenance capture, prepare the pinned corpus sources only with
`npm run prepare:shell-corpus`. That command verifies archive checksums and
does not build an engine. Capture itself requires Linux, GNU Bash 5.3.15,
bubblewrap, Python's standard library, and the `yaml` package.

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
classifications are in [`sources.lock.json`](../sources.lock.json). Keep the
generated `dist/THIRD_PARTY_NOTICES.txt` with distributions; shell-only notices
can be regenerated with `npm run notices:shell`. See
[Third-party notices](../THIRD_PARTY_NOTICES.md) and the
[browser source provenance](browser-runtime.md#source-provenance) for the
browser adapters, peer runtime, and terminal notices.

## Host boundary

A shell owns shell semantics and its own process handle. It borrows the page's
runtime; closing a shell must not dispose that runtime or unrelated shells.
The page owns runtime disposal. Waffle owns shared services and their teardown;
terminal rendering, browser controls, and asset serving remain host concerns.
Browser acceptance complements the frozen shell scoreboard and never replaces
or regenerates its oracle, baseline, classifications, or generator fixtures.
