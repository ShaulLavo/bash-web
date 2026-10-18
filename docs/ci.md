# CI inputs and job ownership

`Shell` runs on pull requests and pushes to `main`. A branch push does not start a
second copy of the pull-request checks. A newer run cancels the superseded run
for the same pull request or `main`.

| Job                       | Work it owns                                                                                                                      |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `prepare`                 | One locked npm install, terminal-source fetch and JavaScript worker build                                                         |
| `layers`                  | Layer scanner tests, committed layer evidence and scanner types                                                                   |
| `quality`                 | Package checks, JS formatting/lint/types, unused code, duplicate scans, gate probes and build-tool unit tests                     |
| `native`                  | Rust formatting, host/WASI all-target Clippy, dependency analysis, native tests, CLI and guest builds, compiled WASI test targets |
| `wasi`                    | The same eight WASI test executables, smoke tests, scanner proof and compressed-size limit                                        |
| `fuzz`                    | Fuzzer unit tests and every frozen differential replay                                                                            |
| `own-shell-compatibility` | Scoreboard unit tests and the frozen compatibility replay                                                                         |
| `browser`                 | One frontend bundle, terminal unit tests and the complete Chromium/Firefox suite using two workers                                |

Consumers download this run's dependency/worker archive and checked native
artifacts. They never install or compile those inputs again. Tar preserves npm
symlinks and executable modes. Native artifacts include checksums, their native
input fingerprint and the original build commit.

## Cache keys

`scripts/ci-inputs.ts` fingerprints committed Git objects, not timestamps.
Native inputs include the shell and fixture source trees, Cargo manifests and
locks, Rust toolchain/configuration, native build/test helpers, CI configuration,
the source lock, the Waffle pin and native package commands. Prose outside the
native trees and browser-only changes do not change that key. Its tests cover source, fixture, toolchain and helper changes.

An exact native-cache hit reuses the native checks and builds that passed for
those inputs. A miss provisions Rust and the SDK and runs them before saving.
The separate WASI success cache saves only after execution, smoke and size checks
pass. A failed WASI check cannot create a success receipt. Neither cache uses a
prefix fallback. Rust compilation targets may restore dependency caches, but
those caches never substitute for a check result.

Dependency keys use the complete npm lock after removing only the root package
version. Dependency changes still invalidate the cache. Root patch bumps do not.
The workflow also caches npm downloads, the pinned Rust toolchain, both Cargo
targets, patched libc, SDK 34.0, cargo-machete 0.9.2 and Playwright browsers.
SDK keys include the verified archive checksum. Playwright keys use its browser
revision manifest. Downloaded upstream code is outside our lint roots.

## Reproduce the measurements

For each recorded run, read the job and step timestamps and its full cache logs:

```sh
gh api repos/ShaulLavo/bash-web/actions/runs/RUN_ID/jobs
gh run view RUN_ID -R ShaulLavo/bash-web --log
```

Use a browser/prose-only commit to check exact native-cache reuse. Then change a
Rust source or test input to check invalidation and the warm toolchain/SDK/Cargo
caches. Do not compare a first cache fill with a warm baseline without identifying
that difference. GitHub-hosted runner timings vary.

The existing `shell` check aggregates every job with `always()`. A failed,
cancelled or skipped prerequisite fails this check instead of turning a required
check into a successful skip. Its regression test checks the complete dependency
list and failure condition.
