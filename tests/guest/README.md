# Browser acceptance guests

Original Rust WASI fixtures exercise generic process behavior, not Bun APIs.

Build from the repository root with the patched-libc helper:

```sh
npm run build:test-guest
```

Example shell command after the harness registers the guests:

```sh
test-guest emit hello
```

`test-guest` is cooperative; `test-spin` exercises source interruption admission.

- [Commands, registration and descriptor regression gate](../../docs/test-guests.md)
- [Build prerequisites](../../docs/development.md#prerequisites)
- [Shared libc patch and final-link verification](../../docs/wasi-libc.md)
