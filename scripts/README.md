# Shell verification tools

Build, provenance and deterministic differential-fuzzing tools for the shell.

From the repository root, after [setup](../docs/getting-started.md#build-and-test):

```sh
npm run build:shell
npm run test:shell:scoreboard
```

Minimal frozen-oracle replay against an existing native engine:

```sh
npm run fuzz:shell-words:ci -- --shell .build/shell/release/shell-engine
```

- [Fuzzers, recording and strict CI replay](../docs/shell-fuzzing.md)
- [Compatibility methods](../docs/bash-compatibility.md)
- [WASI build tooling and provenance](../docs/wasi-libc.md)
