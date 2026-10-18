# Async shell core

Original single-threaded async shell execution over injectable process and filesystem hosts.

From the repository root:

```sh
npm run test:rust
npm run build:shell
```

Minimal CLI example:

```sh
wasmtime run .build/shell/wasm32-wasip1/release/shell-engine.wasm -c 'printf hello'
```

- [Execution contract, bounds and supported semantics](../../docs/shell-engine.md)
- [Workspace and runtime integration](../../docs/shell-workspace.md)
- [Build setup](../../docs/getting-started.md#build-and-test)
