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
