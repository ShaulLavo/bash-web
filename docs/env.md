# Print-only env

`env` is a separate upstream uutils WASI program. Import `installEnv` from `bash-web/utilities/env` and install it on the caller-owned Waffle runtime. Installation writes `/bin/env` and registers a lazy raw-byte loader for `dist/env.wasm`. It does not fetch, compile, or start a worker. `WasiUtilityOptions` accepts `wasmUrl`, `workerUrl`, or `source` bytes. Stop active processes before disposing the installation. The shell engine and runtime are unchanged.

## Initial contract

This utility prints the guest's environment. It supports no program operand, `-i` or `--ignore-environment`, `-u NAME`, `NAME=VALUE`, newline or `-0` NUL termination, `-v` debug output, and `-S` splitting when the resulting arguments still contain no program. Upstream owns option parsing, splitting, environment edits, and output. There is no local reimplementation.

For example, `env -i -S 'A=one B="two words"'` prints `A=one\nB=two words\n`. `-S` expands `${NAME}` from the inherited guest environment before `-i` clears it. Environment iteration is not sorted. Tests fix the entire input environment when asserting exact bytes. Edits apply only inside that utility process, not to the shell or the page.

`env -C /` without a program and `env -0 COMMAND` are local usage errors with status 125. Help and version are upstream output, not a list of qualified capabilities.

## Outside support

Every program operand is outside this print-only contract, including `-C DIR COMMAND`, `-a ARGV0 COMMAND`, and `-S` strings that produce a program. The unmodified WASI path currently reports unsupported command execution with status 126. `-a` with a program instead returns 2 before attempting execution. Neither is a qualified GNU 126/127 lookup result.

Signal options `--ignore-signal`, `--default-signal`, `--block-signal`, and `--list-signal-handling` are accepted by upstream but have no effect on WASI. They are not supported. We add no signal emulation, process adapter, or runtime bypass. This is not full GNU `env` support.

## Needs from other tracks

Full command forms need the Rust WASI process implementation used by `uu_env` to reach Waffle's existing `runtime_proc.spawn` and `wait` ABI. At the pinned source, `src/uu/env/src/env.rs` uses non-Unix `std::process::Command::status`; Rust's `wasm32-wasip1` standard library selects its unsupported process backend rather than that ABI. Waffle already has a process supervisor. No second supervisor or local subprocess shim is needed or added here.

The owning process/toolchain track must supply argv, environment, cwd, descriptor inheritance and exit propagation through that existing ABI, plus correct missing/not-invokable distinctions for 127/126. `-a` also needs argv0 support in upstream's non-Unix branch. Signal handling remains a separate capability. Later qualification must exercise those behaviors on Waffle before extending this contract.

## Source and checks

`uu_env` and `uucore` 0.13.0 come from coreutils revision `07763857f6b9a547742a994b58aef0ccd036198b`. `shell/utilities/env.source.json` records the package paths, dependency alias, and root MIT license digest. The notice generator checks the resolved license and collects it and dependency licenses from Cargo metadata. No upstream source is patched.

Build just this guest with `buildWasiShell(["-p", "shell-utilities", "--bin", "env"])` from `scripts/wasi-build.ts`. It uses the unchanged wasi-sdk 34.0 recipe, Waffle's patched libc, 256 MiB memory cap, and guest verifier. The ordinary utility build and package asset restoration include `env.wasm`.

`cargo test --locked --manifest-path shell/Cargo.toml -p shell-utilities --test env -j2` checks only the new native candidate tests. After building the guest and `npm run build:node-harness`, `node --test scripts/test-own-shell-env.ts` checks fixed guest environments directly on Waffle and lazy installation through its worker path, including disposal. Expectations are literal source-contract examples, not newly recorded GNU observations. No test calls a live host Bash or GNU oracle. This bounded slice makes no new whole-shell compatibility score claim.
