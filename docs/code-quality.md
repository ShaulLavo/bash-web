# Code quality gates

Use Node 26.7.0, the checked-in Rust 1.98.1 toolchain, and locked dependencies:

```sh
npm ci --ignore-scripts
export CARGO_TARGET_DIR="$PWD/.build/quality"
cargo install cargo-machete --version 0.9.2 --locked --root .build/quality-tools
npm run quality
```

`quality` prepares the pinned Ghostty source and Waffle worker, checks the immutable
peer/development/lockfile package identity and worker assets, then runs formatting,
lint, types, unused-code analysis, both duplicate scans, gate failure probes, and Rust
checks. The `quality` CI job runs the same command on pushes and pull requests.
Existing architecture, native/WASI, browser, and frozen compatibility jobs remain
separate blocking checks. Set `BASH_WEB_TEST_PORT` for a browser test run in a
parallel worktree. Its default remains 4198, and Playwright never reuses an
existing server.

## Coverage

- Oxlint 1.88.0 checks all authored JS/TS in `src`, `scripts`, and `tests`, plus the
  Vite and Playwright configs. Correctness diagnostics and warnings fail the gate.
  Explicit `any`, unused variables, debugger, eval, loose equality, and unqualified
  browser-global `name` are errors. Maximum control-block depth is 3 and modified
  cyclomatic complexity is 30. These are lint limits, not a Rust parser or a proof
  of every language's nesting depth.
- TypeScript 7.0.2 uses `strict` for application code, tests, configs, and every
  authored TypeScript script. Imported JavaScript supplies inferred API types;
  JavaScript bodies are linted rather than migrated wholesale to checked JS.
- Knip 6.41.0 checks files, exports, types, and dependencies. Package exports, HTML,
  config plugins, and package scripts supply real roots. The runtime test driver's
  discovered test patterns and compatibility worker are explicit dynamic roots.
  The pinned Ghostty alias and its Hotkeys dependency live outside this graph.
  The duplicate driver launches jscpd by executable path. These three dependency
  exceptions are documented in `.knip.jsonc`; configuration hints fail the gate.
- Rust uses `shell/Cargo.toml`, including the owned, patched Bashkit-derived parser.
  Its local changes remain recorded in `sources.lock.json`. `cargo fmt --all`,
  locked host and `wasm32-wasip1` workspace/all-target Clippy with `-D warnings`, locked workspace tests,
  and cargo-machete 0.9.2 with offline metadata are blocking. No warning allowances
  hide parser or engine code. Downloaded upstream sources, build output, and
  dependencies are not lint targets.

## Duplicate baselines

jscpd 5.4.1 runs two scans with a 5-line/50-token minimum:

| Scan                                         | Coverage                                                   | Policy        |
| -------------------------------------------- | ---------------------------------------------------------- | ------------- |
| Exact, mild tokens                           | JS, TS, TSX, Rust under `src`, `scripts`, `shell`, `tests` | No new clones |
| Structural, `--similarity 0.8`, 20 AST nodes | Rust under `shell`                                         | No new clones |

Both scans use `--fail-on-new-clones 0` and `--fail-on-empty`. There is no percentage
allowance or automatic baseline rewrite. Exact scanning includes tests. jscpd's
structural mode omits test files by design, but still sees inline Rust test modules.
Only generated fixture data and Cargo target directories are excluded from these
source roots. The parser is included in both scans, not treated as untouched vendor
code. Baselines are in `quality/duplicates-*.json`.

The initial inventory preserves existing fixture builders, shell syntax handlers,
and similar test cases. This change removes unused printer implementations and
shares process-result codecs and byte validation instead of accepting those copies.
The baseline fingerprints include multiplicities, so adding another occurrence of
an existing clone is not an allowance to grow it.

Merging main `2a0905a` reconciles token identities after its binding-state,
shared parse entry points, typed command dispatch, and Waffle build changes.
Exact clones change from 344 to 356, with 50 added and 38 removed occurrences.
Structural clones change from 16 to 15, with 5 added and 6 removed. Every added
fingerprint and multiplicity exists in an independent scan of that immutable main
snapshot. The repeated guest-registration loop is shared instead of baselined.
[The fingerprint delta](evidence/quality-integration.json) records this
reconciliation. No-new-clones and empty-scan failures stay unchanged.

To review a deliberate baseline change:

```sh
npm run check:duplicates                 # inspect failures first
node scripts/check-duplicates.mjs --record
npm run check:duplicates                 # both scans must pass unchanged
```

Include the added/removed fingerprints and the reason in the PR. Do not update a
baseline merely to hide a finding. Tool upgrades require a fresh reviewed inventory,
not a relaxed duplication percentage.

`npm run test:quality-gates` proves valid controls pass and debugger, ambient `name`,
type errors, unused files, new exact clones, new structural Rust clones, and empty
scans fail. Probes use isolated `.scratch/quality-probe-*` projects and remove them
in `finally`, including on assertion failure. No services or deployments are created.

Fuzzer source edits refresh only source-identity metadata. Frozen case definitions,
Bash observations, seeds, counts, and output bytes must remain unchanged. Fixture
validators and frozen-payload hashes continue to enforce those observations.
