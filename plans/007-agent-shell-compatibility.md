# 007: Agent-shell compatibility

Status: Approved and PARKED for the next product, agents in the browser. Owner decision, 2026-10-25. Resume when that product starts, not during the current shell wind-down.

## Keep the two finish lines separate

Finish the current product, StackBlitz on our stack, under [plan 004](004-own-shell.md). Bash-web must beat Brush on all three frozen corpora. Land or close the remaining open PRs, prove real Ctrl+C for a long-running program, then wind down. Do not extend that work into this program merely to reach 90%.

For the next product, implement the remaining Bash language behavior needed by browser agents. Work toward at least 90% on each frozen builtins-only corpus, with no lost passing case IDs. At the preserved denominators, that means at least 1,514 of 1,682 Oils cases, 1,700 of 1,888 Brush-suite cases, and 2,000 of 2,222 Bashkit-suite cases. This target does not mean 90% of all Bash, external programs, or the skipped cases.

Keep the existing shell architecture. Bash-web owns language semantics and borrows the application's single Waffle runtime. Waffle owns processes, jobs, pipes, descriptors, signals, filesystems, permissions, symlinks, sockets, and runtime teardown. Missing runtime behavior needs a named Waffle contract, not a shell substitute. External commands remain separate WASM programs under [plan 006](006-engine-boundaries.md).

## Start from merged foundations

Use the exact planning anchor `f6e3a9e67d56332b0476f3608e198bf74e8e12f3`, then inspect what the parent actually lands after it. These foundations are already in that anchor:

- State-owned bindings and lifetimes, sparse indexed storage, admission tickets, and assignment rollback. PR84's rollback repair is merged at `29ba56e6b42a40024f2b14a38db5384588fc28ad`.
- PR102's typed references, `Owner`, `Place`, binding inverses, and prefix amendments, merged at the planning anchor. Extend those paths rather than adding another selector parser, resolver, binding store, or declaration journal.
- Ordinary scalar `local -I` from PR98 at `2455722e1543b72869d1cccb8d50ff88348df7d3`, plus earlier scope-aware append, namerefs, case attributes, source/eval, aliases, and live call-stack projections.
- Positional defaults and name expansion, prompt decoding, tracing, PIPESTATUS, noexec, floating-point printf, builtin availability, and help. Their remaining composition gaps are not missing implementations of the whole families.
- Bounded negative extglob from PR91 at `00ea3d41ac75d7527bafb97fdcef7eed54c89e8c`, and `time` plus bad-substitution recovery from PR83 at `d6da090fd4c658383cabd815fc4fea8f1f81a258`.
- PR103's source-based layer checks and artifact-owned passing floor at `15ee1ac706db832fb94c8cff3877f1b9fa226053`. Use the existing qualification resolver, not another floor journal or evidence writer branch.

Read actual source before treating an older feature page as current. In particular, `docs/status.md` contains dated unsupported-feature observations and an older committed floor. Neither is a fresh observation of f6.

## Preserve the retained work without promoting its evidence

These are the owner's handoff facts on 2026-10-25, not a live PR-status query. Recheck the parent's final dispositions when resuming.

### PR86 is closed, with a dormant durable-write API

Preserve head `e9ad6363ffda60e1d8f8e8548f57c38f7672d8ab`, tree `6896578d7463c654926c307fee4413f6bc40bf5a`. Its normal integration includes exact landed PR102. It has no production durable consumer and zero measured gains. Do not describe closure as a merge or the API as delivered behavior.

Read `/work/reports/wave-20261022/shell/owner-plan-20261024/after103/pr86-after-landed102-owner-adaptation.md` and its sibling evidence directory. The report predates closure. It preserves the adaptation, both prefix policies, owner/incarnation matching, retained assertions, bounded native/WASI results, and execution deviations. Historical source approval does not approve this adaptation.

Resume only with a named production consumer and fresh independent review. Preserve typed `Remove`, durable `Append` and `Superseded`, saved-owner selection, full-pool rollback, and exact refunds. Resolve the deferred live-array destruction, shared-inverse overcharge, estimator-walk, and source/eval follow-ups where the consumer depends on them. Do not merge a dormant API to claim progress.

### PR89 is closed, with Unit 1 preserved

Preserve head `ca34a3f43ccf7c21af69ef73a5d4415dbbfa0be6`, tree `a9e9ffb9224d690cc08b57ef2ba133226d63dda5`. This is the replacement declaration bridge, not the scalar-integer prototype. Unit 1 has no measured score gain. Its bounded native and actual debug-WASI evidence does not establish independent acceptance, full qualification, or landing.

Read these retained documents in order:

1. `/work/reports/wave-20261022/shell/owner-plan-20261024/variables/attribute-contract/parent-decision.md`
2. `/work/reports/wave-20261022/shell/owner-plan-20261024/variables/attribute-contract/bridge-after102.md`
3. `/work/reports/wave-20261022/shell/owner-plan-20261024/variables/attribute-contract/unit1-after102.md`

Keep the prepared declaration-write boundary. Feature preparation may suspend. After preparation, revalidate the named attribute owner and resolved value destination. Admit the whole operand, then publish synchronously without another fallible step. Reuse State's existing inverse and ticket machinery. Preserve earlier operands and completed arithmetic side effects when the current operand is refused.

Do not revive `c68ca9e85f52ca425199fc35f1af9575e11a8316` or its early attribute publication, scalar-name coercion hook, and obsolete exclusions. Its ancestry and receipts remain historical evidence. Units 2 through 5 are pending, not delivered:

2. Prepared `+n` detach and write effects.
3. Integer metadata, snapshots, printing, and feature-layer coercion through the typed write.
4. Numeric append and indexed integer conversion.
5. Cross-family and unchanged-floor qualification.

Retain the packet limitation. Its whole-document oracle comparison fails against newer runtime metadata, although all 11 recorded scripts and byte/status observations match the main source examined by Unit 1. Do not rewrite the packet, frozen oracle, or baseline to hide that mismatch. The known readonly-integer redeclaration continuation gap remains later work.

### PR101 is closed and deferred to the next product

The parent closed PR101 unmerged under the owner's current-product scope at `2026-10-25T04:59:29Z`. Closure comment `6393684291` defers it as Approved next-product work. Preserve head `121f443b66ab27b019890c9f797d59656bcff8a1`, tree `c1072ea566f5287a483ace39d997a4d0891ac495`, and the approved trap review. Closure does not establish full qualification or delivery.

Read `/work/reports/wave-20261022/shell/owner-plan-20261024/after103/pr101-after-landed102-integration.md` and the parent's subsequent review and landing receipts. Preserve submission versus EOF, explicit completion, root Exit and Abort reuse, isolated-child behavior, descriptor ownership, and live RETURN frames. Bounded integration checks are not final hosted qualification. The separate timed-function cancellation `151 vs 103` failure belongs to the hotfix owner, not a trap or declaration workaround.

## Resume in this order

Complete one verifiable unit at a time. Reuse merged work and the preserved source above. If the parent lands a unit during wind-down, verify its boundary and skip its implementation here.

1. **Restore the starting facts.** Read the current global and repository instructions, plans 004 through 006, current source, and parent handoff. Confirm PR101 and PR105 dispositions. Resolve the actual main passing floor and its source/run/artifact identities before claiming a remaining-case count. Do not reopen closed PR86 or PR89 automatically.
2. **Complete trap behavior still missing after wind-down.** Reuse any landed PR101 implementation. Cover EXIT, ERR, DEBUG, RETURN, inheritance, errexit contexts, nested source/eval/function calls, normal completion, cancellation, and actual signal delivery as distinct contracts. Keep registration-only evidence separate from action execution. Real process signal delivery and descendant cleanup remain Waffle-owned.
3. **Finish the shared variable model.** Review and qualify retained declaration Unit 1 against the actual merged owner model. Continue Units 2 through 5 in their approved order. Keep attributes attached to the named binding and value writes attached to the selected `Place`. Preserve local, prefix, readonly, case, export, nameref, IFS, unset, and return/cancel/drop behavior. Integrate PR86 only when an actual consumer needs its distinct durable policy. Then add remaining indexed operations, associative storage, and array input consumers such as `read -a` and `mapfile` through that model. Those consumers are outside Unit 1, not grounds for another resolver or journal.
4. **Preserve lists through expansion.** Fix nested `@` and `*` defaults, array operators and transformations, declared-but-unset name enumeration, and prompt/list composition. Preserve quoted versus unquoted fields, empty elements, IFS joining, lazy operand order, and exactly-once subscript effects. Use plan 004's exact reproducers under "Unquoted outer defaults flatten nested lists", "Declared-but-unset local names in prefix expansion", and "Follow-up: nested array-list expansion in PS4".
5. **Complete byte and pattern composition.** Reuse merged negative extglob and the existing matcher. Address remaining pathname, completion, replacement, trim, quoting, locale, and group-boundary behavior against exact cases. For proven raw-byte blockers, change fields, bindings, captures, splitting, patterns, argv, and output together. Keep byte offsets distinct from character operations. Do not replace invalid bytes with Unicode replacement characters. Start with plan 004's "word fields carry bytes, not UTF-8 String" and its four confirmed scored IDs. Do not promise gains from representation work alone.
6. **Qualify the remaining agent workflows.** Rank the still-failing language cases by product use and measured payoff. Run cross-family contracts and the unchanged frozen replay through production Waffle. Compare exact gained and lost IDs, then report each corpus separately. Stop at the approved product boundary rather than inventing more compatibility work.

Each unit needs an exact source, a bounded reproduction, an owning module, acceptance controls, and a cleanup owner before implementation. Record remaining work in this plan or the owning report, not a new GitHub issue.

## Preserve the score's meaning

Keep all 9,221 case IDs, 5,792 scored cases, and 3,429 skips, with the same classifications and exclusions. Preserve the frozen GNU Bash 5.3.15 observations, scripts, stdout/status expectations, and source identities. stderr remains recorded separately rather than silently becoming a different score. New causal controls supplement the frozen cases. They do not replace them.

Treat gains as monotonic passing-ID membership, not just a total. No lost pass is excused by a gain elsewhere, even within the same corpus. Admit newly measured gains through the existing artifact-owned floor. Do not lower a baseline, recapture an oracle, discard a complete failed timeout, or change an exclusion to make a feature pass.

Keep these historical observations distinct:

- The audited actual-main observation after PR91 has Oils `1338/1682`, Brush-suite `1451/1888`, and Bashkit-suite `1816/2222`. Its source is `00ea3d41ac75d7527bafb97fdcef7eed54c89e8c`.
- The later main83 floor contains 4,632 passing IDs. It is an accumulated floor, not the earlier main91 raw observation.
- A PR102 candidate observation has 4,734 passes. The source-specific union has 4,761 required passing IDs. Neither number is a current-main observation, and a PR artifact never becomes main evidence by assertion.

These handoff numbers are not a current score table. On resume, use the actual source-bound artifact and the existing resolver described in [landing checks](../docs/landing-infrastructure.md). Record head, tested merge, event base, resolved main, run, attempt, producer, and artifact digest. If evidence expired or is missing, report the exact qualification prerequisite rather than falling back to the old committed counts.

The baseline and oracle at the planning anchor share these identities:

```text
caseSet     3c38e4fb351a85ad936d1d324fcd80d75321d20089535b947d23c406ab2b7c5a
oracle      ebc3234245249f0e0292f9362c0ad63a71de36c7e1279886a038e747159ddc5d
environment 6ed3e700fcfca7d03ae94ae372480a00ca737d3baa211cea90659f91c6e94c60
sources     6da342fee1380a0932f51e9cbcd306595dee8b77ffda024c591486365372345d
```

## Recover source before running work

Use an exclusive worktree. Keep `/work/projects/bash-web` read-only for source inspection and shared Git management. Discover retained worktrees before creating one. The following are resume commands, not work executed by this parked plan:

```sh
cd /work/projects/bash-web
git fetch origin --prune
git worktree list
git show --no-patch f6e3a9e67d56332b0476f3608e198bf74e8e12f3
git show --no-patch e9ad6363ffda60e1d8f8e8548f57c38f7672d8ab
git show --no-patch ca34a3f43ccf7c21af69ef73a5d4415dbbfa0be6
git show --no-patch 121f443b66ab27b019890c9f797d59656bcff8a1
git log --oneline f6e3a9e67d56332b0476f3608e198bf74e8e12f3..origin/main
git worktree add /work/worktrees/bash-web/agent-shell-resume -b next/agent-shell-resume origin/main
cd /work/worktrees/bash-web/agent-shell-resume
if [ -f AGENTS.md ]; then
	cat AGENTS.md
elif [ -f CLAUDE.md ]; then
	cat CLAUDE.md
else
	cat ~/.agents/AGENTS.md
fi
git status --short --branch
jq '.identity' docs/evidence/own-shell-oracle.json
jq '.identity' docs/evidence/own-shell-baseline.json
```

If a retained object is missing, recover its exact ID from the parent's retained refs and receipts. Do not substitute an old prototype or copy an unmerged branch wholesale. Review the net diff against the chosen immutable main. Keep the existing Waffle pin unless runtime work explicitly requires a new merged public contract.

## Qualify behavior and runtime contracts separately

After reading machine-fleet instructions, select an available host and install all-exit teardown before tests. Use the repository's current supported build recipes and the canonical heavy-job admission. Preserve SDK34, patched libc, debug-WASI stack and memory limits, normal Rust settings, and serial exact test selection for bounded diagnosis. A native pass does not prove WASI stack safety. A release guest does not replace debug-WASI evidence.

The implementation owner supplies focused refusal, cancellation, pending-drop, scope-restoration, and refund controls. The parent supplies fresh independent review and the complete hosted qualification for the final source. Reuse `npm run test:rust`, `LAYERS_BASE_REF=<immutable-main-SHA> npm run check:layers`, `npm run test:shell:wasi`, `npm run compat:shell`, and the relevant runtime/browser commands according to the current repository workflow. These are future gates, not passes claimed by this document.

Preserve bounded storage, work, recursion, captures, fields, matcher state, and cooperative yields. Fail explicitly on exhaustion without partial publication. Do not raise limits, add a generic frame framework, restore whole-State cloning, or weaken tests to hide a failure. Keep the core dependency proof, streaming, compressed-size, and cold-start checks. Report small size or speed misses with measurements rather than grinding for a nominal threshold.

For actual Ctrl+C, observe a real long-running foreground guest through the production runtime and terminal path. Prove prompt recovery, the intended status, foreground/descendant exit, unrelated-background survival, and worker/pipe/process cleanup. A mocked flag or registration test is not that evidence. Recheck any runtime gaps against the actual Waffle pin before carrying old limitations forward. Never claim skipped Bun, Safari, filesystem-stall, terminal, or descendant cases have passed.

Stop owned consumers before removing test resources. Keep small evidence and reproducers in the report destination. Remove task-created targets, binaries, dependencies, browser profiles, temporary routes, and scratch. Preserve shared caches and owner services. Record any retained resource's size, reason, removal condition, and cleanup owner on the actual host.

## Owner decisions and stop rule

The next-product program is approved, but it has no promised duration or score gain per unit. A dormant API or a passing focused test is not product delivery.

After about two hours or two rounds without meaningful progress, stop that unit. Record the exact source, what works, the remaining cases or contract, and what finishing would cost under "Owner decisions". Move to other useful work. The owner decides whether further effort pays off. Do not start review-of-review cycles or chase the last cases, bytes, or percentage points unless the owner explicitly asks to hill-climb.

Implementation is complete only after review, required checks, merge, exact-main verification, product delivery requirements, and actual-host cleanup. This plan and the preserved commits are not completion. The parent folds this documentation into the next necessary product PR rather than opening a standalone docs PR.
