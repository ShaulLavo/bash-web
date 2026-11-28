# Grep

`grep` is an external WASI program. In compatibility tests, bash-web now builds and runs FreeBSD grep from Waffle's upstream builder.

The browser build still pins the published `waffle-base` `0.0.23` package from `programs-v0.0.23` in `package.json`, and `sources.lock.json` keeps `wafflePrograms` at `0.0.23`.

## Current compatibility-test route

Run these commands from the repository root to build the Node runtime bundle, the shell guest, and the FreeBSD grep WASI guest, then run the replay suite through the installed Waffle runtime:

```sh
npm run build:node-harness
npm run build:shell
npm run build:test-grep
node --test scripts/replay/test-own-shell-freebsd-grep.ts
```

`npm run build:test-grep` runs `scripts/build/build-test-grep.ts`. That script queries `shell/Cargo.toml` through `cargo metadata --locked` to find the exact Waffle Git pin used by `waffle-program-support`. It exports `packages/grep`, `tools`, and Waffle's patched wasi-libc build inputs from that checkout, reuses the `.build/wasi-libc` sysroot cache, and calls `packages/grep/scripts/build-grep.ts`. It writes the verified `grep.wasm` output to `.build/shell/wasm32-wasip1/release/freebsd-grep.wasm`, or under `CARGO_TARGET_DIR` if you set that variable.

`node --test scripts/replay/test-own-shell-freebsd-grep.ts` installs `freebsd-grep.wasm` as `grep` alongside `shell-runtime.wasm` and runs it through the installed `@waffle-os/runtime` package. The suite checks the FreeBSD version banner, every frozen control in `shell/compat-fixtures/tests/grep-usage-cases.json`, basic and extended anchors, and binary record bytes with `-aFn`. It also checks `/dev/fd` and `/proc/self/fd` reopening, multi-MiB pipe throughput, downstream closed-pipe status `141`, `--line-buffered` streaming, Ctrl-C interruption with status `130`, and `-q` early reader close.

`npm run test:shell:scoreboard` runs `npm run build:node-harness`, `npm run build:test-grep`, and `npm run test:shell:scoreboard:prebuilt`. The scoreboard runner discovers and executes `scripts/replay/test-own-shell-freebsd-grep.ts`.

## Historical Bashkit-era contract

The details below record the superseded Bashkit-era `waffle-grep` contract for provenance and for the `grep` guest still shipped in `waffle-base` `0.0.23`.

`grep` was a cooperative WASI program in Waffle's `waffle-grep` family. Applications installed it through `waffle-base` on the same runtime passed to `createShell`. Installation did not fetch or compile the guest. The first invocation loaded the guest once, and disposal left the caller's runtime alive.

Supported options were `-n` line numbers, `-i` ignore case, `-v` invert, `-F` fixed strings, `-E` extended regular expressions, `-c` counts, `-q` quiet, `-H` always print filenames, and `-h` suppress filenames. The last `-H` or `-h` won. Callers could group options, and `--` ended option parsing.

```sh
printf 'TODO: one\nignore\nFIXME: two\n' | grep -n -e TODO -e FIXME
grep -Hin -F -e 'a+b' first.txt
grep -h -E -e '^warning:' -e '^error:' first.txt second.txt
```

`-e pattern` could repeat, consume a pattern beginning with `-`, or attach to a group such as `-nFeTODO`. With any `-e`, all ordinary operands were files. Newlines within a pattern separated alternatives, and an empty alternative selected every line before inversion. Without `-e`, the first ordinary operand was the pattern.

No file operands meant standard input, and `-` read standard input among other operands. Multiple operands printed filename prefixes, and forced standard-input prefixes used `(standard input)`. Counts were per operand, and a selected final unterminated record gained a newline. Status was 0 for a selected line, 1 for no selected lines, and 2 for an option, pattern, file, read, or output error. Quiet success took priority over earlier file errors. Cancellation and broken pipes kept shell statuses 130 and 141.

### Historical matcher, limits, and provenance

The matcher used the locked upstream Rust `regex` crate. The Bashkit-derived selection and original streaming descriptor adapter stayed in the `waffle-grep` family. Waffle's `packages/grep/provenance/grep.source.json` records the source and license receipt, and `sources.lock.json` keeps the historical Bashkit provenance under `shellAcceptanceUtilities`.

The shared limits were 4096 pattern bytes including separators between repeated `-e` arguments, a 256 KiB regex program and cache, a nesting limit of 64, and records of at most the smaller of the shell line limit and 64 KiB.

The historical implementation excluded recursive traversal, include and exclude filters, `-f`, long options, context, PCRE, backreferences, and complete GNU locale, BRE, and ERE parity. Ripgrep handled recursive searches. Input records preserved CR, NUL, and invalid UTF-8 instead of GNU binary-file classification.

Before this migration, `cargo test --locked --manifest-path shell/Cargo.toml -p shell-compat-fixtures --test streaming` checked shell-pipeline usage, streaming, cancellation, and closed-pipe regressions against the in-process `waffle-grep` family code. Its frozen controls were `shell/compat-fixtures/tests/grep-usage-cases.json`, byte-identical to Waffle's `packages/grep/tests/fixtures/grep-usage-cases.json`. Family installation, WASI, and browser acceptance used the tests and documentation in Waffle's `packages/grep` package. Those controls did not alter the frozen shell compatibility records.
