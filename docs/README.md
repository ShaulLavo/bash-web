# bash-web docs

Start at the [README](../README.md) for what bash-web is. This page maps the rest.

## Learn and do

- [Getting started](getting-started.md): Build the engine and run your first scripts
- [Embed a shell in a page](guides/embed-in-a-page.md): Run a script or an interactive shell in the browser
- [Install program families](guides/install-utilities.md): Install coreutils, findutils, grep, sed, and ripgrep through `waffle-base`
- [Troubleshooting](troubleshooting.md): Fix `command not found`, isolation errors, missing assets

## Understand

- [How bash-web works](concepts/architecture.md): See the parts and why they sit where they do
- [Prompt provider](prompt.md): Build a bounded Starship-shaped prompt from Waffle filesystem data
- [Status and limits](status.md): Check platforms, bash compatibility numbers, gaps, and limits
- [001 Borrowed runtime](adr/001-shell-is-a-wasm-program-on-a-borrowed-runtime.md): Why `createShell` takes a runtime
- [002 Own engine](adr/002-own-engine-instead-of-forking-bashkit.md): Why the engine is not Bashkit's interpreter
- [003 Core and utilities](adr/003-one-core-shell-and-installable-utilities.md): Why `cat`, `grep`, `mkdir`, `seq`, and `tail` are separate programs

## Look up

- [API reference](reference/api.md): `createShell`, `Shell`, `SharedBridge`, shell registration, and `waffle-base` composition
- [Browser sessions](session.md): Typed terminal sessions, input queues, submission, prompt receipts, and disposal
- [Browser integration](browser-runtime.md): Asset contract, storage, `PATH` lookup, test scope, source provenance
- [Async shell core](shell-engine.md): Execution contract, bounds, supported syntax
- [Shell workspace](shell-workspace.md): Parser crate, runtime ABI for interactive and [named-file](script-files.md) execution, the CLI; [WASI utility processes](wasi-process.md) for child execution
- [Engine ownership notes](reference/engine-ownership.md): Which module owns execution types, bindings, parsing entry points
- [Guest libc and build provenance](wasi-libc.md): The patched wasi-libc every WASI guest links against
- [Zsh line-editor mode](zsh-line-editor.md): Opt-in hard-line navigation without changing Bash execution
- [Interactive terminal editing](terminal-editing.md): Multiline commands, Shift+Enter, bracketed paste and input limits
- [Prompt hook](prompt-hook.md): Draw each interactive prompt from the page and update it in place
- [Test guests](test-guests.md): `test-guest` and `test-spin` commands and the descriptor test matrix

### Builtin and feature behavior

One page per feature, each stating exactly what is supported and what is left out. Pages end with how their results were checked against GNU Bash 5.3.15.

- Output and input: [echo](echo.md), [printf options](printf-options.md), [printf quoting](printf-quoting.md), [printf string fields](printf-string-fields.md), [printf integer fields](printf-integer-fields.md), [printf integer operands](printf-integer-operands.md), [printf unsigned and radix operands](printf-unsigned-radix.md), [printf character](printf-character.md), [printf floating conversions](printf-float.md), [printf escaped fields](printf-escaped-fields.md), [printf scalar assignment](printf-scalar-assignment.md), [read](read.md), [getopts](getopts.md)
- Expansion: [tilde expansion](tilde-expansion.md), [parameter transformations](parameter-transformation.md), [input-only command substitution](file-substitution.md), [indexed arrays](indexed-arrays.md), [typed variable references](typed-references-contract.md), [grouped conditional ERE](regex-groups.md), [negative extglob patterns](negative-extglob.md)
- Commands and state: [aliases](aliases.md), [builtin wrapper](builtin-wrapper.md), [type](type.md), [declaration printing](declaration-printing.md), [cd and the directory stack](directories.md), [trap registration](trap-registration.md), [completion](completion.md)
- Prompt: [git metadata](prompt-git.md)
- Files and descriptors: [file permission predicates](file-permissions.md), [descriptor reopening](descriptor-reopening.md), [broken pipes](pipeline-broken-pipe.md)

## Contribute

- [Development](development.md): Set up, build, test, and find your way around the repository
- [Bash compatibility](bash-compatibility.md): Read how the score is produced and held
- [Shell fuzzing](shell-fuzzing.md): Run and record the differential fuzzers
- [CI inputs and job ownership](ci.md): See what each CI job owns and caches
- [Code quality gates](code-quality.md): Run lint, types, duplicate, and Rust quality checks

Frozen records that scripts check live in [`evidence/`](evidence/README.md). They are not documentation.
