# 001. Run the shell as a WASM program on a runtime the page owns

Status: accepted
Date: 2026-10-17

## Context

A shell in a browser needs processes, a filesystem, pipes, signals, and a lifecycle for all of them. The prototype this repository grew from (`brush-web`) carried its own host: a program registry, a subprocess broker, and a vendored copy of a runtime tree. That made the shell and the runtime one thing. Two shells on one page would have meant two filesystems, and the page could not decide what else runs next to the shell.

The separate `waffle` package now provides those services. It owns filesystem authority, process records, descriptors, pipes, signals, and the teardown fences.

## Decision

The shell is a WASM program that a runtime runs. It is never the runtime. The page creates one Waffle runtime with `createRuntime` and passes that exact instance to `createShell({ runtime })`. The shell adapter imports Waffle's public APIs, registers only its own program, and never creates, replaces, or disposes the runtime. The application registers any other programs it wants.

`waffle` is a required peer dependency, pinned to one Git commit, and the development dependency uses the same commit. `npm run test:browser:package` checks that the peer, development, and lockfile pins agree and that no runtime source is vendored.

## Alternatives considered

- **The shell creates its own runtime.** This is the simplest API: one call, a working shell. It loses because every shell would own a private filesystem and process table, and the page could not share storage, run non-shell programs, or control disposal order.
- **Vendor Waffle's runtime into this repository.** This removes the peer dependency. It loses because the copy drifts from the runtime that applications use, and a fix would need to land twice.
- **Accept any object with a `startProcess` method.** This would let tests pass a fake. It loses because the shell relies on Waffle's descriptor, pipe, and signal semantics, and a structural stand-in cannot honor them. `createShell` requires Waffle's real `Runtime`.

## Consequences

- The page has more to do: create the runtime, serve Waffle's filesystem worker, and dispose the runtime after the last shell. [Embed a shell in a page](../guides/embed-in-a-page.md) walks through it.
- Every Waffle upgrade is an explicit commit that changes the pin in `package.json`, `sources.lock.json`, and the lockfiles.
- `shell.dispose()` is scoped. It stops that shell and its locally observed workers. It does not promise to stop descendants started through other adapters, and Waffle's teardown join is the proper owner of that guarantee.
- External programs such as Bun are the application's job. bash-web ships no Bun guest and its Bun-specific browser tests stay skipped until the external package publishes the needed API ([Status](../status.md#browser-integration-gaps)).
