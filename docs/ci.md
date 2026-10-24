# CI inputs and job ownership

`Shell` runs on pull requests and pushes to `main`, without a second branch-push
run. A newer PR head supersedes its older run. Main concurrency groups include
the immutable source SHA and do not cancel another main source.

| Job                       | Work it owns                                                                                                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prepare`                 | One locked npm install, terminal-source fetch and worker build                                                                                                                              |
| `layers`                  | Scanner tests, immutable layer baseline and scanner types                                                                                                                                   |
| `quality`                 | Package, JS format/lint/types, unused code, duplicates, failure probes, complete guest-build tests/types and CI helper tests/types                                                          |
| `native`                  | Parser provenance, shell/guest Rust fmt, host/WASI all-target Clippy, machete, native workspace tests, both CLIs, core/utility/fixture guests, ten compiled WASI tests and capability proof |
| `wasi`                    | All ten WASI test executables, smoke/stdio/helper controls, scanner proof, core Brotli ceiling and runtime/utility size reports                                                             |
| `fuzz`                    | Every existing generator test and frozen native differential replay, including echo                                                                                                         |
| `own-shell-compatibility` | Diagnostic observer tests, complete scoreboard tests, real-Waffle echo and the unchanged wrapped frozen replay                                                                              |
| `score-floor`             | Completed-producer admission, cumulative main floor and gained/lost IDs; no build or replay                                                                                                 |
| `browser`                 | Frontend assets, terminal tests and the complete Chromium/Firefox suite with the checked-in worker count                                                                                    |
| `shell`                   | Always-running aggregate; any failed, skipped or cancelled dependency fails                                                                                                                 |

The path-filtered `printf-darwin` workflow remains a separate blocking macOS
gate. Linux results do not replace it. Its quoting selection and locale setup
are unchanged.

## Same-run artifacts

Consumers restore this run's JavaScript archive, preserving npm symlinks and
executable modes. The native producer supplies `shell-engine`, `shell-cli`,
`shell-engine.wasm`, `shell-runtime.wasm`, `argv-py.wasm`, `printenv-py.wasm`,
`cat/grep/mkdir/seq.wasm`, the browser test/spin guests and every WASI test.
Parser has four test executables, engine has five including capabilities, and
utilities has one streaming executable. Stable package-qualified filenames
prevent the two streaming tests from overwriting each other.

`scripts/ci-artifacts.ts` packs and stages an explicit file inventory. A consumer
checks the exact current Git SHA, input fingerprint, all file hashes and exact
WASI test selection before staging. The existing utility receipt additionally
checks exact source, each guest hash and the patched-libc/memory contract. Missing,
changed or wrong-source artifacts fail; no earlier build is relabelled.
The existing `utility-guests-<sha>` and `shell-cli-<sha>` artifacts remain available
with their original source/hash receipt contracts.

Staging puts each utility in both `public/programs` and `dist` before Vite runs,
matching the normal utility build. Utility package entries resolve their WASM
URLs from `dist`; copying those files only after bundling leaves broken URLs.

Only the producer compiles shared guests and WASI tests. The TypeScript WASI
runner's `--prebuilt` mode executes those tests and keeps the normal smoke,
stdio, helper, scanner and size assertions. Its no-argument local mode still
builds and runs the same targets. Local `quality` and `build:browser` remain
complete; CI uses their nonduplicating JS/assets parts.

## Score and layer evidence

The compatibility producer publishes a complete raw result before the separate
blocking `score-floor` job compares passes. A regression therefore cannot erase
evidence or lower the next PR's floor. Main evidence requires an authenticated
main run, a completed producer job, successful observation/upload steps, exact
attempt, artifact ID, archive digest and uploader log linkage. The workflow may
still be running while the floor job reads its producer.

Retry only the cheap floor job when a predecessor finishes later. Its artifact-ID
input refers to the original raw producer, even when the rerun attempt changes.
If the one-day JavaScript input archive has expired, rerun `prepare` as well, not
the compatibility replay. Missing non-equivalent source evidence or a bridge
longer than 32 edges stops with a named prerequisite. See [landing checks](landing-infrastructure.md)
for the bootstrap, source-equivalence and 90-day evidence retention limits.

The layer job uploads complete base/candidate graphs on success or comparison
failure. It reads actual immutable base sources and never requires a generated
JSON commit.

## Caches and input closure

There is no cross-commit native-binary or WASI successful-result cache. Every
run executes its native/WASI gates. This avoids conflicting with source-exact
utility receipts. Caches accelerate dependencies and compilation, never replace
a successful check.

Dependency keys hash the complete npm lock after removing only the root package
version in its two locations. Dependency changes invalidate both installed
packages and npm downloads; root patch bumps do not. If either exact cache is
missing, the one install also fills downloads. Other caches cover the pinned
Rust toolchain, both Cargo target directories, patched libc, SDK 34.0,
cargo-machete 0.9.2 and Playwright browsers. SDK keys include the archive checksum.

Native input receipts cover the entire shell, guest and scripts trees, CI
configuration, source lock, Rust toolchain/configuration, all package recipes,
the Waffle pin and normalized dependency lock. Build, receipt and gate helper
changes therefore invalidate the receipt. Exact source SHA remains a separate,
stronger requirement even when these inputs are unchanged.

## Browser dependency transport

The browser job keeps the Playwright cache and installs both Chromium and Firefox
with their system dependencies. Before installation, it removes Azure's HTTP
archive from the runner's apt mirror list. The runner's existing HTTPS Ubuntu
archive and security archive remain unchanged, including their priorities.
An empty remaining mirror list fails before installation. No package signatures,
repositories, browser versions, timeouts or test selections change.

On October 22, the browser cache restored 387 MiB successfully, but Azure package
downloads consumed the 20-minute job before any tests ran. The runner's mirror
list fails over when a source fails, not when it continues to return packages
slowly. Choosing its existing HTTPS alternatives avoids that slow-success path.
The mirror list comes from the [runner image configuration](https://github.com/actions/runner-images/blob/main/images/ubuntu/scripts/build/configure-apt-sources.sh).

## Verification and timing evidence

`npm run test:ci` checks input invalidation, exact ten-target selection,
pack/stage completeness, source/input/hash mismatches, gate ownership and actual
aggregate rejection of failed/skipped/cancelled jobs. `npm run typecheck:ci`
checks these helpers. Hosted publication must still validate complete
native/WASI/fuzz/browser/frozen compatibility and actual cache restores.

The October 18 measurements describe the original result-reuse design, not this
repair. Warm elapsed time fell from 386 to 307 seconds; full-native elapsed time
rose from 381 to 434 seconds. They are single observations, not averages or an
across-the-board speedup. Removing successful-result reuse means its old warm
speedup is not a claim about this workflow. Inspect each new run's job timestamps
and cache logs before claiming a current saving:

```sh
gh api repos/ShaulLavo/bash-web/actions/runs/RUN_ID/jobs
gh run view RUN_ID -R ShaulLavo/bash-web --log
```
