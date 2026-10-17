# bash-web

`bash-web` is a WASM-first bash-compatible shell. It contains the Rust parser
and shell engine extracted from [brush-web](https://github.com/ShaulLavo/brush-web)
with the original commits, fixtures, oracle observations, and compatibility
harness preserved.

The shell is a WASM program, not a browser runtime. A host supplies process,
filesystem, pipe, and page lifecycle services through the separate
[`waffle`](https://github.com/ShaulLavo/waffle) package. Applications pass one
shared runtime instance per page, for example `createShell({ runtime })`.
`waffle` will be a peer dependency when the runtime switch lands; it is not a
dependency of this extraction yet. A later standalone entry will wire waffle,
the shell, and a terminal for applications that do not provide their own host.

## Build and test

Prerequisites are Node 26.7 or newer, npm, Rust 1.98.1 through rustup, and
wasmtime for WASI tests.

```sh
git clone https://github.com/ShaulLavo/bash-web.git
cd bash-web
rustup toolchain install 1.98.1 --profile minimal --component rustfmt --target wasm32-wasip1
npm ci
npm run build:shell
npm run test:rust
npm run test:shell:wasi
```

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

## Repository layout

- `shell/` contains the parser and WASI shell engine.
- `scripts/` contains the shell runner, scoreboard, provenance checks, and
  differential generators.
- `scripts/fixtures/` contains frozen generator inputs; do not regenerate them
  during ordinary maintenance.
- `docs/evidence/` contains frozen oracle, baseline, and classification data.
- `docs/extraction/brush-web-commit-map.txt` maps every retained source commit
  to its rewritten destination commit.
- `plans/004-own-shell.md` records the approved extraction, and
  `plans/005-bash-web-packaging.md` records the package boundary.

The pinned source revisions, archive checksums, and implementation
classifications are in [`sources.lock.json`](sources.lock.json). The generated
license file is `dist/THIRD_PARTY_NOTICES.txt`; regenerate it with
`npm run notices:shell`.

## Host boundary

Browser terminal UI, Bun payloads, browser process/runtime adapters, and
reference-engine comparisons remain in brush-web. This repository owns the
shell program and its standalone verification only. The historical browser
measurements and comparisons in brush-web are not standalone bash-web gates.
