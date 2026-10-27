# AGENTS.md

bash-web is a Rust shell engine compiled to WASM, plus a TypeScript browser adapter. It is pre-1.0 and not published. Read [docs/concepts/architecture.md](docs/concepts/architecture.md) before changing the engine or the adapter. Everything else is in [docs/README.md](docs/README.md).

## Check a change

- Rust change: `npm run test:rust` (parser provenance, rustfmt, native tests). It needs only rustup.
- Engine source change: also run `LAYERS_BASE_REF=$(git rev-parse origin/main) npm run check:layers`. It compares actual sources; do not commit generated layer snapshots.
- TypeScript change: `npm run sources:browser && npm run build:worker && npm run quality:js`. Typechecking fails until `sources:browser` has fetched the terminal source.
- WASI, browser, and score work needs wasi-sdk 34.0 on Linux. Set `WASI_SDK_PATH` to the SDK directory (`scripts/wasi-build.ts` reads it; its built-in default fits only one Linux layout). See [docs/development.md](docs/development.md#prerequisites).
- Compatibility change: `npm run compat:shell` must not lose a passing case against the admitted current-main floor. See [landing checks](docs/landing-infrastructure.md).
- Engine tests live in `shell/engine/tests/` and in each module's `tests` folder. Replay tests for builtins are `scripts/test-own-shell-*.ts`. Add yours beside them.

## Rules the code does not enforce

- External commands are Waffle family programs consumed through `waffle-base`. Never add one to the engine. Language features go in the core. See [ADR 003](docs/adr/003-one-core-shell-and-installable-utilities.md).
- `createShell` borrows the page's Waffle runtime. Never create or dispose a runtime inside the adapter ([ADR 001](docs/adr/001-shell-is-a-wasm-program-on-a-borrowed-runtime.md)).
- Port bash rules from Bashkit with the source path and revision recorded in `sources.lock.json`, and observe behavior against GNU Bash 5.3.15. Do not port Bashkit's buffering ([ADR 002](docs/adr/002-own-engine-instead-of-forking-bashkit.md)).
- A feature gets one page in `docs/`, named for the feature, stating what is supported and what is left out. Add it to [docs/README.md](docs/README.md).

## Do not touch

- `docs/evidence/`, `scripts/fixtures/`, and the pins in `sources.lock.json`. Scripts check them by digest. Regenerating them rewrites the baseline the score is held to.
- Paths that `sources.lock.json` cites: `docs/*.md` file names and one file in `plans/`. Renaming them breaks provenance records.
- `plans/` and `.internal/` are working notes, not documentation. Do not link them from `README.md` or `docs/`.
- `docs/code-quality.md` is checked by `oxfmt` in `npm run format:check`. Run `npx oxfmt docs/code-quality.md` after editing it.

## Where things are

- Public API: `src/shell.ts`, `src/index.ts`, `src/bridge.ts`, optional `src/utilities/python.ts`.
- Shell guest and worker glue: `src/runtime/`. The demo page is `src/browser/` and is not API.
- Engine: `shell/engine/src/`. Parser: `shell/parser/`. Native family composition for tests: `shell/compat-fixtures/`.
- Native smoke test: `cargo build --release --locked --manifest-path shell/Cargo.toml -p shell-engine --bin shell-engine`, then `shell/target/release/shell-engine -c '<script>'`. It has no external commands. `[[ =~ ]]` needs `LC_ALL=C.UTF-8`.
