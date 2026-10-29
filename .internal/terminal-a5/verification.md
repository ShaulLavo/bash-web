# Prompt status and completion hook

Status: Approved. PR #176 depends on #174, starting from its exact pushed head `a8fb39dcdc8a89f957b7390044b4793fda177f72`. The author worktree is `/work/worktrees/bash-web/terminal-a5-status`. No version bump or Bun UI changes.

The guest calls `shell_terminal.phase(value, status)` with `Session`'s actual shell status. At the real prompt, the interactive root publishes one atomic 64-bit generation/status receipt and wakes the bridge. Guest instantiation no longer pretends a prompt is ready. The shared header grows from 64 to 72 bytes; guest and host ship together.

The public contract is `shell.waitForPrompt({ after?: bigint, signal?: AbortSignal })`. Startup uses the default `after: 0n`; a serial command submission waits after the preceding receipt's generation. A completed receipt survives late subscription, even after another command starts. The returned status includes builtins, functions, pipelines, parser/runtime failure and Ctrl-C. Empty input preserves status and advances generation. Background child exit does not replace a receipt. This is latest-state publication, not a command event queue. The host owns input while submitting and awaiting its next prompt, retries unaccepted input suffixes, and continues draining output.

Abort rejects with the caller's reason without interrupting the shell. Shell disposal, runtime disposal, process exit and terminal failure reject waits. The facade binds waits to its process lifetime. Script mode has no prompt and uses `shell.done` instead. Exact consumption is in `docs/reference/api.md`.

## Verification

All final checks passed. Durable command logs and reproducible task wrappers are in `/work/reports/wave-20261029/bash/terminal-a5/`.

- `npm run sources:browser`, `npm run build:worker` and `npm run build:shell:browser` built the matching worker and real WASI guest with the pinned Waffle builder and WASI SDK 34. The missing local cmake/ninja prerequisites were supplied with `UV_CACHE_DIR=/work/cache/uv uv run --no-project --with cmake --with ninja`; no system configuration changed.
- `node --test scripts/test-own-shell-terminal.ts scripts/test-own-shell-prompt-api.ts`: 8 passed. Real public `createShell`, production worker and guest cover fast builtins, failed cd, parse/arithmetic errors, missing executable, function return, pipelines, background work, external cat success/failure, foreground and prompt SIGINT, empty input, late subscribers, shell/runtime disposal and script exit.
- `npm run quality:js`: passed package, format, lint, typecheck, unused, duplicate and quality-gate checks. Shared test setup was extracted instead of updating the duplicate baseline.
- `npm run test:runtime:terminal`: 222 passed, including atomic receipt, repeated-ready, abort, close, exit and failure tests.
- `LAYERS_BASE_REF=a8fb39dcdc8a89f957b7390044b4793fda177f72 npm run check:layers`: zero production or test-only violations.
- `node_modules/.bin/playwright test tests/prompt-status.spec.ts --project chromium`: one passed against the actual browser worker/guest. The initial test invocation read its fixture before top-level await had installed it; the fixture now has an explicit readiness wait.
- On the M1 Mac: parser provenance, rustfmt, and `cargo test --locked --manifest-path shell/Cargo.toml --workspace -j2` passed 1,952 tests across 26 targets. Rust source is unchanged after that run.

## Cleanup

Tests register teardown before supervisors, pipes, descriptors, workers, browser/server and temporary directories. Mac source/target/transfer files and the task lock were removed by the wrapper, and their absence was checked on the Mac. PC generated dependencies, builds, fetched terminal sources, transferred source archive and disposable browser artifacts are removed after verification. Shared npm, Cargo, uv, WASI SDK and Playwright caches remain untouched. The source checkout and small evidence are retained for coordinator review/fixes until the coordinator releases them. No deployment, route, container or release was created. Review, merge and any CI follow-up belong to the coordinator; this lane does not watch or merge.

## Dependent PR CI baseline correction

The layers job in run 40832379639 failed at its baseline selector, before any layer checks. The actual test merge was `a8c2f9e13bc649958f45855717a4e14ae1de2e30`, with A2 `a8fb39dcdc8a89f957b7390044b4793fda177f72` as first parent and A5 `e4465c4e53dbcefe6ab6f8491ab04e84e5860b67` as second parent. Running the exact selector on that checkout reproduced `PR does not target main` for `terminal/a2-multiline`.

Layers now select the immutable tested target parent independently of main-only scoreboard qualification. Repository identity, checkout identity, two-parent merge topology, head identity and event-base ancestry are still checked. Compatibility baseline selection and score admission retain their main-branch requirements. No gate, source baseline, pin or public wait API changed. CLI regressions cover the dependent target, newer tested target parent, forged head, foreign repository and unrelated event base, while proving compatibility still rejects a non-main target.

The complete layers job commands pass with `LAYERS_BASE_REF=a8fb39dcdc8a89f957b7390044b4793fda177f72`: `npm run test:check-layers && npm run check:layers && npm run typecheck:layers`. The selector/scoreboard tests, CI workflow tests, formatting, lint and duplicate gates also pass. Reproduction and command logs are under `/work/reports/wave-20261029/bash/terminal-a5/ci-fix/`. Temporary fixture repositories clean themselves; the reinstalled dependency tree is removed after verification. No new review or watcher was started.

## Handled SIGINT and delegated input

The coordinator-provided SIGINT and acknowledgement designs are implemented. Each foreground job tracks Running, Parked and Waiting strands. A terminal delivery visits every live strand, delegates once to each waited child, and cancels shell execution only when shell code is running or a delivered child has a typed `Signaled(2)` result. Normal `Exited(130)` stays distinct. Shutdown and drop force cancellation and rearm pending waits for cleanup. The root strand exists before initial parsing.

The real guest/API regression first produced handled exits0/7 as130 while default, removed and consumed-once controls returned130. The repaired source-built guest passes those controls and repeated delivery. Reader and pipeline cancellation overwrites are retained. No adapter-side duplicate job kill or child-exit observation was added.

A fully delegated event reports `phase(-1, 0)` through the existing import. The worker posts a typed `interrupt-delegated` message with the last prompt generation. The host rejects stale generations, completes typeahead discard, restores the live foreground target and clears only the completed barrier with CAS1-to0. Acknowledgement does not publish a receipt or change the bridge layout. Generation is checked again in the granted control turn.

The minimal reader fixture uses the existing interactive guest launcher. Waffle's generic preview1 launcher deliberately supplies EOF stdin when no interactive resolver is supplied, which was ruled out before the reader proof. Reader input and stale-typeahead controls now check the actual byte `x` after Ctrl-C. A following shell `read` exposed a separate mode-preservation bug: ordinary external exit recreated a raw editor while the shell was still executing. The no-interrupt `external; read x` case also failed with CR and passed with LF. Foreground retirement now restores cooked command input when phase2 continues, and raw input for a prompt. The fixed cases retain the real Enter/CR assertion.

Current-main integration uses A2 squash tree equivalence (`a8fb39dc` and `d9e52b8c` have identical trees), then merges `origin/main` at `c442e234405e00dcb25e7503cbd930185fbfd63f` without force-push. The two squash-history conflicts retained A5's prompt/runtime and real-guest test files; the actual source difference of the merge is only main's ANSI-C quoting and bounded CI diagnostics. PR176 is retargeted to main. Final combined checks are recorded after this checkpoint.

Clippy's visit-all routing is an explicit loop, preserving all delivery side effects. Repeated host-wrapper forwarding and native cleanup assertions share helpers; no duplicate baseline or pin was changed. The pre-integration full native/WASI all-target clippy and cargo-machete gate passed. Combined verification repeats required checks for the merged parser/build contracts.

## Final combined acceptance

All checks below passed on the combined source after merging main at `c442e234`.

- `npm run check:rust`: parser provenance, rustfmt, native and WASI Clippy across the whole workspace and all targets with `-D warnings`, plus pinned cargo-machete0.9.2.
- `RUST_TEST_THREADS=2 npm run test:rust`: 1,959 native tests across26 targets. The initial-parse interruption regression passes.
- Full JavaScript CI chain: `quality:js`, `test:runtime:terminal` (225 passed), `test:ci` (131 passed), `test:guest-build` (21 passed), `typecheck:guest-build` and `typecheck:ci`.
- Layer job chain at immutable main `c442e234405e00dcb25e7503cbd930185fbfd63f`: 25 scanner tests, zero violations, and layer typecheck.
- Matching source-built WASI guest and bundled worker. Public API and guest TAP tests: 29 passed, including handled0/7/130, default/removed/once, normal continuation, functions/subshells, mixed/all-external pipelines, two Ctrl-Cs after shell cancellation, disposal, exact reader byte `x`, typeahead `s` discarded, shell read with Enter/CR, and ordinary external-exit mode preservation.
- Chromium: actual public API, worker, guest and interactive reader passed, including a receipt consumed after completion and generation/status delivery after handled Ctrl-C.
- `BASH_COMPAT_BASE_REF=c442e234405e00dcb25e7503cbd930185fbfd63f BASH_COMPAT_JOBS=1 npm run compat:shell`: 4,764 frozen passing cases, zero lost passes and zero newly failing cases. `compat-summary.json` records the counts and comparisons.
- Duplicate gates: zero new clones in exact and structural scans. No baseline, pin, version or gate suppression changed.

The accepted design limitation remains: an in-shell process-substitution loop beside a delegated external is interrupted only when that command finishes. Bun's final integrated consumer acceptance, independent review, CI follow-up and merge remain coordinator-owned. Task-generated dependency/build/browser payloads are removed after verification; the clean author checkout stays for fixes.
