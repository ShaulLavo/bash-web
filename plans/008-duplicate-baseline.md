# Duplicate baseline burn-down

Status: Approved

## Scope and immutable starting evidence

The inventory starts at `53e158770aaab1d8a6ced9773319779030d47b04` on October 31, 2026.
The committed baseline allows **328 exact occurrences across 323 fingerprints** and **14 structural occurrences across 14 fingerprints**.
The real starting scans find 328 exact occurrences and 12 structural occurrences. Two structural fingerprints are already stale.
Do not call deferred production code intentional. No upstream or generated exceptions are claimed in this pass.

Run the current inventory with:

```sh
node scripts/check-duplicates.ts --report /work/tmp/bash-web-duplicate-report.json
```

Each report row carries its fingerprint, both source ranges, token count, and disposition.
`quality/duplicates-*.json` holds the reviewed one-line reason for every retained fingerprint.
The recorder only removes entries or lowers multiplicities. The normal check also compares counts with `DUPLICATES_BASE_REF`, default `origin/main` locally and `HEAD^` in GitHub Actions.
Do not create new fingerprint allowances to make a lower aggregate count pass.

## Fixed in this lane

Share synthetic process observations and encoded empty case records in `scripts/fuzz-test-observation.ts`.
Use one typed synthetic fixture builder in the functions, path, job-lifetime, and printf tests.
No fuzzer source, frozen fixture, Bash observation, or protected pin changes.

<a id="stale-fingerprints"></a>
## Remove stale fingerprints

Delete structural fingerprints `34dd3468ff269f5e` and `700126f8bb9de47b` after both real scans pass.
They are absent from the immutable starting scan, not fixed by this source cleanup.

## Deferred removal items

The groups below are executable follow-ups, not declarations that duplication is acceptable.
Every affected fingerprint and exact source range is recorded in the reasoned baseline and rerunnable report.
After each item, run its focused tests, the required repository checks, and both duplicate scans.
Run `node scripts/check-duplicates.ts --record` only after both scans pass. Confirm no new fingerprint or multiplicity was admitted.

<a id="fuzz-models"></a>
### Share fuzzer result and fixture types

Starting evidence contains 5 exact and 0 structural occurrences.

Move the repeated Options, Case, RecordedCase, Execution, and Report shapes into fuzz-shell-results.ts without broadening scenario-specific case unions.

These source modules participate in frozen fixture source hashes. Their migration cannot safely land here without the prohibited fixture metadata changes.

Affected paths:

- `scripts/fuzz-shell-arithmetic.ts`.
- `scripts/fuzz-shell-braces.ts`.
- `scripts/fuzz-shell-functions.ts`.
- `scripts/fuzz-shell-printf.ts`.
- `scripts/fuzz-shell-readonly.ts`.
- `scripts/fuzz-shell-substitution-boundaries.ts`.

Verification. Run the matching `test-fuzz-shell-*.ts` files, all frozen replay validators, and `npm run quality:js`. Prove case/oracle payload hashes do not change before any separately authorized fixture identity update.

<a id="fuzz-execution"></a>
### Share fuzzer process and report driving

Starting evidence contains 27 exact and 0 structural occurrences.

Extract shared process result codecs, child drain handling, mismatch accounting, replay execution, recording, and report output. Keep each grammar and reduction policy local.

The affected fuzzer sources are part of frozen source fingerprints. Their process teardown and recording contracts also need the existing failure probes, not a rushed rewrite of all drivers in this short track.

Affected paths:

- `scripts/fuzz-shell-arithmetic.ts`.
- `scripts/fuzz-shell-braces.ts`.
- `scripts/fuzz-shell-control-flow.ts`.
- `scripts/fuzz-shell-functions.ts`.
- `scripts/fuzz-shell-job-lifetime.ts`.
- `scripts/fuzz-shell-path.ts`.
- `scripts/fuzz-shell-printf.ts`.
- `scripts/fuzz-shell-readonly.ts`.
- `scripts/fuzz-shell-substitution-boundaries.ts`.

Verification. Run the matching `test-fuzz-shell-*.ts` files, all frozen replay validators, and `npm run quality:js`. Prove case/oracle payload hashes do not change before any separately authorized fixture identity update.

<a id="fuzz-options"></a>
### Share fuzzer options and deterministic seeds

Starting evidence contains 16 exact and 0 structural occurrences.

Extract the common option fields, numeric validation, queue flag, and xorshift generator into one typed helper. Preserve each grammar's defaults and zero-seed convention.

Fuzzer source files and shared helpers are hashed into frozen scripts/fixtures records. This lane may not change those records. Extraction needs a separate provenance-reviewed change that proves frozen case and oracle bytes stay identical.

Affected paths:

- `scripts/fuzz-shell-arithmetic.ts`.
- `scripts/fuzz-shell-braces.ts`.
- `scripts/fuzz-shell-functions.ts`.
- `scripts/fuzz-shell-job-lifetime.ts`.
- `scripts/fuzz-shell-path.ts`.
- `scripts/fuzz-shell-printf.ts`.
- `scripts/fuzz-shell-readonly.ts`.
- `scripts/fuzz-shell-substitution-boundaries.ts`.
- `scripts/fuzz-shell-words.ts`.

Verification. Run the matching `test-fuzz-shell-*.ts` files, all frozen replay validators, and `npm run quality:js`. Prove case/oracle payload hashes do not change before any separately authorized fixture identity update.

<a id="fuzz-validation"></a>
### Share frozen fixture validation

Starting evidence contains 49 exact and 0 structural occurrences.

Consolidate the scalar header checks, oracle identity checks, case byte comparison, and output validation in fuzz-shell-results.ts. Keep schema-specific coverage and filename rules as explicit inputs.

The clone includes release evidence validation. A mistake could admit a changed Bash observation. The protected fixture hashes and all existing negative probes must be reviewed together outside this lane.

Affected paths:

- `scripts/fuzz-shell-arithmetic.ts`.
- `scripts/fuzz-shell-braces.ts`.
- `scripts/fuzz-shell-control-flow.ts`.
- `scripts/fuzz-shell-functions.ts`.
- `scripts/fuzz-shell-job-lifetime.ts`.
- `scripts/fuzz-shell-path.ts`.
- `scripts/fuzz-shell-printf.ts`.
- `scripts/fuzz-shell-process.ts`.
- `scripts/fuzz-shell-readonly.ts`.
- `scripts/fuzz-shell-results.ts`.
- `scripts/fuzz-shell-substitution-boundaries.ts`.

Verification. Run the matching `test-fuzz-shell-*.ts` files, all frozen replay validators, and `npm run quality:js`. Prove case/oracle payload hashes do not change before any separately authorized fixture identity update.

<a id="engine-expansion"></a>
### Share expansion and arithmetic admission mechanics

Starting evidence contains 7 exact and 4 structural occurrences.

Extract the repeated admission, child Expansion construction, case-operator tables, bounded vector reservation, and pattern wrappers. Keep work charging, cancellation, quoting, and raw-byte accounting unchanged.

These blocks sit on resource-limit and expansion boundaries. A safe change needs targeted native and frozen compatibility cases for each helper. The short track prioritizes enforcement and cannot change protected compatibility evidence.

Affected paths:

- `shell/engine/src/arithmetic.rs`.
- `shell/engine/src/exec.rs`.
- `shell/engine/src/expand.rs`.
- `shell/engine/src/expand/pattern.rs`.
- `shell/engine/src/expand/replacement.rs`.

Verification. Run `npm run test:rust`, `LAYERS_BASE_REF=$(git rev-parse origin/main) npm run check:layers`, and `npm run compat:shell`. Exercise cancellation, allocation limits, and rollback cases for the changed helper.

<a id="engine-state"></a>
### Share state snapshot and assignment preparation

Starting evidence contains 3 exact and 0 structural occurrences.

Extract the repeated memory fork and assignment-name preparation in state.rs and the parameter-expansion branch construction in ast_copy.rs. Preserve rollback and allocation charging.

The copies operate on transactional bindings and memory accounting. Targeted failure-at-each-allocation tests are needed before extraction; a mechanical helper substitution is not enough evidence.

Affected paths:

- `shell/engine/src/ast_copy.rs`.
- `shell/engine/src/state.rs`.

Verification. Run `npm run test:rust`, `LAYERS_BASE_REF=$(git rev-parse origin/main) npm run check:layers`, and `npm run compat:shell`. Exercise cancellation, allocation limits, and rollback cases for the changed helper.

<a id="neutral-support"></a>
### Remove clones after the Waffle support migration

Starting evidence contains 13 exact and 1 structural occurrences.

After the executor and I/O migration lands, rescan the listed exact and structural fingerprints. Delete removed entries. Share surviving generic descriptor, cancellation, path normalization, and group-wait mechanics in Waffle, while keeping shell policy local.

The parent track exclusively owns executor.rs, io.rs, runtime.rs, runtime/wasi.rs and their adjacent process support. Editing these clones concurrently would overlap that migration.

Affected paths:

- `shell/engine/src/compat.rs`.
- `shell/engine/src/executor.rs`.
- `shell/engine/src/io.rs`.
- `shell/engine/src/process.rs`.
- `shell/engine/src/runtime.rs`.
- `shell/engine/src/runtime/tests.rs`.
- `shell/engine/src/runtime/wasi.rs`.
- `shell/engine/src/runtime_main.rs`.

Verification. Run `npm run test:rust`, `LAYERS_BASE_REF=$(git rev-parse origin/main) npm run check:layers`, and `npm run compat:shell`. Exercise cancellation, allocation limits, and rollback cases for the changed helper.

<a id="parser-scanner"></a>
### Share parser scanner transitions

Starting evidence contains 6 exact and 0 structural occurrences.

Extract the repeated escape/quote/delimiter transition handling in lexer.rs and subst_scan.rs, including the ASCII identifier rule shared with expand/operand.rs.

The lexer is protected parser-provenance code. Command substitution and expansion have different quote contexts; a shared transition helper needs the parser API and substitution-boundary regressions together.

Affected paths:

- `shell/engine/src/expand/operand.rs`.
- `shell/parser/src/parser/lexer.rs`.
- `shell/parser/src/parser/subst_scan.rs`.

Verification. Run `npm run test:rust`, parser API and bounded-printer tests, `npm run compat:shell`, and the substitution fuzz negative controls. Record any parser source change in the provenance manifest in that owning change.

<a id="engine-interpreter"></a>
### Share interpreter control and diagnostic steps

Starting evidence contains 7 exact and 0 structural occurrences.

Extract repeated stderr writes, loop-step handling, child signal forwarding, resolution diagnostics, and reader outcome handling. Preserve status, scope, cancellation, and trap ordering.

interpreter.rs is under the prompt/session integration and the neutral-support migration. Concurrent edits to context, process group, and cancellation paths are not safe in this lane.

Affected paths:

- `shell/engine/src/interpreter.rs`.
- `shell/engine/src/interpreter/command_builtin.rs`.
- `shell/engine/src/interpreter/control.rs`.
- `shell/engine/src/interpreter/reader.rs`.

Verification. Run `npm run test:rust`, `LAYERS_BASE_REF=$(git rev-parse origin/main) npm run check:layers`, and `npm run compat:shell`. Exercise cancellation, allocation limits, and rollback cases for the changed helper.

<a id="parser-budget-ast"></a>
### Share parser AST and budget construction

Starting evidence contains 5 exact and 1 structural occurrences.

Consolidate repeated literal-word constructors, AST printing arms, parse budget setup, and printer quota construction. Keep test-only public wrappers out of the production implementation.

Parser provenance updates are prohibited here. Budget and printer paths enforce allocation/work limits, so the cleanup needs existing bounded-printer and parser failure tests rather than relabeling these production copies as fixtures.

Affected paths:

- `shell/parser/src/parser/ast.rs`.
- `shell/parser/src/parser/print_cmd.rs`.

Verification. Run `npm run test:rust`, parser API and bounded-printer tests, `npm run compat:shell`, and the substitution fuzz negative controls. Record any parser source change in the provenance manifest in that owning change.

<a id="parser-parameters"></a>
### Unify parser parameter and word operands

Starting evidence contains 22 exact and 1 structural occurrences.

Extract repeated parameter operator selection, name/index scanning, quoted-operand scanning, and conditional token parsing in parser/mod.rs and lexer.rs. Keep quoting and empty-operand semantics distinct.

The paths are owned parser code with local Bash fixes. The required provenance update is protected here, and deduplication must not erase the different quoting contexts or work-budget behavior.

Affected paths:

- `shell/parser/src/parser/mod.rs`.

Verification. Run `npm run test:rust`, parser API and bounded-printer tests, `npm run compat:shell`, and the substitution fuzz negative controls. Record any parser source change in the provenance manifest in that owning change.

<a id="parser-redirects"></a>
### Unify parser redirection branches

Starting evidence contains 15 exact and 0 structural occurrences.

Extract redirection target consumption and descriptor-duplication construction used by both simple commands and compound-command suffixes. Keep fd-variable and append distinctions explicit.

This is owned, modified Bashkit-derived production code, not an upstream exception. Its provenance is recorded in sources.lock.json, whose updates are prohibited in this lane; parser API and Bash compatibility probes must accompany the cleanup.

Affected paths:

- `shell/parser/src/parser/mod.rs`.

Verification. Run `npm run test:rust`, parser API and bounded-printer tests, `npm run compat:shell`, and the substitution fuzz negative controls. Record any parser source change in the provenance manifest in that owning change.

<a id="parser-loops"></a>
### Unify parser loop and function bodies

Starting evidence contains 4 exact and 1 structural occurrences.

Share while/until body parsing, for/select setup, and function-body finishing with explicit syntax kind and diagnostic inputs.

Parser provenance lives in protected sources.lock.json. These branches deliberately differ in error text and grammar entry points; characterize invalid syntax before extraction in a dedicated parser change.

Affected paths:

- `shell/parser/src/parser/mod.rs`.

Verification. Run `npm run test:rust`, parser API and bounded-printer tests, `npm run compat:shell`, and the substitution fuzz negative controls. Record any parser source change in the provenance manifest in that owning change.

<a id="engine-scopes"></a>
### Share evaluation context and parse limit construction

Starting evidence contains 0 exact and 4 structural occurrences.

Consolidate reset/descend scope constructors, storage admission, and generated-word limit arithmetic without merging distinct syntax entry points.

exec.rs and interpreter.rs share context ownership with the shell migration. The parser-wrapper pairs are structural similarities with different parser entry points and need characterization before changing their interface.

Affected paths:

- `shell/engine/src/exec.rs`.
- `shell/engine/src/interpreter.rs`.
- `shell/engine/src/parse.rs`.

Verification. Run `npm run test:rust`, `LAYERS_BASE_REF=$(git rev-parse origin/main) npm run check:layers`, and `npm run compat:shell`. Exercise cancellation, allocation limits, and rollback cases for the changed helper.
