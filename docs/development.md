# Development

How to build bash-web, run its checks, and find your way around the repository. For the design, read [Architecture](concepts/architecture.md). For the inside of the engine, read [Engine ownership notes](reference/engine-ownership.md).

## Choose your setup

| You want to | You need | Time |
| ----------- | -------- | ---- |
| Change the Rust engine or parser, run native tests | Rust through rustup | about 2 minutes for `npm run test:rust` on an M1 laptop |
| Build the WASM guests and run the WASI tests | The above, plus wasi-sdk 34.0, wasmtime, CMake, Ninja | a full patched-libc build on first run |
| Build and test the browser demo | The above, plus Playwright browsers | longest |
| Replay the frozen compatibility score | The WASI build, plus the installed Waffle dependency | see [Bash compatibility](bash-compatibility.md) |

CI builds the WASM guests on `ubuntu-latest`, and the wasi-sdk default path in `scripts/wasi-build.ts` is a Linux x86_64 build. The WASI and browser steps are verified on Linux only. The native Rust steps also run on macOS (see [Status](status.md#platforms)).

## Prerequisites

- Node `>=26.12.1` and npm. `package.json` sets `engines` and CI uses 26.12.1. The compatibility replay is stricter: `scripts/bash-compat.mjs` refuses to run unless `process.version` equals the oracle's recorded `v26.12.1`.
- Rust 1.98.1 through rustup. `rust-toolchain.toml` pins it with the `rustfmt` and `clippy` components and the `wasm32-wasip1` target, so rustup installs it the first time you run `cargo` in the repository.
- For WASI guests: wasi-sdk **34.0** (set `WASI_SDK_PATH`), wasmtime, CMake **3.26+**, Ninja, curl, tar, patch, sha256sum, Linux `setsid`, GNU `timeout`, and `flock`. The shared libc patch and builder come from Waffle. See [Guest libc and build provenance](wasi-libc.md).
- For browser tests: `npx playwright install chromium firefox`.
- For score capture only: Linux, GNU Bash 5.3.15, bubblewrap, and Python 3. Replay needs none of these.

## Build and test

```sh
git clone https://github.com/ShaulLavo/bash-web.git
cd bash-web
npm ci
npm run build:shell       # WASI shell engine, needs wasi-sdk
npm run test:rust         # parser provenance, rustfmt, native workspace tests
npm run test:shell:wasi   # WASI tests under wasmtime and the brotli size ceiling
```

`npm run test:rust` ends with the native test summary. At commit `a26ce56` the workspace has 1,648 passing tests on macOS arm64.

Build and check the browser integration separately:

```sh
npm run test:browser:package
npm run build:browser
npm run typecheck:browser
npm run test:runtime:terminal
npm run test:browser
```

`npm run serve` starts the standalone demo at `http://127.0.0.1:4187` after a build. `PORT` overrides the port. The demo sends the isolation headers described in [Browser integration](browser-runtime.md#serve-the-assets).

The shell CI job also runs the native and WASI suites, the size ceiling, the scoreboard runner tests, the generator tests, and the fixed fuzz replays. Run one replay with its `:ci` script in `package.json`, for example `npm run fuzz:shell-echo:ci`. See [CI inputs and job ownership](ci.md), [Code quality gates](code-quality.md), and [Shell fuzzing](shell-fuzzing.md).

### Replay the compatibility score

```sh
BASH_COMPAT_BASE_REF=$(git rev-parse HEAD) npm run compat:shell
```

This replays the frozen oracle without downloading corpora or installing GNU Bash. It builds the WASI guests first, so it needs the WASI prerequisites. Each parallel runner needs about 1.2 GiB. Set `BASH_COMPAT_JOBS=1` on a small machine. The corpus preparation step (`npm run prepare:shell-corpus`) and score capture are maintenance tasks. See [Bash compatibility](bash-compatibility.md#own-shell-fixed-scoreboard).

## Frozen files

Do not regenerate or edit these in ordinary work. Scripts check them by digest.

- `docs/evidence/`: oracle, baseline, receipts. See its [README](evidence/README.md).
- `scripts/fixtures/`: generator inputs and recorded Bash output.
- `sources.lock.json`: pinned source revisions, archive checksums, and the provenance of every copied or adapted file.
- `THIRD_PARTY_NOTICES.md` and `dist/THIRD_PARTY_NOTICES.txt`: ship these with any distribution. `npm run notices:shell` regenerates the shell-only notices.

## Repository layout

- `shell/parser/`: the parser crate (`shell-parser`), started from Bashkit's parser.
- `shell/engine/`: the async shell engine. It builds `shell-engine` (CLI and size harness) and `shell-runtime` (the browser guest).
- `shell/utilities/`: `cat`, `grep`, `mkdir`, and `seq` as separate WASM programs.
- `shell/compat-fixtures/`: test-only guests (`argv-py`, `printenv-py`) and `shell-cli`, the engine composed with the utilities. Never packaged.
- `src/shell.ts`, `src/index.ts`: the public API. See [API reference](reference/api.md).
- `src/runtime/`: adapters that connect the shell guest to Waffle.
- `src/utilities/`: the install entries for each utility.
- `src/browser/`: the demo page and its terminal UI. Not part of the shell API.
- `tests/`: Playwright acceptance tests. `tests/guest/` holds the source-built `test-guest` and `test-spin` programs ([Test guests](test-guests.md)).
- `scripts/`: build helpers, the scoreboard, differential fuzzers, provenance checks.
- `docs/`: this documentation. [Docs map](README.md).
- `plans/`: internal planning notes, not documentation. Frozen evidence and `sources.lock.json` name this path, so it stays.

## Engine layer gate

The engine's modules may import only lower layers. `npm run check:layers` scans every engine Rust source for rooted `crate::` imports and fails when a violation count grows.

```sh
npm run test:check-layers
npm run typecheck:layers
LAYERS_BASE_REF=$(git rev-parse origin/main) npm run check:layers
```

`LAYERS_BASE_REF` (or `--base-ref`) must be an immutable full commit SHA. CI fetches complete history and selects the PR base SHA, the pre-push main SHA, or the merge-base with main for another branch's push. The layer job runs independently of the shell, compatibility, and browser jobs, and a layer failure does not skip their coverage.

The checker records production and test-only edges, violations, source locations, and a source digest in `docs/evidence/engine-layers.json`. Neither violation count may increase, and a new violating edge cannot replace an old one at the same count. The check is lexical. It does not resolve Rust aliases or macros and does not prove that optional capabilities compile separately.

After you edit engine sources, refresh and commit the evidence in the same change:

```sh
LAYERS_BASE_REF=$(git rev-parse origin/main) npm run check:layers -- --record
```

Recording cannot bypass the committed-HEAD or immutable-target checks. A normal merge can carry unchanged evidence from a parent. The checker verifies that evidence against the parent's sources, rescans the merge, and compares it with the verified parent before it permits a refresh. Changed merge evidence must match exactly. Ordinary source commits with stale evidence are rejected, as are tampered parent or target records. The graph itself is recorded in [ADR 003](adr/003-one-core-shell-and-installable-utilities.md).

## Host boundary

A shell owns shell semantics and its own process handle. It borrows the page's runtime, so closing a shell never disposes that runtime or any other shell. The page owns runtime disposal. Waffle owns shared services and their teardown. Terminal rendering, browser controls, and asset serving stay with the host. Browser acceptance complements the frozen shell scoreboard and never replaces or regenerates its oracle, baseline, classifications, or generator fixtures.
