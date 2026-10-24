# 002. Write our own shell engine and port Bashkit's rules into it

Status: accepted
Date: 2026-10-16

## Context

The browser shell had been Brush built for `wasm32-wasip1`. A product dev environment in the browser needs real programs as child processes whose output streams live, for example `bun dev | grep error` showing each matching line as it happens. It also needs compatibility with GNU Bash that is measured, not assumed.

[Bashkit](https://github.com/everruns/bashkit) has a strong bash parser and a high compatibility score. On the builtins-only Oils cases, the historical comparison in [Bash compatibility](../bash-compatibility.md) lists Bashkit source at 95.4% and Brush (browser) at 78.4%.

Bashkit is built as a sandbox for AI agents. Its interpreter promises no process spawning by default, reimplements its commands in Rust in-process, and runs scripts to completion before returning output. That assumption runs through one `Interpreter` struct with 123 declared fields. A spike found four places where output or input is collected whole instead of streamed: the final pipeline stage, generic standard-input collection, process substitution, and the accumulated result output. Each missed spot would be a pipeline that silently stops streaming.

The browser also has no `fork`, and WASIX is not an option. Neither StackBlitz nor CodeSandbox forks in the browser.

## Decision

Split a shell into three parts and own all of them.

- **Parser.** Start from Bashkit's parser at revision `491c3281f668b76d64b15210b8f5d7bf97244be0` and maintain it as our own. Record local changes next to that base revision.
- **Bash rules.** Port Bashkit's rules into our structure one area at a time, starting from its implementation and tests, recording the source path and revision. Do not port its known bugs.
- **Engine.** Write the engine and the interpreter's structure ourselves for single-threaded `wasm32-wasip1`: one async executor, every stage a task, descriptors as reference-counted endpoints.

Measure correctness against GNU Bash 5.3.15, and let CI refuse any change that loses a passing case.

## Alternatives considered

- **Keep Brush.** It works today, but its compatibility is lower, and the scoreboard shows where. The decision supersedes the earlier choice of Brush.
- **Keep Bashkit's interpreter and replace only its engine.** The spike estimated 4,000 to 9,000 newly written or substantially changed lines for that route against 8,000 to 16,000 for this one, both low-confidence and both excluding tests and the shared runtime. It loses on streaming, because the buffering assumptions sit inside the interpreter, not at its edges.
- **Fork and patch Bashkit in place.** It would inherit the same four buffering sites and the same 123-field struct.

## Consequences

- The shell starts behind Bashkit on score. The committed baseline today is 77.8% on the same Oils set ([Status](../status.md#compatibility-with-bash)). Every change must not lower any corpus's pass count, so the number only goes up.
- Guardrails that climb with the score: the standalone core stays at or under 1,000,000 bytes after brotli-11 compression, and the streaming acceptance tests stay green. `npm run test:shell:wasi` checks the size.
- The parser can diverge from Bashkit freely. Provenance is a record in `sources.lock.json`, not byte identity.
- Ported code carries its upstream license. `THIRD_PARTY_NOTICES.md` and `npm run notices:shell` keep the notices current.
