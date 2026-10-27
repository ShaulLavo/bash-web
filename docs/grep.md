# Grep

`grep` streams matching lines from standard input or files as its own cooperative WASI program. Install it with `installGrep` from `bash-web/utilities/grep` on the Waffle runtime passed to `createShell`. Installation does not fetch or compile the guest. The first invocation loads it once; disposing the installation leaves the caller's runtime alive.

Supported options are `-n` line numbers, `-i` ignore case, `-v` invert, `-F` fixed strings, `-E` extended regular expressions, `-c` counts, `-q` quiet, `-H` always print filenames and `-h` suppress filenames. The last `-H` or `-h` wins. Options can be grouped. `--` ends option parsing.

```sh
printf 'TODO: one\nignore\nFIXME: two\n' | grep -n -e TODO -e FIXME
grep -Hin -F -e 'a+b' first.txt
grep -h -E -e '^warning:' -e '^error:' first.txt second.txt
```

`-e pattern` can repeat, consume a pattern beginning with `-`, or attach to a group such as `-nFeTODO`. With any `-e`, all ordinary operands are files. Newlines within a pattern separate alternatives. An empty alternative selects every line before inversion. Without `-e`, the first ordinary operand is the pattern.

No file operands means standard input; `-` explicitly reads it among other operands. Multiple operands normally print filename prefixes. Forced stdin prefixes use `(standard input)`. Counts are per operand, and selected final unterminated records gain a newline. Status is 0 for a selected line, 1 for no selected lines, and 2 for an option, pattern, file, read or output error. Quiet success takes priority over earlier file errors. Cancellation and broken pipes retain shell statuses 130 and 141.

The matcher is the existing locked upstream Rust `regex` crate, not a new engine. The Bashkit-derived selection and original streaming descriptor adapter remain in place. See `shell/utilities/grep.source.json` for the source and license receipt. The shared limit is 4096 pattern bytes including separators between repeated `-e` arguments, a 256 KiB regex program/cache, nesting limit 64 and records of at most the smaller of the shell line limit and 64 KiB.

Recursive traversal, include/exclude filters, `-f`, long options, context, PCRE, backreferences and complete GNU locale/BRE/ERE parity are excluded. Use separately installed ripgrep for recursive searches. Input records preserve CR, NUL and invalid UTF-8 instead of GNU binary-file classification.

`cargo test --locked --manifest-path shell/Cargo.toml -p shell-utilities --test streaming` checks native usage and streaming, cancellation and closed-pipe regressions. After building `grep.wasm`, `shell-runtime.wasm` and browser workers into `dist/`, run `node scripts/test-grep-usage.ts`. It verifies the explicit controls in `tests/helpers/grep-usage-cases.json` against installed GNU grep and actual Waffle in Chromium and Firefox, including lazy loading, disposal and physical worker cleanup. `--native-only` checks just the oracle controls. The controls do not alter the frozen shell compatibility records.
