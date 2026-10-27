# env

`env` is a separate uutils WASI program. `installEnv` from `bash-web/utilities/env` lazily installs `/bin/env` and `/usr/bin/env` as the same program on the caller's Waffle runtime. The installer accepts source bytes or a WASM URL and an optional worker URL. Disposal releases both registrations and removes only unchanged files that this installation created. Stop active processes before disposal.

## Commands

`env NAME=value node file.js args` runs the installed `node` program with the edited environment. Waffle resolves `#!/usr/bin/env node` scripts through its generic interpreter dispatch. Node must be installed on the same runtime and filesystem.

The upstream parser supports `-i`, `-u NAME`, assignments, `-S` splitting, `-C DIR`, `-a ARGV0`, and `-v`. Unsets precede assignments. `-S` expands `${NAME}` from the inherited environment before `-i` clears it. Options precede assignments.

The child receives argv0 as the command was given, or the exact `-a` value. Empty arguments, spaces and literal shell characters are preserved. There is no shell command-string wrapper. PATH lookup uses the edited environment; absent PATH defaults to `/bin:/usr/bin`, empty components mean cwd, and a slash bypasses PATH.

`-i` produces an empty child environment unless assignments add entries. Cwd comes from Waffle's process request, independently of `PWD`. `-C` changes cwd without rewriting `PWD`. The parent shell's environment and cwd are unchanged. A program's own adapter may apply its own environment policy.

Real child exit codes pass through. Missing commands return 127; commands that cannot start return 126. Local usage errors return 125. `env -0 COMMAND` and `env -C DIR` without a command remain usage errors.

The backend uses `shell-wasi-process` on the existing runtime, inherits the Shell worker's actual descriptors, and waits for its child job's cleanup. Waffle owns fatal-caller cancellation. Execution uses spawn/wait rather than native process-image replacement.

## Printing and restrictions

Without a command, env prints the resulting environment. Newline and `-0` NUL separators, repeated assignments, unsets, and split strings retain upstream behavior. For example, `env -i -S 'A=one B="two words"'` prints `A=one\nB=two words\n`.

Signal disposition options `--ignore-signal`, `--default-signal`, `--block-signal`, and `--list-signal-handling` return 125 before input or execution. Non-UTF-8 process strings are explicitly unsupported. There is no native host execution fallback.

## Source and checks

The parser and environment mutations come from uutils coreutils revision `07763857f6b9a547742a994b58aef0ccd036198b`, package `uu_env` 0.13.0. `shell/utilities/env.source.json` and `third-party/uutils-env/provenance.json` record source and hashes; `wasi.patch` records the backend changes.

Build env with `buildWasiShell(["-p", "shell-utilities", "--bin", "env"])` from `scripts/wasi-build.ts`. `npm run test:env:command` builds a small WASI child and the Node-hosted Waffle test bundle, then checks real command execution and cleanup. Native upstream tests are in `shell/utilities/tests/env.rs`; print and installer browser regressions use `npm run build:env:tests && npm run test:env:browser` after the shell guest and workers are available.
