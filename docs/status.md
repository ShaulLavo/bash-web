# Status and limits

bash-web is experimental and pre-1.0. The package version is `0.0.x`, `package.json` marks it `"private": true`, it is not on npm, and the repository has no releases or tags. Use it from a checkout. Any commit can change the API.

## Platforms

| Area | Runs on | Not verified |
| ---- | ------- | ------------ |
| Native engine build and tests (`npm run test:rust`) | macOS arm64 (1,648 tests passed at `a26ce56`), Linux (CI, `ubuntu-latest`) | Windows |
| WASI guests, size gate, frozen score replay | Linux (CI) | macOS, Windows. The wasi-sdk default path in `scripts/wasi-build.ts` is a Linux x86_64 build, and the libc rebuild needs `setsid`, `flock`, and GNU `timeout`. |
| Browser embedding | Chromium and Firefox through Playwright in CI | Safari. Chromium and Firefox results say nothing about it. |
| Browser requirements | A secure context, cross-origin isolation for `SharedArrayBuffer`, WASM served as `application/wasm` | |
| Demo terminal renderer | WebGPU, with a Canvas fallback when WebGPU exposes no adapter | |
| JavaScript tooling | Node `>=26.12.1` | Older Node |

`npm run test:rust` also runs `cargo fmt --check` and the parser provenance check. The CI jobs are listed in [CI inputs and job ownership](ci.md).

## Compatibility with bash

The oracle is GNU Bash 5.3.15. A case passes when stdout bytes and exit status match. stderr is recorded but not scored. Each case runs in a fresh shell with a 10-second timeout. Only builtins-only cases are scored. Cases that need external commands, interactive input, job control, or other excluded features are skipped.

CI compares every pass against a committed baseline and rejects a change that loses one. The baseline records these passes:

| Corpus | Scored cases | Passes | Pass rate |
| ------ | -----------: | -----: | --------: |
| Oils spec tests | 1,682 | 1,308 | 77.8% |
| Brush suite | 1,888 | 1,361 | 72.1% |
| Bashkit suite | 2,222 | 1,762 | 79.3% |

Print these numbers from the committed baseline:

```sh
node -e 'const b=JSON.parse(require("fs").readFileSync("docs/evidence/own-shell-baseline.json","utf8"));for(const [k,v] of Object.entries(b.counts))console.log(k,v.passed+"/"+(v.total-v.skipped))'
```

```text
oils 1308/1682
brush-suite 1361/1888
bashkit-suite 1762/2222
```

The baseline is a floor, not a fresh measurement. `npm run compat:shell` replays the shell against the frozen oracle and needs the WASI build ([Development](development.md#replay-the-compatibility-score)). The method, the corpora, and each score change are in [Bash compatibility](bash-compatibility.md).

Pass counts by Oils category, from the same file:

| Oils category | Scored | Passes | Rate |
| ------------- | -----: | -----: | ---: |
| Brace expansion | 53 | 53 | 100.0% |
| Command substitution and subshells | 25 | 25 | 100.0% |
| Grammar, functions and control flow | 180 | 171 | 95.0% |
| Conditionals, test, `[[ ]]` and case | 146 | 135 | 92.5% |
| Pipelines | 12 | 11 | 91.7% |
| Other builtins (cd, eval, source, type, alias...) | 155 | 142 | 91.6% |
| Here-docs and redirects | 44 | 40 | 90.9% |
| Quoting and word splitting | 73 | 66 | 90.4% |
| echo, printf, read, mapfile, getopts | 147 | 127 | 86.4% |
| Globbing and extglob | 76 | 61 | 80.3% |
| Arithmetic | 116 | 87 | 75.0% |
| Parameter expansion | 173 | 119 | 68.8% |
| Real-world idioms | 82 | 53 | 64.6% |
| errexit, options and traps | 164 | 103 | 62.8% |
| Assignment, scope and special vars | 109 | 60 | 55.0% |
| Arrays and assoc arrays | 127 | 55 | 43.3% |

## Not supported yet

Observed at commit `a26ce56` with the native `shell-engine`. Each row is a one-line script you can pass to `shell-engine -c`. The last column is what GNU Bash 5 does.

| Feature | Try | What happens | Bash |
| ------- | --- | ------------ | ---- |
| Associative arrays | `declare -A m=([x]=1 [y]=2); echo ${m[x]} ${#m[@]}` | prints `0` | prints `1 2` |
| `mapfile`, `readarray` | `mapfile -t a <<< x` | `command not found`, status 127 | reads the array |
| Array elements in arithmetic | `arr=(1 2 3); echo $(( arr[0] + arr[2] ))` | status 2, no output | prints `4` |
| `printf` floating point | `printf "%5.2f\n" 3.14159` | `unsupported format conversion`, status 2 | prints ` 3.14` |
| Traps running | `trap "echo bye" EXIT; echo hi` | prints `hi` only. `trap` stores and prints bindings, and no event runs one. | prints `hi` then `bye` |
| `time` and `coproc` | `time true` | status 2 | runs |
| `$$`, `BASHPID`, `RANDOM`, `SECONDS` | `echo "[$$] [$BASHPID] [$RANDOM] [$SECONDS]"` | empty values | numbers |

The feature pages list more gaps. Each page ends with what it leaves out: [printf](printf-options.md), [read](read.md), [indexed arrays](indexed-arrays.md), [traps](trap-registration.md), and [completion](completion.md). `[[ =~ ]]` works only in `C`, `POSIX`, `C.UTF-8`, and `C.utf8` locales and returns status 2 elsewhere. The browser host sets `LANG=C.UTF-8`.

## Limits

Defaults from `Limits::default()` in `shell/engine/src/interpreter.rs` and the guest's link settings. Exceeding a limit fails the command with an explicit status, never a silent truncation.

| Limit | Value |
| ----- | ----- |
| Script source per invocation | 256 KiB |
| Expanded command words | 1 MiB, at most 65,536 words |
| Pipeline stages | 128 |
| Retained shell jobs | 128 |
| `read` line | 64 KiB |
| Live execution memory per session | 100,000,000 bytes |
| Nested `eval` readers | 16 |
| Nested execution levels | 256 |
| WASM linear memory, per guest | 256 MiB maximum |
| Terminal rings in the browser | 64 KiB input, 256 KiB output |
| Pipe capacity in the browser runtime | 64 KiB |
| Process directory slots per root | 1,024 |

[Async shell core](shell-engine.md#explicit-bounds) explains each bound. A size gate in CI fails the build if the standalone core exceeds 1,000,000 bytes after brotli-11 compression. `npm run test:shell:wasi` prints the current raw, gzip, and brotli sizes for the core and each utility.

## Browser integration gaps

- bash-web ships no Bun guest and has no Bun dependency. Four Bun-specific browser tests are skipped until the external package publishes its API, and three more carry known-failure annotations. See [Pending external-program coverage](browser-runtime.md#pending-external-program-coverage).
- `shell.dispose()` joins the cleanup of workers the shell adapter started. It does not guarantee that descendants started through a foreign adapter have stopped.
- A foreign Waffle adapter's terminal writes can be dropped when the output ring is full. The loss shows in `droppedTerminalBytes` and a console error. It is counted, not prevented.
- `runtimeSnapshot().roots[].pipes` counts pipes the shell root requested, not those of nested shells.

## Published packages and releases

There are none. Install instructions elsewhere in these docs mean building from source. The three pinned external inputs are Waffle (a Git commit in `peerDependencies`), the Ghostty WebGPU terminal source, and wasi-sdk 34.0. `sources.lock.json` records the pins and checksums.
