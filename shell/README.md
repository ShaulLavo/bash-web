# Shell workspace

Rust parser and original async shell engine with separate native/WASI CLI and browser-runtime guests.

From the repository root:

```sh
npm ci
npm run build:shell
npm run test:rust
```

Minimal WASI CLI example:

```sh
wasmtime run .build/shell/wasm32-wasip1/release/shell-engine.wasm -c 'echo hello'
```

- [Workspace, parser provenance and runtime ABI](../docs/shell-workspace.md)
- [Async engine contract](../docs/shell-engine.md)
- [Build prerequisites](../docs/development.md#prerequisites)
- [Guest libc and final link](../docs/wasi-libc.md)
- [Compatibility scoreboard](../docs/bash-compatibility.md#own-shell-fixed-scoreboard)
