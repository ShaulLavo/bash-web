# Grep

`grep` is a cooperative WASI program in Waffle's `waffle-grep` family. Install it through `waffle-base` on the same runtime passed to `createShell`; installation does not fetch or compile the guest. The first invocation loads it once, and disposal leaves the caller's runtime alive.

Supported options are `-n` line numbers, `-i` ignore case, `-v` invert, `-F` fixed strings, `-E` extended regular expressions, `-c` counts, `-q` quiet, `-H` always print filenames and `-h` suppress filenames. The last `-H` or `-h` wins. Options can be grouped, and `--` ends option parsing.

```sh
printf 'TODO: one\nignore\nFIXME: two\n' | grep -n -e TODO -e FIXME
grep -Hin -F -e 'a+b' first.txt
grep -h -E -e '^warning:' -e '^error:' first.txt second.txt
```

`-e pattern` can repeat, consume a pattern beginning with `-`, or attach to a group such as `-nFeTODO`. With any `-e`, all ordinary operands are files. Newlines within a pattern separate alternatives. An empty alternative selects every line before inversion. Without `-e`, the first ordinary operand is the pattern.

No file operands means standard input; `-` explicitly reads it among other operands. Multiple operands normally print filename prefixes. Forced stdin prefixes use `(standard input)`. Counts are per operand, and selected final unterminated records gain a newline. Status is 0 for a selected line, 1 for no selected lines, and 2 for an option, pattern, file, read or output error. Quiet success takes priority over earlier file errors. Cancellation and broken pipes retain shell statuses 130 and 141.

The matcher uses the locked upstream Rust `regex` crate, not the shell engine. The Bashkit-derived selection and original streaming descriptor adapter remain in the family. See Waffle's `packages/grep/provenance/grep.source.json` for its source and license receipt. The shared limit is 4096 pattern bytes including separators between repeated `-e` arguments, a 256 KiB regex program/cache, nesting limit 64 and records of at most the smaller of the shell line limit and 64 KiB.

Recursive traversal, include/exclude filters, `-f`, long options, context, PCRE, backreferences and complete GNU locale/BRE/ERE parity are excluded. Use ripgrep for recursive searches. Input records preserve CR, NUL and invalid UTF-8 instead of GNU binary-file classification.

`cargo test --locked --manifest-path shell/Cargo.toml -p shell-compat-fixtures --test streaming` checks the shell-pipeline usage, streaming, cancellation and closed-pipe regressions against the actual family code. Its frozen controls are `shell/compat-fixtures/tests/grep-usage-cases.json`, byte-identical to Waffle's `packages/grep/tests/fixtures/grep-usage-cases.json`. Family installation, WASI and browser acceptance use the tests and documentation in Waffle's `packages/grep` package. The controls do not alter the frozen shell compatibility records.
