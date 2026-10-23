# 004: Our own WASM-first shell

Status: Approved (owner, 2026-10-16)

## Goal

The browser dev environment from plan 001 gets a bash-compatible shell we design ourselves, written for single-threaded `wasm32-wasip1` from the start. It runs real programs (`bun`, `grep`, `sed`) as child processes and streams their output live: `bun dev | grep error` shows each matching line as it happens. Correctness is measured against GNU bash, and the score only goes up.

Brush stays the working shell in this repository until step 6 replaces it.

## Decision

A shell has three parts:

- **Parser:** text to syntax tree. It starts from Bashkit's parser at `491c3281` and changes freely; the parser is ours.
- **Bash rules:** what the syntax means. Variables, quoting, word splitting, expansions, arithmetic, control flow, functions, `set -e`, traps and the state-changing builtins (`cd`, `read`, `declare`, `eval`).
- **Engine:** how commands run. Starting processes, moving bytes between pipeline stages, waiting, Ctrl+C and background jobs.

We write the engine and the interpreter structure ourselves, then port Bashkit's bash rules into that structure one area at a time. Each area is checked against real bash as it lands.

Why not keep Bashkit's interpreter and swap its engine: the spike's low-confidence estimates to reach Brush-level compatibility are 4–9k newly written or substantially changed shell lines for that route, against 8–16k for this plan, both excluding the shared runtime, utility ports and tests. But Bashkit is built as a sandbox for AI agents. Its README promises no process spawning by default, all 167 commands reimplemented in Rust in-process, and scripts that run to completion and return their output. That assumption runs through its interpreter (one `Interpreter` struct with 123 declared fields). The spike found four separate places where output or input is collected whole instead of streamed: the final pipeline stage, generic stdin collection, process substitution and the accumulated result output. Each missed spot would be a pipeline that silently stops streaming, which is Brush's problem again. Porting the rules into a structure built for real processes avoids that. The risk of porting, getting bash rules subtly wrong, is what the compatibility harness measures.

Evidence: `/work/reports/browser-shell-research/own-shell-spike.md` (execution-model proof, Bashkit audit with file:line references, estimates and risks), [docs/bash-compatibility.md](../docs/bash-compatibility.md) (scores), `/work/reports/browser-shell-research/handoff-shell.md` and `handoff-runtime.md`. No Unix fork and no WASIX: neither StackBlitz nor CodeSandbox does fork in the browser, and StackBlitz ships its own shell.

This supersedes plan 001's choice of Brush, its fallback of forking Bashkit, and its steps 1b, 3 and 4. Plan 001 step 2 (one WASI host, OPFS filesystem) continues as the shared runtime work this shell runs on.

## The score

The scoreboard is `npm run compat`: GNU bash 5.3 is the oracle, a case passes when stdout bytes and exit status match, and the interpreter score uses builtins-only cases. Targets to pass, in order:

| Builtins-only corpus | Cases | Brush (browser) | Bashkit source |
| -------------------- | ----: | --------------: | -------------: |
| Oils                 | 1,682 |           78.4% |          95.4% |
| Brush suite          | 1,889 |           70.8% |          84.1% |
| Bashkit suite        | 2,223 |           82.1% |          96.2% |

Brush's numbers after the `$$` fix are 78.5%, 71.2% and 82.3%. The held-out rows are the honest comparison: Bashkit was tuned against Oils and its own suite.

Rules for climbing:

- **Ratchet.** CI records exact pass counts per corpus and per category for the new shell, over an identified fixed case set with a pinned oracle and environment, not rounded percentages. A PR may not lower any corpus's pass count. A case that newly fails needs a named reason in the PR. Runs whose case set, oracle or environment differ are incomparable and rejected; a corpus or oracle change reruns base and candidate under identical inputs, and the baseline update is reviewed explicitly.
- **Every PR states its delta**: cases gained and lost per corpus, from the harness output.
- **Guardrails climb with the score.** A PR that breaks a guardrail is not merged for a score gain.
  - Size: the shell's release WASM, compressed with brotli-11, stays at or under Brush's 1.0 MB (Bashkit's is 2.4 MB).
  - Cold start: with the documented Fast 4G plus DevTools 4× CPU profile, fresh browser profiles, the Canvas renderer and ten cold trials, the median from navigation to painted prompt is at most 100 ms slower than Brush measured in the same run ([docs/cold-start.md](../docs/cold-start.md); Brush measured 2.32 s there).
  - Streaming: all sixteen acceptance tests across the seven scenarios from step 1 stay green.
- **Port, then diverge.** When porting an area, start from Bashkit's implementation and its tests, recording the source path and revision. Do not port its known bugs: the `mapfile` array-budget leak (`/work/reports/upstream-bugs/README.md` #20) and final-stage buffering (#25).

## Steps

0. **Skeleton.** A Rust workspace at `shell/` in this repository (it is extracted with history to `ShaulLavo/bash-web` under the approved sequence below, independently of the future product repository). Start from Bashkit's parser at `491c3281f668b76d64b15210b8f5d7bf97244be0` (MIT): pin it in `sources.lock.json`, add it to `THIRD_PARTY_NOTICES.md`, and maintain it freely as our own parser. Record local changes alongside that base revision instead of requiring byte identity. Keep its upstream parser tests running in `npm run test:rust`; remove one only for a deliberate behavior change with the reason recorded in the parser change log. The spike's proof (`/work/tmp/own-shell-spike-tloM5o/proof`) is the starting reference, not code to extend blindly: its mock processes, polling reactor and toy commands are replaced.

1. **Engine on real browser workers.** This gate is mandatory before step 6 replaces Brush. Steps 2 and 3 may proceed with tested `ProcessHost` stand-ins, as approved by the owner on 2026-10-16. The interpreter runs on one async executor in one worker: every pipeline stage, subshell and background job is a task. Shell I/O never blocks; the executor parks only when no task can run, and wakes on I/O readiness, child exit or interrupt. File descriptors are a table of reference-counted endpoints: subshells and stages share open endpoints, never copies, so EOF and EPIPE follow the last close. Pipes are bounded (the proof used 32 KiB). Bounded pipes alone do not bound memory: define limits and backpressure, spilling or explicit failure at the terminal and worker queues, command captures, substitutions and accumulating utilities. Command dispatch, loops, expansions and in-process utilities run with bounded work budgets, explicit yields and interrupt checks, because a task that never waits on I/O would otherwise starve every other task. Child processes go through a process-host interface (spawn with argv, environment, cwd and descriptor bindings; wait; kill; nonblocking readiness and exit notifications), implemented on the shared runtime from plan 001 step 2. Until that lands it may use this repository's current process imports, but only after generalizing that host: today it tracks one active child and passes no arbitrary descriptor bindings, so it cannot run Bun-to-Bun pipelines or the inherited-descriptor test. Define the guest-visible broken-pipe contract with the runtime: a child killed by a closed pipe reports 141, but a guest that handles EPIPE keeps its own exit status.

Step 1 includes the minimum production semantics, fixture commands and session interface these tests need (simple functions, redirects, a few builtins). Later steps broaden that implementation; steps 2 and 3 can use the native/WASI stand-ins while this browser gate remains open. Acceptance, in the browser:

- commit `/work/reports/browser-shell-research/pipelines.acceptance.spec.ts` under `tests/`, change it to select the new engine explicitly and assert which engine is running (Brush is still the default), then pass all sixteen tests across its seven scenarios with real `bun` children: live ticker through `grep`, more than 1 MiB in all four builtin/external pairings, Ctrl+C, `pipefail` and `PIPESTATUS`, early reader exit, state inheritance, backpressure;
- Ctrl+C reaches the shell while WASM is running (a shared interrupt word, not a message), interrupts the foreground job and its descendants, confirms their exits, and leaves unrelated background jobs running; shell shutdown cleans up the whole session;
- an always-ready background loop (`while :; do :; done &`) does not stop foreground commands from responding;
- a guest that handles EPIPE and exits with its own status keeps that status;
- a slow terminal and an accumulating consumer stay within the defined memory bounds;
- a non-standard descriptor (`3>&1`, `exec 4<file`) is inherited by a child;
- `bun dev &` returns to the prompt, keeps streaming, and the next command can `kill %1` or `wait` for it.

**Acceptance-only utilities (2026-10-17, Approved).** Provide `grep` and
`mkdir` as in-process descriptor tasks solely for this gate. The grep subset is
adapted from the pinned Bashkit `builtins/grep.rs`; it accepts `-v -c -q -n -i
-F -E`, streams records without the bug25 output-buffering path, bounds records
and regex resources, and retains GNU 0/1/2 statuses. `mkdir` and `-p` use the
runtime filesystem. Provenance, exact bounds and deliberately unsupported syntax
are in `sources.lock.json:shellAcceptanceUtilities` and
`docs/external-commands.md#acceptance-only-in-process-utilities`.

These commands unblock exactly these existing, unchanged cases in
`tests/pipelines.acceptance.spec.ts` (not a claim that the entire browser gate
has passed):

- `pipeline forwards ticker lines while the producer is running` —
  `bun run ticker.ts | grep tick`;
- `pipeline Ctrl+C stops every stage and its children` —
  `export KEEP=kept; bun run endless.ts | bun run read.ts | grep unmatched; echo BAD_AFTER_INTERRUPT`;
- `pipeline stages inherit functions, unexported variables, cwd and redirections`
  — `mkdir nested; cd nested; secret=retained; f() { printf '%s\n' "$secret:$PWD:$1"; }; f value | cat > result; cat result`.

Native descriptor regressions additionally pin quiet early exit, no-match
cancellation, byte preservation, regex/record admission, >1 MiB streaming,
broken pipes, counts/statuses, and existing directory/file handling. No new
utilities beyond these commands are approved here; the general set remains
step 4. Directory metadata uses the same synchronous Preview1 filesystem
boundary as opens, so the filesystem stall/cancellation gate below also applies
to `mkdir`; it is not closed by racing the outer future with cancellation.

**Terminal dependency (2026-10-17).** Step 1's raw shared endpoint carries
byte-exact pipes and gives the shell guest its own prompt editor. Per-child
canonical terminal input (echo/editing and one-shot Ctrl+D EOF for a foreground
child) depends on the shared runtime's step 5, **Terminal**: terminal descriptor
foreground ownership, cooked mode ported from Brush, and raw mode that passes
Ctrl+C through. This is approved later work, not a reason to close the whole
shared terminal to fake child EOF. When that runtime feature lands, the shell
hands foreground terminal ownership to the child job and takes it back on exit.
The current integration does not claim a child PTY/canonical-input implementation.

**Remaining runtime gates (2026-10-17).** The integration may land while these
runtime-owned limitations remain explicit; step 1 is not fully satisfied until
they are removed, and they remain mandatory before step 6 replaces Brush:

- **Lifetime process limit.** The shared directory currently has 1,024 slots,
  including the shell root; completed/reaped processes do not release them.
  `runtime/proc/worker-client.ts:reserveRecord` monotonically consumes the count.
  `scripts/fixtures/runtime-process-limit.test.ts` uses the real client, broker,
  supervisor, wait and reap to pin the known failure after 1,023 sequential
  controlled commands; it launches no guest. Its TODO preserves the 2,000-command
  target. Run through admission: `bun test scripts/fixtures/runtime-process-limit.test.ts`;
  `--todo` additionally attempts that currently failing target. Remove the
  known-failure assertion and execute the target after runtime slot recycling
  with PID/generation validation lands. Recheck real browser sessions afterwards.
- **Bun-created descendants.** Runtime step **7b** will replace the historical Bun
  subprocess bridge with the shared process service. Today a shell-launched Bun
  parent is in the directory, but its `Bun.spawn` descendants are not, so shell
  whole-job interruption cannot reach them. Nested `Bun.spawn({stdin:"inherit"})`
  now retains a generic runtime pipe reader, but still gets EOF for a generic
  parent's regular-file or terminal fd 0 across that legacy bridge. Direct
  `runtime_proc` child inheritance is not affected. The full foreground-descendant
  and independent-background browser test remains unchanged but explicitly
  `fixme` pending 7b; this is a known failure, not passing cancellation evidence.
- **Bun guest libc preopen discovery.** The pinned Bun guest's wasi-libc scans
  descriptors from 3 until BADF and exits 71 on any other error. A truthful NOTSUP
  for an inherited terminal at fd 3 therefore aborts startup before the real
  relocated root preopen is found. The Bun fd3/fd4 offset and root-preopen browser
  cases remain explicitly `fixme` pending a guest libc fix that skips occupied
  non-preopen descriptors. Do not invent successful directory metadata or invalid
  prestat tags. Builtins and direct `runtime_proc` shell children retain active
  arbitrary-fd/root-preopen browser coverage; those do not use Bun's libc scan.
- **Shared-filesystem devices.** The runtime has no device nodes yet. Do not
  create a regular `/dev/null`: it retains writes instead of discarding them.
  Waffle will provide real `/dev/null` (discard writes, EOF reads), `/dev/zero`,
  `/dev/urandom`, `/dev/stdin`, `/dev/stdout`, `/dev/stderr` and `/dev/fd/N`
  aliases resolved against the opening process's descriptors. `/dev/tty` follows
  the terminal step. Missing devices are a known limitation, not shell-only
  implementations; child programs must observe the same semantics.
- **Filesystem stall/cancellation.** Rust `Runtime::open` currently calls Preview1
  `path_open`; directory creation/stat likewise use synchronous Preview1 calls.
  `FilesystemClient.call` can enter an indefinite `Atomics.wait`.
  A stalled filesystem service therefore blocks shell task progress and SIGINT
  handling: `poll` is not yet the sole blocking operation. The runtime will add
  copied-input open submission, nonblocking take/cancel and kind-3 completion
  readiness; Rust must use a cancelling RAII request owner with no blocking
  fallback. `scripts/fixtures/runtime-filesystem-pending.test.ts` records the
  pending deterministic gate: hold an open indefinitely, advance ready background
  work, interrupt the foreground to status 130 without releasing the gate, then
  deliver the late result and prove no fd leak. Success, ENOENT,
  completion-before-registration, completion/cancel ownership and invalid output
  memory are separate pending cases. These TODOs are not execution evidence.

**Approved startup-diagnostic adoption (2026-10-18; delivered in PR #21).**
Waffle 0.0.50 at `33ece68f9f484d99b8a57a675de71d847e248051` includes
the quiet-start 0.0.49 contract: typed
`START_FAILED` is the only child-visible report for admitted `runtime_proc` children,
including executable resolution and lazy loading before adapter registration.
Full errors remain in host diagnostics. Host spawns with bookkeeping parents are
not runtime children and retain generic stderr; no root-only interception or
local runtime patch is used. Package peer/dev pins, both generated dependency
locks, trust version and source provenance move together.

- Original `src/runtime/lazy-start.test.ts` exercises real `WorkerProcessClient`
  notifications through `broker.runtimeMessage`, not a host spawn masquerading
  as a runtime child. Metadata admission precedes a lazy
  `WebAssembly.CompileError("review loader failure")`, with zero adapter launches,
  guest errno 45 and typed ENOEXEC / host errno 8. Terminal and pipe must stay
  empty, the pipe reaches EOF, and exactly one full host error retains its cause
  and stack. The host-root reporting control remains unchanged.
- Failing-first on Waffle 0.0.47: the shipped `npm run test:runtime:terminal`
  runner passed 124/126 controls; only the new runtime-terminal and runtime-pipe
  cases failed, observing the generic line and 60 pipe bytes respectively.
  The same cases pass with 0.0.49; after adding lazy-fixture cancellation coverage,
  the bounded runtime suite passes 127/127. The final 0.0.50 pin also passes
  127/127, package contracts, strict TypeScript, lint, format, Knip, exact and
  structural duplicate gates, layer controls and cleanup/negative controls.
  These local results are separate from the integrated delivery evidence below.
- The browser fixture `/bin/test-lazy-start-failure` uses the shipped lazy loader.
  `tests/pipelines.acceptance.spec.ts` requires one complete shell diagnostic in
  both a pipe and regular file, and retains closed-fd2, real126/127, worker
  cleanup and foreground/background EOF acknowledgement controls. Required
  Chromium/Firefox CI qualified these captures in PR #21 and on its main merge.
- PR #21 merged as `c81f3b57e861835bc6390b32ecfc4544627c1729` after independent
  approval and all ten required PR checks. Its exact-main run `39144577199`
  passed all five checks: 1,130 native and 1,115 WASI tests, 214 browser passes
  with the same 16 inherited skips, and frozen memberships 949/955/1341 with
  no gained, lost or newly failing cases. Actual-host checkout/scratch cleanup
  is complete. This delivered quiet-start evidence is not descriptor-unit evidence.
- Keep the explicit adapter `startFailed` hook: its removal changes host-spawn
  behavior. The five host-broker modes now explicitly distinguish retained adapter
  policy from unchanged host-default reporting, post-start failure and genuine
  exits. Quiet runtime-child reporting has independent no-hook coverage.

**Approved inherited-descriptor predicates unit (2026-10-18); implemented, focused checks pass.**
This separate unit follows the quiet-start adoption in PR #21. `test`, `[` and
shared `[[ ]]` now query `runtime_proc.fd_kind` from Waffle #36 at the adopted
0.0.50 pin. The query uses the endpoint's physical handle, including inherited
private duplicates and logical remaps. Both local pipe ends and transported
runtime pipes satisfy descriptor-alias `-p`; terminal descriptors satisfy `-t`.
Category 0 remains other/unknown, never FIFO. Preview1 filetypes and unrelated
predicate capability/status behavior stay unchanged.

- GNU Bash 5.3.15 oracle covers inherited read/write pipes, aliases/remaps, files,
  closed fds and a real controlled PTY, including numeric statuses and unchanged
  payload/EOF. Signed decimal and surrounding ASCII whitespace follow the
  existing intmax parser; signed-64 overflow is an integer error, not a wrapped
  descriptor. Malformed `-t` is status 2 participating in `[[ !/&&/|| ]]` only.
- Review repair preserves malformed `-t` status when fd 2 is closed. Only
  unavailable diagnostic descriptors are ignored for this operand error;
  cancellation, write limits, broken pipes and unrelated predicate errors keep
  their existing statuses. Native closed-stderr tests cover all three forms,
  negation and short circuiting. The browser regression adds a separately
  transported child with both pipe ends, exact diagnostics, payload/EOF and
  retirement assertions. At `7096f08`, repair checks passed 265 native library and 548 word
  tests, Clippy, WASI target type checking, all 34 layer tests and strict quality
  checks without policy/baseline changes. Current-head runtime/browser CI and
  exact-head re-review remain pending.
- Negation review repair keeps direct and grouped forms distinct. GNU Bash
  5.3.15 returns 2/0/2 for two/three/four direct `!` operators on malformed
  `-t`, but 1 for `[[ ! ( ! -t nope ) ]]`. Consecutive negations now toggle
  one inversion, stopping at group and logical boundaries. Every frame still
  receives its depth/storage admission and work/cancellation checkpoint;
  unrelated predicate errors remain errors. Separate native regressions cover
  direct/grouped forms, valid statuses, short circuiting and open/closed stderr.
  The actual transported-child browser regression retains exact diagnostics,
  payload/EOF and retirement checks and adds both forms with open/closed stderr.
  The focused gate passes 7 native library and 25 word tests, all 34 layer tests,
  strict TypeScript, lint and formatting. WASI/browser execution and exact-head
  re-review for this negation repair remain pending required CI and review.
- Native engine regressions cover local pipes, private physical mock handles,
  non-consuming queries, writer release/EOF, integer diagnostics and unchanged
  unrelated capability errors. These mocks are not transported-WASI evidence.
- `tests/runtime-shell.spec.ts` and the raw `test-guest fd-kinds` mode exercise
  actual WASI child pipe ends/remaps, runtime terminals, files, directories,
  closed handles, payload and worker/pipe retirement. At `8238cf5`, all five new
  Chromium cases and 127 runtime/terminal host tests passed on UpCloud. The WASI
  build is from `afce126`, with identical production Rust/host code; `8238cf5`
  only extracted shared browser assertions to remove new duplicate clones.
- Required CI at `9a96117` passed layers, shell and quality, including 1,138
  native and 1,123 executed WASI tests. Frozen replay gained only
  `oils:builtin-bracket:319` and `oils:builtin-bracket:554`, reaching 951/955/1341
  with zero lost or newly failing cases. Raise only those two verified pass
  memberships; oracle, case, skip and exclusion identities stay unchanged.
- That historical browser run passed 222 cases with the exact 16 inherited
  skips, but two Firefox pipe fixtures exposed an unsupported line-ordering
  assumption: child stderr and downstream stdout interleaved as
  `WRITE_CLOSED:1PIPE_PAYLOAD`. The fixture now drains the actual output pipe to
  a file before displaying its bytes. It keeps every exact marker, both payloads,
  pipeline-status and EOF/worker/pipe-retirement checks, without substring
  matching, retries, longer deadlines or skips. Final-head CI remains pending.
- Also at `8238cf5`, 263 native library and 544 word tests, wasm32-wasip1 type
  checking, Clippy, Rust formatting, TypeScript checks, lint, formatting, unused
  code and both strict duplicate gates passed without baseline/exclusion changes.
  Independent review and normal required native/WASI/frozen/Chromium/Firefox CI
  remain the delivery gate. Older quiet-start/frozen runs are not this unit's
  qualification. Root is 0.0.57, engine 0.0.31 and the changed test guest 0.0.5
  after normal PR #21 integration; the already adopted Waffle pin is unchanged.

**Approved job-lifetime transition (2026-10-17).** The current runtime seals a
job when its pending membership reaches zero, before it is reaped. A shell job
can launch another command later in a loop or after a pipeline; joining that
sealed runtime job fails with ECHILD and shell status 127. Until creator-owned
job handles land, the small Rust `Runtime` group adapter starts one runtime job
per direct child and retains every job ID under the logical shell group. Group
kill closes admission before signaling every job; group wait confirms and reaps
all jobs, including descendants and members admitted while an earlier wait was
pending. Background groups remain separate from each other and the foreground.
The browser acceptance uses a supported background brace sequence: a short Bun
exits, a later persistent Bun starts, then `kill %1; wait %1` confirms cleanup
without executing the following command. The original fixture used unsupported
`for`/`if` syntax from the parked control-flow climb; restore that additional
loop-form acceptance there,
without treating this sequential-members gate as loop-compatibility evidence.
This fanout is not the final runtime job model. After slot recycling, add an
explicit creator hold that keeps a job open across temporarily empty membership:
job-empty/wait-job becomes true only after release and no remaining members,
and kill-job covers all current members. Then replace the contained adapter
fanout with one shell job to one runtime job handle, retaining the same dynamic
membership, cancellation, isolation and descendant-confirmation regressions.

**Approved foreground-completion follow-up (2026-10-18).** Implement with the
runtime's inherited-job delivery, after this structured-control-flow unit and
before accepting 7b foreground lifetime behavior. Waffle's `runtime_proc.job_of(0)`
returns the calling program's job; Bun's non-detached `Bun.spawn` descendants
will inherit it. The shell must not confuse that whole job's lifetime with the
completion of the foreground command it launched.

- Current affected paths: `shell/engine/src/runtime.rs:Runtime::wait_group`
  (currently lines 852–929, especially `wait_job` / poll kind 4 at 905–914),
  `shell/engine/src/process.rs:ProcessGroup::finish`, and interpreter job records
  used by `wait`, `jobs` and `kill`. Today natural finish waits for every member,
  including grandchildren. Keep that stronger drain for explicit termination,
  cancellation and shutdown; do not simply weaken all `wait_group` calls.
- Natural foreground completion waits for the shell's own spawned pids (all
  direct pipeline stages and shell-owned execution tasks), preserves their
  existing status/pipefail rules, and returns the prompt without waiting for a
  still-running grandchild. Transfer residual job handles to runtime-owned
  lifecycle/reaping instead of dropping or implicitly killing them.
- Retain a bounded reachable group handle until runtime membership is empty.
  `kill_job` must still signal lingering members after their direct parent exits;
  Ctrl+C while the command is foreground reaches the entire inherited group.
  Do not attach a completed foreground command's residual descendants to an
  unrelated later foreground job. Runtime owns their eventual reaping.
- `wait PID`, `wait %job` and no-argument `wait` observe shell-known direct
  children/jobs, not adopted grandchildren; preserve remembered direct-child
  statuses and the current no-argument status rule. `jobs` marks an explicit
  background shell job Done when its shell-owned processes finish, not Running
  solely for a lingering descendant; naturally completed foreground work does
  not become a new `%job`. Keep the residual runtime cleanup/signal handle
  separate from visible job membership. Confirm one-shot Done reporting and
  numeric/percent kill reachability against Bash before finalizing that API.
- GNU Bash 5.3 oracle: `sh -c 'sleep 2 & exit 0'; echo done` prints `done` and
  returns status 0 immediately, before the two-second sleep exits. Observe the
  line and direct-shell exit rather than waiting for pipe EOF: the grandchild
  may inherit stdout. Pair this with a background direct-child `wait`/`jobs`
  case and a group-signal case. A test supervisor owns and reaps every descendant.
- Acceptance must exercise real inherited Bun children through the shared
  process service, not only stand-ins: parent exits while child remains live,
  prompt readiness precedes child exit, residual group kill works, foreground
  Ctrl+C drains descendants, background/foreground groups remain isolated, and
  cancellation/shutdown leaves no processes, descriptors, job holds or pumps.
  Retain native/WASI ProcessHost controls and add runtime/browser regressions.

**Delivery split (2026-10-18, Approved).** Land the shell-side lifetime rule
with injectable-ABI runtime controls before the dependency delivery. Its native
and WASI controls must prove direct-child completion, independent residual
reaping/signaling, direct-child wait/status and background Done semantics, and
full cancellation/shutdown drains. Real inherited-Bun browser acceptance remains
**pending** on Waffle's `runtime_proc.job_of(0)` delivery and bun-wasm's 7b
package using that inherited job for non-detached `Bun.spawn` children. The
browser-port harness owns those real-program cases once both packages land;
stand-ins do not close that gate. This pending dependency does not block merging
the independently reviewed shell-side unit or continuing to functions/locals.

Runtime delivery order after its package split is slot recycling and creator-held
job handles, then 7b (including the foreground-completion follow-up), then asynchronous filesystem requests. The current PR does
not implement substitute cross-transport job fencing or a blocking filesystem
fallback.

2. **Scoreboard.** Add the new shell as an engine in `scripts/bash-compat.mjs`, run all three corpora, commit the fixed GNU bash observations and baseline, and wire the exact-count comparison into CI. Target-branch baseline comparison must prevent lowering the candidate baseline from concealing a regression. Expect a low first score; the point is the number. This step can use tested native/WASI process-host stand-ins. The first fixed baseline is 288/1,682 Oils, 295/1,888 Brush-suite and 445/2,222 Bashkit-suite; two fresh GNU bash nondeterminism exclusions reduce the secondary denominators. Exact category counts and case outcomes are committed in `docs/evidence/own-shell-baseline.json`. The historical Brush targets above use their earlier case sets and must be rescored under the same fixed identity before comparison. Candidate baselines must match current per-case pass membership, including gains, while target-branch comparison enforces corpus nonregression.

3. **Climb the bash rules,** in roughly this order, because later areas build on earlier ones. Each area is one or more PRs, each with its score delta:
   1. Words: quoting, parameter expansion, word splitting, pathname expansion, tilde and brace expansion. The fixed case/oracle/environment identity is unchanged across these slices, with no lost passing cases:
      - Quote-aware fields, IFS, empty/positional fields and scalar declaration contexts (#16): Oils 288→291, Brush-suite 295→304, Bashkit-suite 445→452.
      - Lazy scalar default/alternative operators and owned-parser quote fixes (#17): Oils 291→305, Brush-suite 304→322, Bashkit-suite 452→479.
      - Scalar assignment/error operators, durable side effects, fatal-error isolation, source-aware diagnostics and post-expansion IFS splitting (#18): Oils 305→314, Brush-suite 322→328, Bashkit-suite 479→492. Diagnostic descriptor ownership ends before dispatch so early consumer closes still deliver EPIPE. Clean startup sets nonexported IFS once; typed lexical metadata retains individual escaped-character protection through deferred splitting.
      - Scalar length for ordinary names, positive positions, status and positional count (#20): Oils 314→322, Brush-suite 328→332, Bashkit-suite 492→505. UTF-8 locales count Unicode scalar values; C/POSIX and unrecognized locales count bytes. Input snapshots, decimal output and counting share the existing bounds and cancellation budget.
      - Scalar prefix/suffix pattern removal with bounded cooperative matching (#21): Oils 322→340, Brush-suite 332→333, Bashkit-suite 505→528. Shortest/longest scalar trims preserve inner pattern quotes, outer result protection and final-IFS effects; matcher exhaustion fails explicitly without partial results or candidate-string allocation.
      - Scalar case modification with ordinary identifiers and `^`, `^^`, `,`, `,,` (#23): Oils 340→345, Brush-suite 333→334, Bashkit-suite 528→539. C/POSIX ASCII and C.UTF-8/C.utf8 Latin-1 input mappings reuse bounded single-character pattern matching; full Unicode and locale collation remain deferred. Matcher and mapping capacities are admitted before allocation, with shared work bounds and cancellation.
      - Scalar one-level indirection on ordinary names (`${!v}` and the eight scalar conditional operators) (#24): Oils 345→350, Brush-suite 334→335, Bashkit-suite 539→548. Pointer and target snapshots are bounded before copying; invalid pointers fail with fatal status 1, while valid unset targets remain distinct. Arrays, namerefs, special names and generic indirect suffixes remain deferred. Bare `${!p}` to positional and special targets (`1`, `10`, `#`, `?`, `$`, `!`, `-`, `@`, `*`) reuses the direct-read and positional-list adapters; operators, nested operands, patterns and array targets on those targets stay unsupported.
      - Scalar replacement on ordinary names (`${v/p/r}`, `${v//p/r}`, `${v/#p/r}`, `${v/%p/r}`) (#25): Oils 350→379, Brush-suite 335→338, Bashkit-suite 548→584. Leftmost-longest basic-pattern search, lazy operands, typed ampersand protection, final-IFS behavior and shared raw/storage/work/field bounds are preserved; arrays, namerefs, options, locale collation and unsupported pattern forms remain deferred.
      - Scalar arithmetic, positional/scalar slices, readonly writes and read-unit error recovery (#28): Oils 380→481, Brush-suite 340→384, Bashkit-suite 595→754, with no lost cases. Boxed arithmetic futures and explicit scalar depth bounds retain native/WASI stack safety; staged shell-boundary checks preserve Bash error status before lazy evaluation.
      - Brace lists and numeric/ASCII-letter ranges (#29): Oils 481→525, Brush-suite 384→394, Bashkit-suite 754→785, with no lost cases; brace generator seeds 1/42 match Bash on 5,318 cases each. Fused `$((`/`<((` spans end by raw parenthesis matching and are classified by `chk_arithsub`; other substitution bodies (also inside `${…}` operands and raw `$((` text) are parsed with the script and fail with status 127, strictly separated. Nested parses run after each word's scan loop (debug stack per nesting level ~21 KB→~7 KB). Brace temporaries are charged by peak storage; the default argument count is 65,536. Follow-ups owned by later units: running `UnparsedCommandSubstitution` (a non-arithmetic `$((` whose text fails to parse) at expansion with status 2 belongs to command substitution; prefix assignments on function calls (`TEMP=x f`) remain unsupported and belong to functions/locals.
      - Ordinary argv pathname expansion, `nullglob` and `set -f` (#54, historical replay at `43f1f7d`): Oils 1099→1101, Brush-suite 1080→1087, Bashkit-suite 1469→1476, with no lost cases. Only fields with an unquoted `*`, `?` or `[` keep a quote mask, and components needing more characters than any path, or paths over 4096 bytes (a trailing slash aside), match nothing; scalar assignments and redirects stay scalar. Normal main integration adds five recorded indexed compound caller controls, including `a=(*)`, long no-match operands and the exact directory boundary. The current-head frozen replay and gain membership update remain pending. Receipt: [own-shell-pathname.json](../docs/evidence/own-shell-pathname.json).
      - Remaining parameter operators, pathname, tilde and brace expansion follow before command substitution. After scalar arithmetic, the next focused word unit is bounded brace lists and numeric/ASCII-letter ranges, preserving quoted punctuation and opaque expansion parts; tilde stays separate. The pinned reference is Bashkit's `crates/bashkit/src/interpreter/brace_expansion.rs`, but resource exhaustion must fail explicitly rather than silently return a literal or partial result.
   2. Command substitution and arithmetic. Scalar arithmetic is the next foundation rather than a constant-only substring implementation: offsets and lengths are arithmetic expressions, so the same bounded evaluator serves `$((...))`, `((...))`, `let` and scalar slices. Command substitution follows separately and must use bounded captures without changing streaming command execution.
   3. Control flow: `if`, `for`, `while`, `until`, `case`, `[[ ]]`, `test`, `&&`/`||`, `!`, `set -e` and its exceptions.
   4. Functions, `local`, positional parameters, `return`, `shift`, `set --`. Ordinary function calls share the caller's state. Asynchronous lists and subshell environments get an isolated copy, and so do pipeline stages, except the last stage under bash's `lastpipe` rules. Local, positional and trap frames unwind correctly when a task is cancelled. (The spike caught a wrong copy once.)
      - **Approved delivery (2026-10-18), merged in [PR #6](https://github.com/ShaulLavo/bash-web/pull/6); post-merge browser repair pending.** Builtins own argument/status semantics; state owns dynamic binding restoration and positional mutation; call dispatch owns temporary exported prefix bindings, call-policy admission and execution-task lifetime. Preserve unset versus empty values and existing scalar attributes. Exercise nested parked calls, dropped command/session ownership, cancellation/shutdown and background-peer isolation, not only normal returns. Keep the existing executor task boundary and admit all retained per-call payloads before replacing the accidental low recursion ceilings; the 512-call native/WASI acceptance and explicit FUNCNEST-style policy below remain required. Add a deterministic GNU Bash 5.3.15 function-family oracle/replay gate without changing prior fixtures, and merge only with zero lost fixed-corpus cases. Broader array and trap features stay in their later units.
      - **Functions delivery evidence (2026-10-18).** PR #6 merged as `760a865916d6cfa6fdb5d8a6a51ac414511eea54` after independent exact-source review and all six GitHub checks, including browser acceptance. Native and release-WASI matched all 652 strict functions observations; all nine families passed without changing previous fixtures. Frozen scores ratcheted to Oils 944/1682 (+25), Brush 951/1888 (+22), Bashkit 1324/2222 (+39), with zero lost cases. Actual Chromium and Firefox each passed 61 runnable cases with 15 explicit pending cases, including the newly activated `command` external-guest case. The post-merge main run then exposed a fixture marker framing failure (`READER_WAITINGWRITTEN:0` instead of two whole lines); the separately reviewed [PR #9](https://github.com/ShaulLavo/bash-web/pull/9) merged as `e2d777bb5657506557f763d29ce5a0027e7e8e4b` with all six checks green and no repeated marker interleaving. Its full browser run passed 122 cases with 30 explicit pending cases; 29 of 30 extra interruption/backpressure repetitions passed, while one Firefox attempt failed during page startup before issuing any command. That startup defect has a separate investigation and is not a marker-test exemption. Delivery remains open until actual main CI is green and final cleanup is verified. Small reproduction, stack, review and verification evidence is retained in `/work/reports/bash-web/pr-6-functions`.
      - **Approved lookup prerequisite (2026-10-18).** Browser-port acceptance found that `command foo` tries to spawn an executable named `command`, because the builtin is missing. Include function-bypassing dispatch and GNU Bash 5.3.15 `command -v`/`-V` observations in this functions unit. Ordinary function calls still use dynamic scope; bypassing lookup must not create a function frame.
      - **Approved PATH-search prerequisite (2026-10-18), immediately after functions and before printf.** Waffle's process service admits canonical executable paths but deliberately does not search `PATH`; browser acceptance exposed the shell passing a bare `argv[0]` unchanged. In the shell's process-host boundary, search the request environment's `PATH` only for names without a slash, treating empty components as the request cwd. Use the same lookup contract for execution and `command -v`/`-V` (and later `type`), keep slash-containing names out of PATH search, and preserve Bash status 127 for missing commands versus 126 for found non-runnable candidates. Capture independent GNU Bash 5.3.15 search/precedence/diagnostic controls and keep all fixed-corpus losses at zero; hash caching remains later work. Preview1 filestat has no executable mode bits, so never assume `executable=None` means runnable or spawn probes. Require Waffle PR #10's actual merged runtime-owned X_OK query: copied path/captured cwd submission, nonblocking take/cancel and process-poll completion, sharing registration/live-regular-file admission and canonicalization with spawn without loading a module. A stalled query must preserve background progress, cancellation, late-result cleanup and bounded request ownership. Root coordination routes this asynchronous access contract into #10; do not build against an unmerged head or add version-skew fallbacks.
      - **PATH-search delivery (2026-10-18).** Shell execution and `command -v`/`-V` now share bounded asynchronous X_OK lookup against Waffle 0.0.27 at `ba968a6`. Slash names bypass PATH; empty/relative components use cwd. The selected executable stays separate from the invoked `argv[0]`, and temporary PATH assignments follow effective nameref bindings. Access requests retain cancellation-safe ownership and readiness without spawning probes. Resolver string allocations are admitted against local live PATH storage and shared session execution memory before copying; dropped temporaries refund their tickets while retained results stay charged. Every operand in one query shares a single PATH scan-work allowance. Failing-first controls cover global admission, pending cancellation/refunds, exact candidate/fallback storage boundaries and query-wide work. A single validated, size-limited manifest provisions the real Bash and simulated native/WASI fixture trees. The original standalone filesystem adapter preserves the frozen sandbox's read-only `/usr` mount without freezing cwd/tmp or the caller-owned browser filesystem. All 568 frozen PATH observations match independent GNU Bash 5.3.15 controls and native/WASI release execution, with no changed case records. Real Chromium and Firefox each pass 74 active cases with eight inherited skips; all six PATH/runtime cases are active, printf stays active, and PID remains pending. Directory-only PATH search returns Bash's 127; explicit directory execution remains 126. See `sources.lock.json:shellPathSearch` and `docs/browser-runtime.md` for scope and evidence inventory. Fixed-corpus replay gains 15 cases with zero lost passes under the unchanged case/oracle/environment identity: Oils 949/1,682 unchanged, Brush-suite 953→955/1,888, Bashkit-suite 1,328→1,341/2,222. The source baseline records exact membership, and the gate rejects every lost passing case even when gains in the same corpus keep the total level or higher. Failing-first controls cover both concealed-loss forms. A retrospective comparison of actual-parent/actual-merge CI artifacts for PRs #4, #5, #6, #9 and #8 found zero lost passes under the unchanged 9,221-case identity; no old builds were rerun. Final landing still requires independent review and green CI.
      - **Approved immediate follow-up (2026-10-18).** After the functions and PATH-search PRs, ship full Bash `printf` escapes as the next separately reviewed PR, before descriptor-target overflow. Browser acceptance found `printf '\\000\\377'` returns status 2: `shell/engine/src/builtins.rs` currently accepts only newline, carriage return, tab and backslash escapes. Capture Bash format octal `\\NNN`/`\\0NNN`, `\\xHH`, `\\a\\b\\e\\f\\v`, `\\c`, and `%b`'s distinct escape rules; compare raw output bytes and status, including NUL/high bytes, malformed/incomplete escapes, repeated formats and stop-output behavior. Do not weaken browser acceptance while this prerequisite is pending.
      - **Approved process-identity unit (2026-10-18), immediately after printf and before descriptor-target overflow.** Browser acceptance found `$$` and `BASHPID` unsupported: `State::parameter` has no PID state and its only dynamic scalar hook is `EPOCHREALTIME`. Waffle `proc/abi.ts` at `c458a48` supplies caller PID to `ProcessABIOptions` but exposes no self/getpid import; `job_of(0)` returns a job, not a PID. The runtime prerequisite is `runtime_proc.getpid: () -> i32`, returning the adapter's actual positive `options.pid`, with matching stub/tests/docs; no new broker or `ProcessService` method is needed. It is routed through [Waffle PR #10](https://github.com/ShaulLavo/waffle/pull/10); build this unit against that PR's actual merge commit once it lands, not an unmerged branch or a compatibility fallback. Bind that import in the shell runtime and inject process identity through the host/session boundary; native hosts use their actual process ID, while stand-ins supply explicit deterministic identities instead of guessing. Keep `$$` as the shell's root PID across isolated task snapshots, and report the actual hosting-process PID for `BASHPID`. **Execution-model decision:** our subshells, command substitutions, pipeline stages and asynchronous shell lists run as tasks within that same process, so their `BASHPID` remains the same actual PID; do not invent signalable process IDs. A genuinely spawned runtime shell has its own actual PID. This differs from Bash's forked subprocess `BASHPID`; record the difference against oracle cases rather than normalizing it away. Capture Bash parent/function/subshell/comsub/pipeline/async observations, verify same-process versus true-child identity explicitly, preserve `$!`, numeric formatting/admission, parameter set/unset/assignment rules, cancellation and peer isolation, and retain the fixed-corpus zero-loss gate. Browser PID acceptance remains pending this unit and its Waffle prerequisite.
   5. Redirects and here-docs, including `exec` descriptor changes.
   6. State-changing builtins: `cd`, `pwd`, `export`, `unset`, `declare`/`typeset`, `readonly`, `read`, `mapfile`, `printf`, `echo`, `eval`, `source`, `type`, `command`, `getopts`, `shopt`, `set`.
      - Resolved in engine 0.0.13: `printf` repeats consuming formats until arguments run out and emits non-consuming formats once. Direct and split-field regressions cover the behavior, and the parameter fuzzer now captures fields with the repeating format instead of its temporary `argv.py` helpers.
      - **Approved printf escape delivery (2026-10-18), final qualification.** Prepared on a fresh main branch while functions PR #6 was under review and PATH search waited for Waffle #10; rebased onto actual functions merge `760a865916d6cfa6fdb5d8a6a51ac414511eea54` before final verification. PATH search takes delivery priority as soon as its runtime prerequisite merges. The first 107 independent GNU Bash 5.3.15 observations passed 4/107 on the pre-repair functions CLI, not an original-base binary. Preserve these captures and add a strict byte-exact family for format versus `%b` octal/hex/control/Unicode escapes, malformed/incomplete/unknown/trailing escapes, NUL/high bytes, repetition and `%b` stop-output behavior. Default observations use locale C; explicit C.UTF-8 and locale-precedence controls pin supported Unicode differences rather than normalizing them. Original scanning/delivery must admit work and output before writes, use bounded borrowed/fixed-size pieces instead of a whole-output allocation or lossy UTF-8 conversion, preserve ordinary Bash diagnostics/partial output, and recover after resource rejection or cancellation. Merge only after native/WASI tests, all prior families, a zero-mismatch new family, unchanged-oracle fixed-corpus loss zero, independent exact-SHA review and required CI. Unrelated printf flags/conversions remain later builtin work.
      - **Printf qualification and atomic-write repair (2026-10-18), approved and executing in [PR #8](https://github.com/ShaulLavo/bash-web/pull/8).** The initial integrated native/WASI run passed all ten strict families, including 1,122 exact printf observations, and the unchanged frozen corpus gained five Oils, two Brush and four Bashkit cases with zero losses: 949/1682, 953/1888 and 1328/2222. The candidate ratchet records those exact pass memberships; oracle, environment, source and exclusion identities remain unchanged. Browser exact-byte assertions passed in both engines, but concurrent shell readiness messages exposed split printf writes, so that source approval is superseded pending an atomic-write repair. Coalesce decoded output in a fixed 4,096-byte buffer: a small invocation must remain one pipe write; larger output flushes bounded chunks. Internal pipe writes up to `PIPE_BUF` must wait for enough capacity rather than partially committing a record. Add deterministic write-boundary and competing-writer controls under backpressure, preserve cancellation and diagnostic/error-prefix semantics, and requalify native/WASI, strict byte observations, fixed-corpus loss zero and both real browsers before merge. Check the pinned Waffle cross-process/SAB pipes under the same small-write rule and route any runtime defect to its owning unit. The fixture-only marker repair in PR #9 is not evidence that printf atomicity is fixed.
      - **Printf frame-memory qualification (2026-10-18).** A controlled prebuffer-versus-inline comparison using Rust 1.98.1 default-debug libtest builds found no growth on either platform: native dispatch/admitted allocation 12,168/12,192 bytes; WASI 10,400/10,416 bytes. Ordinary 512-call admitted peaks stayed 18,349,425 bytes native and 12,785,465 bytes WASI; completed-eval peaks stayed 18,341,833 and 12,790,569 bytes. Poll/drop stack spans and all released tickets were unchanged. The minimum successful execution budget for each of `true`, `echo ok` and `printf ok` stayed 14,368 bytes native and 11,632 bytes WASI; all passed at 16 KiB. These are admitted live-execution bytes, not process RSS. Keep the inline printf buffer because the enclosing future already reserves larger builtin state and `Scope::frame` charges its complete allocation before boxing; another ticket would double-charge it. Same-headroom `true`/`echo` rejection/recovery controls test total frame admission and refunds, not isolated printf-buffer cost. Independent focused native and WASI runs each pass two private and 21 integration controls. Evidence: `/work/tmp/bash-web-printf-20261018/frame-measure-oyUEwe/results.json` and `nonprintf-headroom.log`.
      - **Approved shared builtin-frame performance follow-up (2026-10-18), separate from PR #8.** Every simple command currently pays for the largest inline builtin future; `builtins::copy` holds an 8,192-byte buffer (`shell/engine/src/builtins.rs:123–125`), `Scan::input` holds another 8,192-byte buffer (`shell/engine/src/builtins/grep.rs:250–251`), and printf holds 4,096 bytes (`shell/engine/src/builtins/printf.rs`). Measure dispatch `size_of_val` with each buffer independently moved out and with all three moved out, then move the bounded buffers that determine the shared maximum to heap storage allocated only while their builtin runs, admitting each allocation before construction through its own execution-memory ticket. Include copy and printf in the optimization, and grep if it otherwise preserves the shared maximum. Do not introduce whole-output allocations or duplicate the inline-frame charge. Measure the actual dispatch/admitted allocation and the existing real 1/32/128/512-call ordinary/completed-eval controls (`shell/engine/src/interpreter.rs`, `function_tasks_measure_512_real_calls_without_growing_poll_or_drop_stacks`) before and after on native and WASI; run that control with `cargo +1.98.1 test --locked --manifest-path shell/Cargo.toml -p shell-engine function_tasks_measure_512_real_calls_without_growing_poll_or_drop_stacks -- --nocapture`, adding `--target wasm32-wasip1` before the test filter for WASI. Preserve low-limit `true`/`echo`/printf behavior or document the measured improvement, verify error/cancellation/peer/refund ownership, and keep all fixed-corpus losses at zero. The no-regression printf repair need not wait for this separate optimization.
      - **Approved declaration/attribute oracle follow-up (2026-10-18).** The first functions-generator draft captured 292 GNU Bash 5.3.15 observations per seed, but included later-unit prerequisites: `declare -p` formatting, bare `local` listing, integer attributes and `+=`, and `local -I` inheritance. Native candidate's first replay passed 246/292 at seed 1 and 247/292 at seed 42; these were not core prefix failures. The strict functions generator intentionally removes its three integer/inherit fixed variants and replaces 16 declaration-inspection bodies with supported value/readonly/export consequences, then recaptures under a new identity with no exclusions. Keep broader local redeclaration/assignment-status/export and prefix export/integer/readonly-inner/export-unset declaration printing observations for this unit; add its own strict family when implementing those prerequisites. Original draft capture/source identities are retained as review evidence, not a red subset or exemption in the shipped functions gate.
   7. Arrays, associative arrays and namerefs.
   8. Traps (`EXIT`, `ERR`, `DEBUG`, `RETURN`, signals) and aliases.
   9. Process substitution `<(…)` `>(…)` and coprocesses, as live descriptors, never captured text.
   10. Job control builtins: `jobs`, `fg`, `bg`, `wait`, `kill`, `disown`.
       - **Approved follow-up, GNU Bash 5.3.15 observations (2026-10-18).**
         Keep the inherited-foreground lifetime PR narrow; implement these observation
         and selector rules in this job-builtins unit. Against native head `55e5a16`,
         `block() { while :; do :; done; }; block & jobs | while IFS= read -r line; do printf '%s\n' "$line"; done; kill %1; wait %1`
         prints a Running row in Bash but none in the engine (both final statuses 143).
         Direct `jobs | cat` and `command jobs | cat` inherit the parent's observation;
         ordinary `(jobs)`, `{ jobs; } | cat`, a function stage, `builtin jobs | cat`
         and `eval jobs | cat` do not. Command substitutions inherit observations:
         `x=$(jobs)`, `x=$(jobs; :)` and `x=$(show)` with `show() { jobs; }` print
         parent rows in Bash, unlike the current engine. Parent function calls already
         see the live table. Add detached observer records, not join/cancel/group authority.
       - Captured observations are frozen: a Running row stays Running inside the
         observer after the real job exits, while the parent later reports Done.
         Completed-unreported rows display once per observer; local retirement must
         not retire the parent's row. Already-waited/notified or parent-retired rows
         do not display. Preserve job numbers and +/- markers, including local async
         numbering after inherited jobs. Oracle rows include `[1]+  Exit 1                     false`
         and mixed `[1]-  Running                    block &` / `[2]+  Exit 1                     false`.
       - Broader selectors remain separate from observation: command-substitution
         `kill -0 %1` succeeds while its ordinary-subshell equivalent fails;
         command-substitution `wait %1` returns 255 versus 127 in an ordinary subshell.
         Test with a live parent `block &`, and always kill/wait that owned child.
         `jobs >&-` returns 0 in Bash even with running/completed rows and retires a
         completed row; the lifetime PR fixes only the confirmed empty/no-emission
         eager-stdout defect. Cover actual-output closed stdout here. All probes
         were bounded, process-group supervised and cleaned; no fixture is retained.

4. **Utilities.** Commands that don't change shell state are separate WASI programs started through the process host, starting with a uutils multicall binary plus `grep`, `sed`, `awk` and `jq`. Measure spawn cost per command (brush-web measured about 18 ms per warm child). Where loops make it hurt, add in-process versions of the hottest tools (`cat`, `head`, `tr`, `wc`, `grep`) as tasks on the engine's streaming descriptors. The "cases needing external commands" rows of `npm run compat` track this.

5. **Interactive session.** Prompt, completion requests from the terminal, history, Ctrl+C and Ctrl+Z at the prompt, `$?` carried between commands, `exit`. The terminal owns line editing.

6. **Replace Brush.** When the new shell beats Brush on all three corpora, passes every acceptance test and guardrail, and runs on a live shared filesystem (plan 001 step 2, or equivalent demonstrated coherence: running children see editor and shell writes, and sibling processes see each other's writes, before anyone exits), make it the workbench's default shell. Brush stays selectable for comparison until Bashkit's held-out scores are also passed.

## Out of scope here

The runtime itself (plan 001 step 2 and `handoff-runtime.md`), the terminal choice, the product's look and its repository.

## Follow-up: IFS snapshot storage admission

Status: Approved. Complete this with the post-substitution ANSI-C guard follow-up
below, before adding more allocation paths; the deferred full cursor is not a
prerequisite. This was found during arithmetic review and predates that PR.

`Ifs::new` in `shell/engine/src/expand.rs` copies the IFS string and inserts
characters into a `BTreeSet` without calling `Work::admit_storage`. It checks
`max_raw` before the string copy and checkpoints character work, but those checks
do not reserve temporary storage. The same implementation is present on main
`2342019`; inspect it with
`git show 2342019:shell/engine/src/expand.rs` around `impl Ifs`.
At arithmetic head `49b255a`, the function starts at line 250. This is a
source-confirmed accounting gap; the allocation-boundary test below has not yet
been added or run. No crash, corpus regression, or timing claim is implied.

Start with a private `expand::tests` test that creates default shared state,
sets IFS to `:`, creates `Work::new(64, 0, 1)` and `Cancel::new()`, then calls
`Ifs::new(&state, &cancel, 64, &mut work).now_or_never()`. Under the current code
this path copies the string and inserts the delimiter without checking the zero
storage allowance. Assert explicit status 2 at that boundary, then cover exact
admission, duplicate characters, empty/default IFS, large IFS, and cancellation.
Run the focused test through the shared queue with the pinned Rust toolchain.

Fix the representation and admission together. Preserve tiny expansion budgets
for default IFS and literal or protected words; blindly charging heap nodes on
every word can reject cases that need no owned IFS storage. Keep literal
protection, final-IFS updates, list separators, and Unicode delimiter semantics.
Run all native/WASI word tests, regenerate word fixtures 1/42 independently and
diff byte-for-byte, and require zero lost fixed-corpus cases. Own and clean any
task-created targets and scratch under the usual lane rules.

## Follow-up: admit every isolated shell-state snapshot

Status: Approved. This is a bounded, pre-existing engine follow-up outside the
current command/process-substitution critical path. Carry it with this plan in
the approved repository extraction below; do not reopen the substitution unit or
fold a broad execution/AST ownership rewrite into it.

**Evidence (source-confirmed, not executed):** inspected the `climb/subst-gen`
working tree based on `3fb4fab8ae707141b0f948a352558ba5c2439fe0`, including the
current substitution edits, on 2026-10-17. These three remaining
`state.borrow().clone().shared()` calls bypass `Work::admit_storage` and
cooperative checkpoints:

- `shell/engine/src/interpreter.rs:656`, `execute`'s multi-stage pipeline path;
  the loop makes one copy per stage before awaiting `join_all`.
- `shell/engine/src/interpreter.rs:1022`, `subshell`, before spawning its task;
  its redirect-expansion `Work` is created later at line 1032.
- `shell/engine/src/interpreter.rs:1130`, synchronous `background`, called by
  `list_command` at line 1072.

`State` still derives `Clone` (`shell/engine/src/state.rs:24`). Function bodies
now use `Rc<Command>` (line 32), avoiding recursive function-AST copies, but
variables, binding names, exported/readonly sets, positionals, cwd/shell name,
pipeline statuses and saved local/prefix values still copy eagerly. There is no
aggregate retained-state limit: `Limits::expansion_bytes` is command-wide
(`interpreter.rs:25`), preparation creates fresh work for each simple command
(line 1489), and assignment checks at lines 1767/1790 cover the current command's
bytes, not previously retained bindings. `Session::start` retains the same state
across submissions (lines 349–375); public `Session::state` (line 331) also allows
host-injected state. Pipeline/job count limits do not bound bytes per copy.

**Deterministic reproduction to add, not yet run:** use the existing native
`Rig` in `shell/engine/tests/words.rs`, with default limits and a single session:

```rust
let rig = Rig::new(Limits::default());
let seed = "x".repeat(16 * 1024);
assert_eq!(rig.run(&format!("seed='{seed}'")), 0);
for index in 0..96 {
    assert_eq!(rig.run(&format!("v{index}=$seed")), 0);
}
for source in ["( : )", ": | : | :", ": & wait"] {
    assert_eq!(rig.run(source), 0);
}
```

Each submission is below the source/command limits, but 97 retained payloads
alone occupy 1,589,248 bytes, above the default 1 MiB expansion allowance. The
three fork forms are predicted to copy that state successfully without emitting
it; the pipeline makes three copies without a checkpoint inside the setup loop.
This is not an observed failure, crash, cancellation latency measurement or
corpus regression. First add and execute the failing-first admission test; after
the repair require explicit status 2 before child dispatch, not the old status 0.
A separate smaller-state case must cover a pipeline whose individual snapshots
fit but whose combined snapshots exceed one command's allowance.

**Bounded implementation:** reuse `State::snapshot(&state, &cancel, &mut work)`
(`state.rs:75`), including its accounting for saved frames, collection metadata
and shared function bindings. Preserve the command/process-substitution snapshot
admission already in this unit. Subshell setup uses one work account for its
snapshot and redirections. Make background setup async and await it from its
caller; admit its snapshot before allocating a process group, registering a job
or spawning the body, using one work account for that background command. Use
one shared `Work` for all snapshots of a multi-stage pipeline, not a fresh
allowance per stage; the single-stage path retains the caller's shared state.
Prepare/admit all child states before spawning any stages, or explicitly cancel,
join and unwind every already-started task/descriptor/scope on a later setup
failure. Do not solve this by imposing an unrelated new global variable cap or
by cloning first and checking afterwards. Immutable shared AST payloads remain
separate from any admitted AST copies needed for execution.

**Gates:** focused native and WASI tests cover each fork form, metadata-only and
saved-frame admission, exact/over-budget storage, shared pipeline accounting,
ordinary state isolation, and cancellation both before admission and during a
snapshot yield. Instrument the existing process-host fixture to require zero
partial dispatch on failed/cancelled setup; assert no leftover jobs, open pipe
ends or stranded tasks. Preserve background ownership and cancellation isolation,
`PIPESTATUS`/`pipefail`, redirect inheritance, and all command/process-substitution
regressions. Run the full native/WASI suites and fixed-corpus zero-loss ratchet
through the shared queue. Record the small reproduction/results and clean every
task-created target, process and scratch directory under the existing lane rules.

## Follow-up: Bash-scale function recursion on the WASI stack

Status: Approved; completed by [PR #6](https://github.com/ShaulLavo/bash-web/pull/6),
merged as `760a865916d6cfa6fdb5d8a6a51ac414511eea54`. The default
`Limits::function_depth` is now `usize::MAX`; explicit host/FUNCNEST policy and
the session-wide live-execution budget govern admission. Real native and WASI
ordinary/completed-eval calls entered and unwound depths 1, 32, 128 and 512.
Synchronous poll spans stayed constant at 29,552/68,648 bytes native and
13,428/43,332 bytes WASI; drop spans were 2,328/932 bytes. All retained tickets
returned to zero. The existing separate eval-reader guard was not reset.

Before this delivery, the inherited default `Limits::function_depth` was 128
(`shell/engine/src/interpreter.rs`), and the separate 256 execution-depth guard
in `shell/engine/src/interpreter/eval.rs` could reject compound function bodies
earlier. Those were compatibility limitations, not Bash-correct final limits:
Bash has no default function nesting limit.

**Observed evidence:** at `c090eb9`, CI [39048383922, native producer
117441646576](https://github.com/ShaulLavo/brush-web/actions/runs/39048383922/job/117441646576)
and a queued local debug reproduction abort with stack overflow in
`command::returned_evals_release_storage_before_later_function_calls`, which
configures only 32 calls. Reproduce with `cargo test --manifest-path
shell/Cargo.toml -j2 -p shell-engine --test words
command::returned_evals_release_storage_before_later_function_calls -- --exact`.
The substitution PR owns fixing this crash with small polling/drop frames and
unchanged limits; passing that bounded regression does not establish Bash-scale
recursion or make the inherited caps correct.

**Target:** at least 512 nested function calls must succeed under ordinary
configuration in native and WASI execution, without enlarging the WASI/native
stack or retaining large per-call frames. Include ordinary function bodies and
sequential completed eval readers. Measure actual admitted call depth and
per-level stack/frame cost. Replace accidental low nesting ceilings with an
explicit configurable FUNCNEST-style policy and bounded live-memory admission;
configured-depth or genuine admission exhaustion must produce a clear shell
error and leave the session usable, never crash or silently truncate execution.
Preserve cancellation, local/positional restoration, retained function/source
ownership, the separate parser/eval guards and peer-background isolation. Gate
accepted depth, one-beyond configured depth, cancellation and recovery on native
and WASI, then replay the fixed corpora with zero lost cases. Do not claim the
512-call target until those executions pass. This follow-up does not start the
parked control-flow or functions unit as part of the substitution PR.

## Next word unit: ANSI-C operands and two-phase parameter extraction

Status: Approved. Land command/process substitution first and restore the
control-flow checkpoint. Sequence the full ANSI-C cursor by measured fixed-corpus
yield as described below; low-yield work is approved for later, not dropped. Finish
the IFS storage-admission follow-up above before adding allocation paths.

Brace controls exposed an existing scalar-parameter bug, independent of braces.
The first reproduction is:

```bash
printf '<%s>\n' "${u:-$'\''}"
```

Confirmed with a fresh native release build of exact main
`5deb70ddcee9ec82e208168455a760f9544867a2`: GNU Bash 5.3.15 exits **1**
with no stdout; main exits **0**, stdout bytes `3c273e0a` (an apostrophe field).
The detached proof worktree and build output were removed after measurement.
The brace lane records the same evidence in the PR. These additional operand spellings exercise the same phase:

```bash
v=SET; printf '<%s>\n' "${v:-$'\''}"
printf '<%s>\n' "${u:-$'\x27'}"
printf '<%s>\n' "${u:-$'\x27\x27'}"
v=VALUE; printf '<%s>\n' "${u:-$'$v'}"
v=SET; printf '<%s>\n' "${v:-$'}'}"
printf '<%s>\n' "${u:-$'\x22'}"
```

Decoded apostrophes affect extraction even when the operand is unselected;
decoded `}` can end the parameter early, decoded `$` expands, and decoded
double quotes affect expansion-time quoting without becoming original shell
syntax. In contrast, unquoted ANSI-C operands retain literal protection.

**First step:** extend `scripts/fuzz-shell-words.mjs` to generate `$'…'` and
decoded specials (apostrophes, braces, dollars, double quotes, escapes, empty
text) in **every operator's operand**, both quoted and unquoted, selected and
unselected. Existing seeds 1/42 do not reach this phase. Run Bash self-controls
and failing-first comparisons before implementation; retain exact status and
stdout observations, including Bash failures. The complete implementation must
match these controls. While the cursor is deferred, explicitly diagnosed
unsupported shapes remain separately counted, never converted into passes or
blanket operator exemptions; Bash failures must also retain their exact oracle
status/stdout observations.

Implement general **two-phase parameter extraction**, not quote-specific
patches or raw decoded-text insertion into the outer shell grammar. Inspect
`shell/parser/src/parser/lexer.rs` (`read_parameter_body` and ANSI-C decoding),
`shell/parser/src/parser/parameter_scan.rs`, parameter extraction in
`shell/parser/src/parser/mod.rs`, and lazy operand decoding in
`shell/engine/src/expand/operand.rs`. Keep early shell-word syntax separate
from later extraction, preserve storage/work/raw admission and cancellation,
regenerate all affected fixtures with independent byte comparison, and run the
full native/WASI suites and per-case score ratchet before pushing.

### Two-phase design checkpoint (2026-10-17)

Status: Approved; the complete word-wide cursor is deferred, with no identified
direct fixed-corpus gains. Land command/process substitution first; only then
schedule the narrow typed guard below. Preserve these controls and the complete
design for later, and put the compatibility climb into control flow,
functions/`set --`, errexit and redirects. Before reopening the full cursor,
remeasure affected failures in the Oils, Brush and Bashkit lists. Do not preserve
silently incorrect output or mark unrelated ANSI-C quoting unsupported.

Fixed-corpus yield checked against `docs/evidence/own-shell-oracle.json` and the
matching `docs/evidence/own-shell-baseline.json` at brace PR #29, commit
`9b371d4dd098bca90590d9102dff3dd74ef95178`: all 9,221 scripts were screened;
43 contained both `$'` and `${` and were read individually. Only eight actual
ANSI-C-in-parameter-operand cases (11 occurrences) exist: one of 2,492 Oils cases,
one of 2,894 Brush cases and six of 3,835 Bashkit cases. **All eight already pass;
none covers the vulnerable double-quoted decoded quote/brace/dollar/backslash/NUL
shapes. At that checkpoint, zero of 4,088 failures was directly attributable to
this unit.** These are historical screening results, not newly measured gains.
Therefore defer the complete cursor. **Immediately after command substitution
lands, fold in a small, narrowly scoped status-2 `unsupported` guard for the
silently wrong outer-double-quoted decoded quote/brace/NUL shapes.** Preserve the
eight passing cases and protected quoting contexts, and show only Bash-successful
controls moving from `MISMATCH` to `UNSUPPORTED`, not to `MATCH`. If Bash errors,
a guard returning status 2 must remain `MISMATCH` against Bash's actual status and
stdout; never reclassify a Bash failure as unsupported or invent a successful
oracle result. This schedules future work, not an implemented guard or a claimed
score gain. The screening is direct source coverage, not a proof about arbitrary
text synthesized later with `eval`.

Preserve the passing case IDs: `oils:var-sub-quote:217`,
`brush-suite:word_expansion/params:53`,
`bashkit-suite:param-operand-quotes:43`,
`bashkit-suite:param-operand-quotes:113`, and
`bashkit-suite:var-op-test:252`, `:271`, `:280`, `:289`. They exercise protected
trim/replacement patterns, an unquoted default with `}`, and a quoted tab default;
a blanket ANSI-C-in-parameter rejection would lose useful supported behavior.
The older multi-engine `docs/evidence/bash-compatibility.json` is not the current
own-shell failing list. Reproduce the screening by joining oracle/baseline case
IDs, filtering scripts containing `$'` and `${`, then inspecting source context;
also check `$` plus escaped-newline before the apostrophe (the sole current case,
`brush-suite:line_continuation:4`, is top-level ANSI-C, not a parameter operand).

The existing lexer `read_parameter_body` decodes an ANSI-C island into a quoted,
NUL-protected string. The word parser then commits its operand boundary, and the
engine sees only a selected operand. Changing just that final operand cannot fix
this: a decoded close and quote can affect later text in the same original word.
GNU Bash 5.3.15 controls, checked on this host:

```bash
v=SET; X='a b'
printf '<%s>\n' "${v:-$'}\x22'}"$X
# One field: <SET}a b>
printf '<%s>\n' "${v:-$'}\x22'}""$X"
# Two fields: <SET}a> and <b>
printf '<%s>\n' "${v:-$'}\x22'}" $X
# Three fields: <SET}>, <a>, <b>. Original word boundaries stay fixed.
printf '<%s>\n' "${v:-$'}\x22'}"$'\x24X'
# One field: <SET}'a b'>. Generated quote recipes are not hard protection.
```

**Phase 1: original shell grammar.** Keep source word/command/redirection
boundaries authoritative. The lexer consumes each ANSI-C island by its original
spelling, never feeding decoded punctuation into the shell lexer or its source
boundary scanner. Retain original quote delimiters, source spans, ANSI-C islands
and original command-substitution descriptors in an expansion-source payload for
the complete affected word. Keep `Word.raw` unchanged for printing, braces and
diagnostics. Distinguish original syntax, genuinely protected literal escapes,
decoded data and generated quote events with typed provenance, not data bytes.
Original command bodies still receive eager shell-syntax validation. Dollars
created by decoding do not introduce new original-script syntax validation.

**Phase 2: word-wide expansion projection.** Use one shared cursor that projects
an ANSI-C island exactly once using its phase-1 quoting recipe. When execution
reaches `${`, extract its complete projected boundary before choosing the operand,
including nested projected parameters. Return the existing parameter operation
and bounded operand views, evaluate only selected operands, then resume the same
cursor immediately after the actual projected close. A decoded `}` may leave a
tail outside the parameter but inside the original word. Quoting of that tail and
later source text must follow the cursor, not precomputed per-part quote flags.
Unaffected words may retain the current parsed-parts fast path; the deferred
payload must be authoritative for affected words, never executed alongside stale
static parts. Keep existing protected segments and final IFS splitting downstream.

Extraction and selected-operand expansion share provenance and cursor positions,
not identical quote rules. Apostrophes can participate in boundary matching while
remaining literal during expansion of an outer-double-quoted default operand.
Operator disposition matters: `#`, `%`, `^`, `,` patterns and replacement pattern
and RHS preserve ANSI-C quoting; defaults and substring expressions project
active decoded syntax. Undocumented `~`/`~~` act like the latter, unlike `^`/`,`.

```bash
v=abc
printf '<%s>\n' "${v:-$'\x27'}" # status 1, no stdout, even unselected
printf '<%s>\n' "${v#$'\x27'}"  # <abc>, status 0
printf '<%s>\n' "${v/a/$'\x27'}" # <'bc>, status 0
printf '<%s>\n' "${v~$'\x27'}" # status 1, no stdout
```

The decoder must preserve an explicit NUL-termination outcome; its current empty
string result loses a distinction needed by extraction and by the remaining word:

```bash
v=SET
printf '<%s>\n' "${v:-$'\x00tail'}" # status 1, no stdout
printf '<%s>\n' "${v:-$'}\x00tail'}"AFTER # <SET>, status 0
v=abc; printf '<%s>\n' "${v#$'\x00'}" # <abc>, status 0
```

Malformed projected extraction fails when execution reaches that expansion, not
while parsing the script. Bash `-n` accepts these words, an unexecuted `if` branch
does not fail, and an earlier `printf 'BEFORE\n'` still prints before the error.
An executed outer `${v:-${u:-$'\x27'}}` fails even if `v=SET`: boundary extraction
precedes outer operand selection. Preserve source-order expansion side effects;
do not validate every deferred word/parameter in a script eagerly. Generated
`$v`, `${…}`, `$((…))` and `$()` may expand, but generated `$'…'` must not trigger
original ANSI-C decoding again. Decoded separators and redirects stay word data.

**Interim guard implementation:** carry one allocation-free typed feature bit
from the lexer through `SpannedToken` and parser current-token metadata into
`Word`. Set it while consuming original-source ANSI-C islands, using an explicit
`ParameterScan` query for active-double-quoted versus protected operand context.
The decoder classifies decoded apostrophe, double quote, `}`, backslash, dollar,
backtick and NUL before truncation; retain `had_decoded_nul`. Do not make this a
parse error or runtime source reparse. At `expand_one` entry, after the ordinary
work/cancellation checkpoint and before interpreting parts, return a typed static
unsupported-feature error rendered as status 2 with the normal source line. The
guard rejects an affected word atomically: earlier words have already expanded,
but earlier expansions inside the same rejected word do not run. This conservative
unsupported contract is distinct from the eventual exact side-effect semantics.

OR the bit when words are appended; preserve it in scalar assignment words and
bounded brace reparsing. Nested parameter flags accumulate into their containing
word even across lazy outer operands; opaque command-substitution bodies keep
independent execution scopes and must not poison their containing words.

Decoded-special detection alone is insufficient. Bash 5.3.15 prints `<B>` for
`v=A; vfoo=B; printf '<%s>\n' "${u:-$v$'foo'}"`: decoded `foo` can join an earlier
variable name without containing any structural special itself. Keep the only
unguarded active-default case a proven simple literal operand: literal text and
ANSI-C chunks, with no other expansion, quote or escape syntax and no decoded
specials. Fixed-capacity frame flags for active ANSI presence and other operand
syntax suffice to reject complicated active operands conservatively. Guard
active ANSI-C substring operands too: `v=abcdef; printf '<%s>\n' "${v:$'1:2'}"`
prints `<bc>` in Bash, so decoded arithmetic delimiters also matter. The existing
quoted tab default remains a supported simple literal; all other seven frozen
cases remain protected. Do not blanket-disable an operator or ANSI-C quoting.

Implementation points: the source/projection distinction and operator context
belong beside `ParameterScan` in `shell/parser/src/parser/parameter_scan.rs`;
`lexer.rs` retains source islands and decoder outcomes; `mod.rs` parameter-token
parsing accepts extracted typed views; `substring.rs` validates original command
bodies only; `shell/engine/src/expand/operand.rs` consumes projected views; the
word dispatcher in `shell/engine/src/expand.rs` selects the authoritative cursor
before static part iteration. Preserve the existing decoder's byte-run UTF-8,
unknown-escape and `\c` consumption behavior rather than extending the smaller
duplicate decoder in `parse_word`.

Both phases share work, storage, raw/output allowances and cancellation. Admit
piece vectors, decoded buffers, materialized tokens and diagnostics before
allocation, including extraction of unselected operands. Cursor clones copy
positions, not buffers; use admitted stable storage and span views to avoid
quadratic decoding/copying. Keep status 1 malformed extraction distinct from
status 2 resource/unsupported failures and status 130 cancellation. Verification
must include original corpus membership, operator/selection/quote matrices,
whole-word quote crossings, NUL termination, skipped branches, expansion-side
effects, token/depth limits, native/WASI suites and independent fixture replay.

## Current unit follow-up: preserve requested job signals

Status: Source acceptance passed at `e4202c7`; final evidence-head CI and merge
remain required. Found during runtime integration, not introduced by it:
`kill %1` took the Session cancellation path and sent SIGINT (2), although Bash
defaults to SIGTERM (15). The source now carries default TERM and explicit
named/numeric signal values through scoped job and process-substitution groups.
Native/WASI controls passed with wait statuses 143 for TERM and 130 for INT.
Both Bash 5.3.15 substitution seeds passed 3,142 controls each with zero
mismatches or unsupported cases. Invalid signals now return Bash status 1 before
mutation; known unsupported actions retain explicit status 2.

Reproduce against Bash 5.3.15 and the exact-head native CLI with an owned,
bounded background job: launch it, issue default or explicit `kill`, wait for
that job and print the status. Add generator controls covering default TERM,
named/numeric TERM and INT, and invalid signal handling without signaling any
unowned process. Trace the builtin-to-Session-to-runtime path; fix signal
propagation generally rather than changing only the displayed status. Preserve
Ctrl-C cancellation as INT, job scope/identity, descendant ownership and work
bounds. Require native/WASI coverage, Bash differential agreement and zero lost
passing corpus cases before calling this follow-up complete.

The generator's INT controls use an owned `sleep 1` job whose lifetime does
not depend on interpreter throughput, save the `kill` command status, then wait
and reap the job. They compare the kill-command result with Bash; the observed asynchronous
child wait status can depend on whether the child has installed its signal
disposition before the kill, so these controls do not claim a fixed Bash wait
status for INT. Native and WASI ProcessHost controls assert requested signal 2
and wait status 130. Full POSIX asynchronous
signal-mask parity remains an Approved follow-up after this unit, with no source
text or corpus-case exception. The old million-iteration arithmetic job was
only a lifetime guard; the generator now records Bash 5.3.15 observations for
the independent sleep-based control, while the arithmetic loop remains an
explicit performance benchmark below. The native shell-engine candidate does
not provide external `sleep`, so its recorded candidate-side background job
exits with status 127 before the invalid signal is issued; the semantic
assertions still cover kill status, wait/status output and no stray output, and
real signal delivery remains covered by the native/WASI ProcessHost controls.
The Bash fixture regeneration verifies that Bash has a live owned `sleep` job
when `kill -s INVALID` runs.

The current builtin boundary supports signal 0 as a non-destructive owned-job
existence check and supports HUP, INT, QUIT, KILL, and TERM as terminating
signals. Stop/continue, child-status, user, alarm, pipe, and other unsupported
actions return a diagnostic before job or host mutation. Out-of-range numbers
are invalid. Traps, ignored-signal inheritance and broader POSIX signal action
parity remain deferred rather than being represented as termination statuses.

## Current unit: structured control flow and conditionals

Status: Approved; implementation and acceptance evidence are recorded below.
Delivery is tracked in [PR #4](https://github.com/ShaulLavo/bash-web/pull/4).
The starting main `b60cc95` has 681/1,682 Oils, 606/1,888 Brush-suite and
1,028/2,222 Bashkit-suite passes. Every previously passing case must remain passing, not merely each
corpus total. Frozen oracle identity and all six existing differential-generator
sources and fixture bytes remain unchanged.

The unit executes structured if/elif/else, until, word/arithmetic for, counted
break/continue, case fall-through, argv test/[ and parse-time [[ ]] expressions,
with Bash errexit eligibility and suppression contexts. Original real metadata,
incremental quote-aware for-list pathname expansion, shopt state/inheritance,
no-capture ERE and dynamic EPOCHREALTIME adapters are narrow prerequisites for
preserving passes exposed by executing formerly unsupported loops. Extended
pattern matching, capture groups/BASH_REMATCH arrays and locale collation remain
explicitly unsupported; they are not claimed as implemented here.

The new original generator has 2,448 cases per seed (1,848 structured controls
at depths 0–3 plus 600 seeded cases). GNU Bash 5.3.15 self-controls and oracle-only
fixtures for seeds 1/42 and strict candidate replay pass. The repaired integrated
source passes 929 native and 914 WASI tests. Release size is 2,665,164 raw bytes
and 568,677 Brotli-11 bytes, below the unchanged 1,000,000-byte ceiling.
Review repairs close compound-owned process-substitution descriptors, apply
redirection-setup errexit, stream missing-descriptor diagnostics, preserve scalar
pattern behavior while fixing repeated case/pathname matching, and explicitly
reject unsupported non-ASCII ERE data/locales. No limit or stack-size increases
are allowed. All six strict differential families and the 27 parser-boundary
controls pass, including 2,448/2,448 control-flow matches per seed with zero
mismatches/unsupported results; 109 generator/scoreboard/runner tests pass.
Independent exact-head approval and green CI remain required before merge.

The repaired [PR CI score artifact, run 39080569449](https://github.com/ShaulLavo/bash-web/actions/runs/39080569449)
records 919/929/1,285 passes: gains of 238/323/257 with zero lost `b60cc95`
case IDs and identical frozen identity/case membership. Its exact exported bytes
supply the candidate baseline; these are not inferred local totals. Compared
with the first unmerged CI result (917/927/1,286), review repairs add four passes
and replace one accidentally accepted Unicode ERE case
(`bashkit-suite:bashbox-utf8:56`) with explicit unsupported status 2. Independent
source review approved `cd99ae3`; final delivery requires exact-head approval
and green CI. [PR #4](https://github.com/ShaulLavo/bash-web/pull/4) contains the
source, repair and artifact evidence.

## Previous unit: preflight and loop-work repairs

Status: Source acceptance passed at `e4202c7`; final fixture/evidence-head CI,
independent review and merge remain required. Its exact native CLI passed all
six Bash 5.3.15 sweeps: substitutions 3,142 each (seeds 1/42), braces 7,334 each
(1/42), arithmetic 3,692 each (7/314), all with zero mismatches or unsupported
cases. Old word, readonly and parser-boundary fixture replays passed. Frozen
scores are Oils 681/1,682, Brush-suite 606/1,888 and Bashkit-suite 1,028/2,222,
with zero lost case IDs against runtime main `e3f245f` (527 / 394 / 792).
The exact source producer passed native/WASI tests and size gates (2,518,525
bytes raw, 529,529 bytes Brotli-11); actual browser verification passed 132
controls with six existing skips. The independent exact-source review approved
`e4202c7`. [Run 39053112336, producer job 117455545690](https://github.com/ShaulLavo/brush-web/actions/runs/39053112336/job/117455545690)
contains that source evidence; its two stale fixture/baseline data gates are
not accepted as final green CI. Refresh and strictly replay those data in this
unit before landing. Arithmetic timing margin remains the Approved follow-up
below, not a completed throughput claim.

Historical diagnostic at `8dd11b8`: native/WASI and size gates passed (2,514,034
bytes raw, 528,401 bytes Brotli-11), and browser verification passed 132 controls
with six existing skips. The following failures were discovered at that head
and repaired before `e4202c7` source acceptance.

The six Bash 5.3.15 sweeps at that head exposed two remaining defects: both
substitution seeds time out on the unchanged invalid-signal control's finite
million-iteration job (2,000 ms acceptance bound), and both brace seeds report
two protected-dollar arithmetic boundary mismatches. A separately admitted,
bounded diagnostic completes the job in roughly 2.9 seconds but reveals an
additional invalid-signal status difference (2 instead of Bash's 1). Preserve
the time bound and workload; repair execution cost and signal parsing generally,
not the generator. `$((0 + "$"((1+2))))` must not reactivate a quoted dollar as
an arithmetic opener. The arithmetic sweeps, old fixture replays and per-case
ratchet passed; they do not waive these failures. Qualified source artifact:
[run 39050413259, producer job 117447674511](https://github.com/ShaulLavo/brush-web/actions/runs/39050413259/job/117447674511).

The qualified native CLI from [run 39037414534, producer job 117409933867](https://github.com/ShaulLavo/brush-web/actions/runs/39037414534/job/117409933867)
exposed five actual finite-control gaps before the full generator sweeps:
external multiple heredocs need one isolated reader state, `${!+set}` is rejected,
a repeated numeric wait loses its known status, IFS nameref target mutations
must not be conflated with positional-join cache invalidation, and an overflowing
nameref assignment must stop the remainder of its physical input line while
preserving next-line recovery. The runtime author owns readers, special scalar
operators, wait lifecycle and assignment error flow; the scalar author owns the
IFS state/expansion adapter. Controls compare exact stdout bytes and status;
they do not substitute unsupported `test` syntax for expansion assertions.

The same run's full browser verification passed 125 tests, skipped six existing
runtime limitations and failed one Chromium control:
`tests/runtime-shell.spec.ts:74`, **Ctrl+C interrupts executing shell WASM without
killing an independent background Bun**. The unchanged `while :; do :; done`
control reported `CPU_STATUS:2` instead of `CPU_STATUS:130`; the unrelated Bun
kept ticking. Loop work accounting is owned by this unit's runtime author.
An endless or long loop is valid shell: execution checkpoints yield and poll
interruption rather than terminate the loop for elapsed work. Keep admitted
memory/storage and recursion limits, audit other looping/long-running paths,
and add a native/WASI control that runs beyond the former work allowance before
interrupting to 130. Do not raise a limit or loosen the browser assertion.
Inspect `shell/engine/src/interpreter/eval.rs:Scope::frame/admit_execution` and
its cumulative parser-work charge as a hypothesis, not a proven sole cause.

Every source revision invalidates the earlier binary/generator acceptance.
Qualify a fresh exact-head push artifact using its completed producer job, run
ID, job ID, source receipt and binary checksum. Full verification may run in
parallel, but final acceptance still requires every CI job green, six actual
Bash differential sweeps, refreshed strict fixture replay, zero lost corpus
passes and independent review of the exact final head.

## Follow-up: arithmetic throughput and timing margin

Status: Approved; throughput remains unfinished even when the substitution
sweeps pass. Target **at most 1,000 ms for both foreground and background
million-iteration controls**, under the unchanged release configuration and
2,000 ms differential timeout. Do not raise the timeout, reduce the iteration
count, change the release profile, enlarge stacks or weaken tests to obtain
margin.

The canonical admitted local experiment at `e4202c7` measured 2,082 ms foreground
and 1,846 ms background after borrowed arithmetic-command replay, versus
2,981 / 2,800 ms before it. These are single-run diagnostic observations, not a
performance headline or a reliability distribution. The exact CI CLI from
[run 39053112336, job 117455545690](https://github.com/ShaulLavo/brush-web/actions/runs/39053112336/job/117455545690)
passed substitution seeds 1/42 under the unchanged timeout, but 154 ms of local
background headroom is too thin to call throughput complete. A bounded numeric
leaf future-representation experiment passed native semantic tests but was
reverted: three alternating matched-compiler rounds under ordinary non-quiet
admission measured median scaled retired user instructions of 35.318 billion
control versus 35.617 billion candidate foreground (+0.85%), and 31.282 billion
versus 31.216 billion background (-0.21%). All 12 outputs/statuses matched; these
counts do not establish a clear reduction. Counters included inherited child
instructions and recorded enabled/running time for multiplex scaling. The
experiment changed no permissions, kernel settings, profile or timeout. Its
source and temporary binaries were removed; it is not part of accepted source.
No quiet timing hold ran. Do not assume that fewer allocations meet the target.

The host-probe isolation repair at `1976a05` was independently reviewed and
passed native shell tests, but exact-head CI run `39060501467` still timed out
the old invalid-signal million-loop control under the unchanged 2,000 ms bound.
The matching local diagnostic measured 1,495.5 ms for the plain foreground
million-iteration loop and 1,526.7 ms for the invalid-signal foreground loop,
versus Bash 5.3.15 at 593.8 ms and 603.7 ms. These are bounded local
observations, not a completion claim. The generator's signal control now uses
`sleep 1 &`, so it tests owned-job signal semantics without making the
correctness gate an incidental arithmetic benchmark. Record the next matched
retired-instruction profile before choosing another general hot-path repair;
the target remains at most 1,000 ms, then parity with Bash.

The final evidence head `bc4e3b5` then reproduced the timing failure on CI:
[run 39055395219, shell job 117462215829](https://github.com/ShaulLavo/brush-web/actions/runs/39055395219/job/117462215829)
passed native/WASI/size/CLI and the earlier fixture gates, but the substitution
replay's invalid-signal million-loop candidate timed out (null status, empty
stdout) against Bash exit 0 and `kill=1` / `status=0`. Its actual browser and
compatibility jobs passed, and the exact downloaded CLI separately passed all
six local sweeps; neither overrides this red CI result. **Landing is blocked**
until a measured general hot-path repair gives adequate margin with unchanged
limits. Before another source change, build the native CLI with symbols and
sample that exact loop's retired instructions under ordinary admission. Rank
functions and attribute checkpoint/interrupt, arithmetic parsing/expansion,
variable lookup/allocation and storage-accounting costs from the samples, not
guesses. Confirm the chosen repair with alternating matched-toolchain
instruction counts, then requalify exact-head native/WASI/browser/six-sweep,
fixture and zero-loss gates. Do not retry unchanged source into green.

Reproduce the fixed control without host files or unowned processes:

```bash
i=0; while ((i < 1000000)); do ((i += 1)); done &
kill -s INVALID %1; kill_status=$?; wait %1
printf 'kill=%s\n' "$kill_status"
status=$?; printf 'status=%s\n' "$status"; exit "$status"
```

Require exact stdout `kill=1` then `status=0` and exit 0. For the foreground
control, run the same loop without `&` and print `i=1000000`. Use the canonical
host queue, a qualified exact-head CLI and Bash 5.3.15; retain every bounded
sample rather than choosing the fastest. PC performance research never requests
`--quiet` holds: compare retired instruction counts under ordinary admission
(or WASI fuel), alternating matched control/candidate binaries. Wall-clock
performance verdicts belong on the Mac or Pi. The unchanged PC generator timeout
remains a correctness gate, not a timing benchmark. The existing generator command is
`node scripts/fuzz-shell-substitution-boundaries.mjs --queue-active --shell
"$SHELL_NATIVE" --seed 1` inside that admitted run; also run seed 42 and the
other four arithmetic/brace sweeps with their unchanged settings.

Profile and attribute remaining cost before choosing further work. Current
static candidates are boxed arithmetic `expression` / `parse` / `unary` frames
and recursive scalar reads in `shell/engine/src/arithmetic.rs`, descriptor and
`PIPESTATUS` allocations in `interpreter.rs::loop_arithmetic/finish_command`,
and repeated cancellation checks in `expand.rs::Work::checkpoint`. A persistent
scheduling quantum must be separate from fresh command admission: persisting
all of `Work` would eventually reject valid loops; resetting the scheduling
quantum for each short command would never yield. Do not remove probes merely
because they look duplicated: they reach foreground ABI interrupt ownership and
affect cancellation-versus-resource-error ordering. No broad arithmetic-driver
or scheduler rewrite is mandated without measurements.

Preserve the complete grammar, current-variable reads, recursive scalar values,
assignment order and durable side effects; pre-growth live admission, bounded
copies charged to `Work.storage`, cooperative interruption/yielding and small
poll/drop stacks. Valid long loops never fail for cumulative elapsed work.
Retain function128/execution256/eval16, exact32/deep127, admission/depth/error
boundaries, peer progress, cancellation/recovery and actual consuming-ABI
foreground ownership. Acceptance includes native/WASI/browser controls, six
unchanged differential sweeps and zero lost corpus IDs. Record target results
and remaining margin in the final evidence and PR; a green semantic gate alone
does not close this performance follow-up.

## Follow-up: redirect word expansion contexts

Status: Approved. After the IFS admission fix, handle redirect-target contexts
separately from scalar assignment; this may precede the full low-yield ANSI-C
cursor once unimplemented ANSI-C shapes fail explicitly. Current
`interpreter.rs::redirects` calls `expand::word` (scalar), which
intentionally suppresses brace expansion and field splitting. Reproducer:
`echo hi >/dev/null{1,2}`. Bash 5.3.15 reports an ambiguous redirect/status 1;
our memory filesystem instead receives a literal `/dev/null{1,2}` filename.
Start with generator controls for redirect brace lists/ranges, quoted and
escaped variants, parameter/IFS splitting, zero/one/multiple fields, and
side-effect order. Do not run host-writing controls except in an owned scratch
filesystem. Then introduce a redirect-specific expansion contract with correct
ambiguity diagnostics, preserving scalar assignments/declarations. Confirm
Bash results before implementation, run full native/WASI tests and exact pass
membership ratchet, and keep zero CI exemptions.

**Approved lexical descriptor-target correction (2026-10-18).** The control-flow
review's diagnostic follow-up exposed an existing target-spelling loss in
`shell/parser/src/parser/lexer.rs:871`: `target_str.parse().unwrap_or(1)` silently
turns an overflowing `N>&M` target into descriptor 1. Bash 5.3.15 command
`/usr/bin/bash -c ': 1>&4294967296; echo status:$?'` exits 0, prints
`status:1\n`, and diagnoses `/usr/bin/bash: line 1: 4294967296: Bad file descriptor`.
The native candidate at source head `51a883e` plus the review repairs instead
prints `status:0\n` with empty stderr; the new handwritten probe observed this
once before the parser correction was deferred. The lexer fallback explains the
result without a race; unprefixed and expanded targets reach the correct runtime
diagnostic path, ruling out runtime numeric lookup as the cause. Input duplication has the analogous
`unwrap_or(0)` at lexer line 899; that direction is code-derived, not a separately
executed candidate result. Confirm it with `: 0<&4294967296; echo status:$?`.

Preserve raw target spelling and expansion instead of casting failure to a
valid descriptor or a parse-time status 2. Output already has `DupFdWord(i32)`;
input needs the equivalent representation. Inspect
`shell/parser/src/parser/tokens.rs:144` and both redirect readers in
`shell/parser/src/parser/mod.rs:1403` and `:4358`, then update lexer, tokens and
both parser paths together. Cover both directions, literal/expanded numeric
limits, leading zeros, closed descriptors, stderr redirects, `-e`, and read-unit
recovery under native/WASI plus the exact no-loss ratchet. Keep spelling scans
cooperative and allocations admitted. Runtime diagnostics for correctly
preserved targets are implemented in this control-flow unit; this lexer/parser
representation work belongs to the redirect unit, with its provenance record.

## Follow-up: 700,000-byte scalars fail with a silent status 2

Status: Approved. Pre-existing and unrelated to pathname expansion (found during
#54's CI repair, 2026-10-22). Bash 5.3.15 assigns all three; Waffle prints no
message, returns status 2 and leaves the old value:

- `x=0000000000; x=$x$x$x$x$x$x$x$x$x$x` three more times (100,000 bytes), then
  `x=$x$x$x$x$x$x$x; echo status=$? length=${#x}` gives `status=2 length=100000`.
  Six copies (600,000 bytes) still work.
- `printf -v x '%0700000d' 0` and `x=$(printf '%0700000d' 0)` give `status=2 length=0`.

The 1 MiB per-command expansion budget (`expansion_bytes` in
`shell/engine/src/interpreter.rs`) is the likely ceiling: a value over half of it
seems to be charged twice while it is copied into storage. Measure where the
second charge happens before changing it. Either fix the double charge or report
the limit with a diagnostic like other budget failures. Do not raise the budget.
Reproducer: `/work/reports/bash-web/hill-climb/expansion/pathname/ci-fix-opus-r1/scalar700k.ts`.

## Follow-up: long glob candidate fields exhaust the work budget

Status: Approved. Found by #54's second narrow review (2026-10-22,
`/work/reports/bash-web/hill-climb/expansion/pathname/review-r2/`, N7). Bash keeps
these argv words literal; Waffle stops with status 2 (`echo $? $# ${#1}` prints
`2 0 0`). The error is honest, never a wrong match or a silent miss, but it is not
Bash parity. `x` below is 100,000 `a`s built by concatenation
(`x=aaaaaaaaaa; x=$x$x$x$x$x$x$x$x$x$x` four times):

| Word (`set -- …; echo $? $# ${#1}`) | Bytes | Bash | Waffle at #54 `fc7368f` |
|---|---|---|---|
| `$x$x$x*` | 300,001 | `0 1 300001` | same |
| `$x$x$x${x:0:30000}*` | 330,001 | `0 1 330001` | `2 0 0` |
| `$x$x$x${x:0:50000}*` | 350,001 | `0 1 350001` | `2 0 0` |
| `[$x$x${x:0:50000}` (unclosed bracket) | 250,001 | `0 1 250001` | same |
| `[$x$x$x${x:0:50000}` | 350,001 | `0 1 350001` | `2 0 0` |
| `$x$x$x$x[` (trailing bracket) | 400,001 | `0 1 400001` | same |
| unquoted minified JSON: `j='[{"k":[1,2]}'; while [ ${#j} -lt 400000 ]; do j=$j,$j; done; j=$j']'; set -- $j` | 425,984 | `0 1 425984` | `2 0 0` |
| plain `$x$x$x$x$x$x` | 600,000 | `0 1 600000` | same |

Mechanism: every scanned character costs one checkpoint step from the command's
work budget (`source_bytes + expansion_bytes + arguments`, about 1.376M steps;
`shell/engine/src/interpreter.rs`). Building a field costs about 2.2 steps per
byte (fit to the thresholds above, not instrumented). A long component with
magic is then read twice: `expand_fields` → `magic()` → `long_shape` → `shape`,
and again in `matches()` → `unmatchable()` → `shape`
(`shell/engine/src/expand/glob.rs`). A long unclosed `[` is read twice in one
pass: `bracket()` walks to the end, then `shape` walks the same characters.

Work: compute each long component's shape once per field (for example, `magic()`
also reports that the field is unmatchable, so `expand_fields` skips `matches()`),
and don't rescan after an unclosed bracket. The review estimates this moves `*`
fields to about 430k bytes. Plain-field parity is out of reach while each scanned
character costs a step, so measure and record the remaining ceiling. Don't raise
budgets or stop charging steps. Reproducers: `review-r2/probe.ts` cases A1-A10
and T1-T10, with results in `probe.jsonl` and `budget.jsonl`.

## Follow-up: repeated-slash pathname result spelling

Status: Approved. PR54 correction review found this pre-existing spelling
mismatch at `0c6dd6c691a1273b8c8139fef53f500f8ef31835`. Source:
`shell/engine/src/expand/glob.rs:278-300`, `joined()` copies the prefix and appends
its separator and trailing directory slash without normalizing repeated slashes.
The current-main integration preserves that approved production file byte for
byte; no spelling fix is part of PR54.

Reproduce in an empty directory with GNU Bash `5.3.15(1)-release` and the
production Waffle runner, using each runtime's own `$TMP`:

```bash
cd "$TMP"; mkdir -p d/x d/y; printf '<%s>\n' d*//*/
cd "$TMP"; mkdir -p d/x d/y; printf '<%s>\n' ./*//
```

The first script prints `<d/x/>` and `<d/y/>` in Bash, but `<d//x/>` and
`<d//y/>` in Waffle. The second prints `<./d/>` in Bash and `<./d//>` in
Waffle. Review evidence and exact scripts are in
`/work/reports/wave-20261022/shell/review54-r1-evidence/attempt2-probes.jsonl`.
The integration report records a fresh Bash control and current-source guest
check. Fix result spelling without changing directory selection, quoted-slash
handling, path-length admission or storage/work/cancellation charges. Add pinned
recordings first, then prove the corrected bytes on a fresh Waffle runtime and
preserve the frozen ruler's existing passing cases.

## Approved extraction: public `ShaulLavo/bash-web`, with history

Status: Approved (owner, 2026-10-17). **Scheduled after the oracle/harness PR
merges, then the command/process-substitution PR merges. The root coordinator
owns the extraction; lanes do not create the repository or move files now.**
The destination is the public repository `https://github.com/ShaulLavo/bash-web`.
This is a history-preserving move, not a snapshot copy or a new shell rewrite.

The shell becomes an independently maintained parser/interpreter/engine package.
The shared WASI/browser runtime remains a **separate package that the product
pulls in**, alongside the shell; it is not moved into the destination shell
repository or absorbed into the shell. Preserve the `ProcessHost`, `HostEndpoint`, `FileSystem` and
session/executor boundaries documented in `shell/engine/README.md`. Distinguish
the in-process test fixture from the substitution lane's actual browser runtime
integration: real Bun children now exercise captures, process-substitution input
and here-string input on Chromium and Firefox. Those controls do not alone
satisfy every step 1 browser-worker gate or authorize replacing Brush before
step 6. Extraction waives none of those requirements.

### Ordered execution

1. Verify both prerequisite PRs are merged on the host and record their merge
   commits. Fetch the resulting `origin/main`; inventory **that merged tree**,
   not the current shared worktree. The oracle/harness work changes transport,
   oracle metadata/identity, baseline and tests, while the substitution work adds
   generator coverage. Preserve those final versions together.
2. In a root-owned migration lane, perform a history-preserving extraction of
   `shell/` **and the outside-shell paths below**. Retain their earlier changes,
   the original source-repository/base identity and the extraction commit map;
   do not squash the shell into a single initial commit. A shell-only subtree
   export is insufficient because it loses verification, licenses and pins.
   Create/publish the destination only at this step, after both merges.
3. Initially keep `shell/`, `scripts/`, `sources.lock.json` and
   `docs/evidence/` at their existing relative paths. Normalize paths only in a
   separately reviewed change that updates every executable reference. Preserve
   frozen oracle and generator fixture bytes; a repository rename is not a
   reason to recapture expected results, reset the ratchet or regenerate seeds.
4. Adapt the root manifests, shell-only CI and notices as inventoried below.
   Make the standalone default select only `own-shell`; retain browser/reference
   engine comparisons in the host or behind an explicit optional integration,
   not as an implicit download/build dependency of standalone verification.
5. From a clean destination checkout, run the final merged parser/provenance,
   native/WASI, size, runner/scoreboard, generator-replay and fixed per-case
   ratchet gates. On this host use the shared heavy-job queue and SSD-backed
   targets/scratch. Verify that frozen replay needs no corpus caches, installed
   oracle or browser assets. Root owns CI/review/merge and checks the resulting
   destination history and post-merge gates; this note does not run those jobs.
6. Update the old host's shell ownership/consumption and documentation to point
   to the destination rather than leave two writable copies. The future product
   consumes the shell and the separate runtime packages; terminal/UI work and
   runtime implementation remain outside this extraction. Remove migration
   scratch and task-created caches after their consumers stop, preserving shared
   caches and requested evidence.

### Outside-shell dependency inventory

Paths below are relative to this repository root. They are the initial
extraction checklist, to be reconciled with the final two merged PRs. The Rust
workspace itself has no outside-shell path dependency: the engine's local crate
reference is `../parser`; its tests use Cargo's own binary fixture. The missing
pieces are build policy, verification, frozen inputs and provenance.

| Area                                         | Carry with history, or explicitly adapt                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust build policy                            | `rust-toolchain.toml` (Rust **1.98.1**, rustfmt, `wasm32-wasip1`); `.cargo/config.toml` (WASI maximum memory **268435456**); retain `shell/Cargo.toml`, `shell/Cargo.lock`, both crates, READMEs and `shell/parser/LICENSE`. Keep `.build/shell` artifact paths initially.                                                                                                                                                                                                                                                                                                                              |
| Main compatibility runner                    | `scripts/bash-compat.mjs`, `bash-compat-worker.mjs`, `bash-compat-helpers.mjs`, `shell-scoreboard.mjs`, `shell-scoreboard-base.mjs`, `shell-scoreboard-migration.mjs`, `shell-process-group.mjs`. The entry point imports the helper, runner and scoreboard modules and starts the worker by filename; the worker imports the helpers. Preserve immutable `git show` target-baseline reads, the isolated target rebuild and original-membership proof, inherited-startup-hook exclusion, cancellation ownership and process-group draining.                                                             |
| Oracle transport from the prerequisite PR    | `scripts/bash-compat-runner.mjs`, `bash-compat-pipe.py`, `audit-bash-oracle-pipe.mjs`, `test-bash-compat-runner.mjs`. Take their final committed merged versions. The runner spawns the Python file, including a separate exit-status fd; do not replace its real independent stdout/stderr pipes with direct Node `spawn` transport. The audit imports the helpers, runner and scoreboard.                                                                                                                                                                                                             |
| Runner/ratchet tests                         | `scripts/test-shell-scoreboard.mjs`, `test-shell-scoreboard-base.mjs`, `test-shell-scoreboard-migration.mjs`, `test-compat-selection.mjs`, `test-own-shell-runner.mjs`, `test-bash-compat-audit.mjs`, `test-bash-compat-cleanup.mjs`, plus the transport runner test above. Preserve the real-entrypoint cancellation controls, delayed consumer/worker termination barriers, private migration fixtures and startup-hook rejection. The own-shell runner test starts `bash-compat-worker.mjs` by filename; tests also depend on the existing evidence/manifest paths.                                  |
| Parser/WASI checks                           | `scripts/check-shell-parser.mjs` and `scripts/test-shell-wasi.ts`. The provenance check reads `sources.lock.json` and its `shellParser.directory` license. The WASI check owns streaming acceptance and the brotli-11 **1,000,000-byte** release ceiling; do not lose it when removing browser tooling.                                                                                                                                                                                                                                                                                                |
| Differential generators                      | `scripts/fuzz-shell-words.mjs`, `fuzz-shell-readonly.mjs`, `fuzz-shell-arithmetic.mjs`, `fuzz-shell-parse-boundaries.mjs`, `fuzz-shell-braces.mjs`, `fuzz-shell-substitution-boundaries.mjs`; `scripts/test-fuzz-shell-braces.mjs`, `test-fuzz-shell-substitution-boundaries.mjs` import their corresponding generators. Carry/adapt the shell instructions from `scripts/README.md`. All six generators use Node built-ins.                                                                                                                                                                            |
| Seed fixtures                                | Under `scripts/fixtures/`: `shell-words-seed-1.json`, `shell-words-seed-42.json`, `shell-readonly-seed-17.json`, `shell-arithmetic-seed-7.json`, `shell-arithmetic-seed-314.json`, `shell-parse-boundaries.json`, `shell-braces-seed-1.json`, `shell-braces-seed-42.json`. Add the substitution PR's final `shell-substitutions-seed-1.json` and `shell-substitutions-seed-42.json` once committed; they did not yet exist at inventory time. Inventory all additional merged fixtures rather than synthesizing missing files during extraction.                                                        |
| Frozen scoreboard and capture classification | `docs/evidence/own-shell-oracle.json`, `own-shell-baseline.json`, `oracle-pipe-audit.json`, **and** `bash-compatibility.json`. The audit retains the proven transport corrections, unchanged identities, original-membership proof and corrected replay; the classification file preserves capture's historical case classifications and its hash, even though normal frozen replay does not read it. Carry `docs/evidence/licenses/oils-LICENSE.txt` and `brush-MIT.txt`; Bashkit's retained MIT license is `shell/parser/LICENSE`.                                                                    |
| Source/provenance manifest                   | Adapt `sources.lock.json`, preserving `shellParser`, `shellScoreboard`, `shellWords`, `shellParameterDefaults`, `shellParameterEffects`, `shellParameterLength`, `shellParameterTrim`, `shellParameterCase`, `shellParameterIndirect`, `shellParameterReplace`, `shellArithmetic`, `shellBraces`, and any shell entries added by the prerequisite PRs, with complete classifications/change records. Also retain the corpus pins under top-level **`oils`, `brush`, `bashkitTerminal`**: executable frozen validation reads them, not only `shellScoreboard.corpora`.                                   |
| Licenses/notices                             | Retain the root `LICENSE` and shell-relevant sections of `THIRD_PARTY_NOTICES.md`, including every adapted implementation/test and original-adapter distinction. Extract a shell-only `scripts/notices.mjs` flow that includes the pinned parser license, actual Cargo dependency licenses and retained corpus licenses. The current generator also reads the Brush browser workspace, terminal/Bun/Bashkit distributions, npm lock and `.sources` notices, so it cannot be copied unchanged as the standalone build command. Preserve a distributed generated notice file and update its README links. |
| Documentation                                | Carry/adapt `docs/bash-compatibility.md` (method, identities, capture/replay, ratchet and generator sections), this plan, `shell/README.md` and `shell/engine/README.md`; fix root-relative links. Keep historical Brush/Bashkit comparisons and original commit/CI links explicitly historical, not fresh standalone measurements. Product/browser architecture, performance and cold-start pages remain host documentation; link them where their acceptance criteria still apply.                                                                                                                    |
| Root JS/configuration                        | Create a shell-only `package.json`/`package-lock.json` adaptation, preserving Node **26.7.0** and the named shell scripts below. Frozen replay/generators need no npm packages. Capture additionally needs `yaml` (currently **2.9.1**); keep it reproducible when that operation is retained. Carry/adapt `.gitignore`, `.gitattributes` and `.oxfmtrc.json` if their rules are used. Do not inherit frontend `verify`, `build`, `sources`, or Brush-chained `test:rust` commands unchanged.                                                                                                           |
| CI                                           | Extract/adapt `.github/workflows/ci.yml`'s `shell` and `own-shell-compatibility` jobs, plus the prerequisite PR's final transport/audit steps. Preserve Node **26.7.0**, Rust **1.98.1**, wasmtime **v49.0.3**, rustfmt, the WASI target, locked native/WASI builds, bounded `-j2` CI work, generator tests/replays, score artifacts and exact target-branch checks. Preserve full checkout history (`fetch-depth: 0`) for baseline comparisons and adapt the Rust cache workspace to the retained paths. Do not pull in the frontend/browser/reference-engine `verify` job.                            |

The standalone package scripts must retain `build:shell`, `test:shell:wasi`,
`test:shell:scoreboard`, `compat:shell`, all `fuzz:shell-*` and their `:ci`
replay commands, and `test:fuzz-shell-braces`/`test:fuzz-shell-substitutions`.
Use the final merged scoreboard test list, including the oracle runner tests;
replace `test:rust` with the shell-only provenance and locked workspace tests.
The native generator binary is `.build/shell/release/shell-engine`; WASI replay
uses `.build/shell/wasm32-wasip1/release/shell-engine.wasm`.

### Frozen inputs, maintenance setup and migration traps

- Preserve these exact corpus revisions and their retained license/hash records:
  Oils `bdc8364c253ce921e033bbc2399ea2ce0be41825`,
  Brush `4cfba081f2f8bcda8150010a57203d020f14f0cc`, and
  Bashkit/parser `491c3281f668b76d64b15210b8f5d7bf97244be0`.
  Inputs are respectively `spec/*.test.sh`,
  `brush-shell/tests/cases/compat/**/*.yaml`, and
  `crates/bashkit/tests/spec_cases/bash/*.test.sh` excluding Oils/just-bash ports.
  Keep archive checksums in the manifest, not freshly downloaded substitutes.
- Normal frozen replay reads committed observations only: no corpus downloads,
  GNU Bash execution, browser runtime or comparison-engine builds. Capture is a
  separate explicit maintenance operation requiring Linux, GNU Bash
  **5.3.15(1)-release**, bubblewrap with functioning namespaces, `/usr/bin/python3`
  (standard library, including Unix `fcntl`/`termios`), `yaml` and all pinned
  corpus sources. The exact Node version and environment digest remain identity
  requirements. Preserve both streams as exact bytes; only stdout/status score.
- Add a **corpus-only preparation path**, not an engine build. Oils currently
  uses `.sources/oils` with `.revision`/archive checks; Brush defaults to
  `vendor/brush` or `BASH_COMPAT_BRUSH_DIR`; Bashkit defaults to `.sources/bashkit`
  or `BASH_COMPAT_BASHKIT_DIR`. Extract only the pinned fetch/check/extract part
  of `scripts/build-bashkit.mjs` for Bashkit corpus setup. Do not invoke the full
  build. `scripts/sources.mjs` also fetches the terminal and initializes Brush;
  it is not suitable standalone setup. Cached source directories and downloaded
  binaries are not files to commit/import with the shell.
- Preserve generator **source bytes** as well as fixture bytes. Each fixture
  pins the SHA-256 of its whole generator, so even renaming a comment, queue
  label or default path invalidates it. Any necessary generator edit requires
  an explicit reviewed fixture-identity migration, not silent regeneration as
  part of the repository move. Preserve all existing pass membership; source,
  case/oracle/environment changes require the documented base/candidate rerun.
- Several defaults are machine-local: optional self-queuing through
  `/work/tmp/wave-heavy/run.sh`; the words generator's automatic build uses
  `/work/cache/cargo/bin/cargo` and local Cargo/Rustup homes. Pass `--shell` to
  use the prebuilt native binary without invoking that path. Keep Node-only
  replay portable; document local queue integration separately without changing
  pinned generator bytes incidentally.
- Keep `BASH_COMPAT_MODE=frozen`, `BASH_COMPAT_ENGINES=own-shell`,
  `BASH_COMPAT_SKIP_BUILD=1` after the explicit build, and `BASH_COMPAT_RECORD=0`
  in compatibility CI. `BASH_COMPAT_SHELL_WASM` can select the existing artifact.
  `BASH_COMPAT_BASE_REF` must be a full commit SHA **present in destination
  history**, not a source-host PR base SHA; target baseline/manifest reads still
  use their committed paths. Never bootstrap a new weaker baseline just because
  the repository name changed.
- Explicitly own scratch/results: `BASH_COMPAT_SCRATCH`, generator `FUZZ_*_SCRATCH`
  and `RUNNER_TEMP` must resolve to suitable storage; local heavyweight work
  belongs on `/work`. Audit/runner tests currently contain task-specific
  `/work/tmp/brush-web-climb-subst` defaults to revisit in their final merged
  versions. Substitution mismatch output survives outside its per-run scratch
  intentionally, so record a retention/cleanup owner. Do not copy `.build`,
  `.sources`, `node_modules`, `.scratch`, browser profiles or reference binaries
  into the destination.
- Leave terminal, Bun payloads, browser UI, browser process/runtime adapters,
  measurements and reference-engine build scripts in the host. The worker's
  optional `just-bash`/Bashkit imports and the entry point's default all-engine
  live mode otherwise reintroduce those dependencies; adapt selection explicitly
  before calling the standalone harness independent. The product's separate
  runtime package remains the owner of actual browser transport/filesystems.

### Follow-up: Firefox physical Worker retirement after pipeline Ctrl+C

Status: Approved. Investigate and fix the rare post-interrupt Worker-retirement observation; do not label it preexisting or PATH-caused without reproduction.

Original GitHub PR #10 run `39102637496`, job `117601857869`, tested merge `ee0ab860dbcd355929e4de68f2e608a8a415dcf8` (head `ee2ea700501440707d4e3e4818b9ce20b437d065` into main `9bc9d40a8f9eb2ed7bb1e632e88e75946d4025c5`). Firefox failed `tests/pipelines.acceptance.spec.ts:116`, `pipeline Ctrl+C stops every stage and its children`, at the unchanged five-second physical-worker baseline assertion. The original artifact is permanently archived at `/work/reports/bash-web/path-search/firefox-ci-original/failure-artifact.zip`; timing extraction is at `/work/reports/bash-web/path-search/firefox-ci-original/timing-summary.json` (also `/work/reports/bash-web/path-search/firefox-ci-failure-timing.json`). Original CI uploaded an embedded Playwright HTML report, **not a trace.zip**. Do not substitute later invalid-harness traces for an original trace.

Measured offsets from Firefox test start `2026-10-18T06:06:31.721Z`: shell ready +774 ms; Enter +811 ms; producer marker by +924 ms and consumer marker by +927 ms; Ctrl+C +928–943 ms; shell ready again +947 ms. Baseline was two workers; count was four at +947 ms, then three at +1048, +1298, +1800, +2801, +3803, +4804 and +5805 ms. One worker remained beyond the deadline; no post-interrupt STATUS/KEEP check ran after that failed assertion. The Chromium counterpart passed. Markers precede yes/cat launches, so they establish stage progress, not exact child identity or start completion.

A bounded control on UpCloud4 used Waffle 0.0.27 (`ba968a6`), Playwright 1.64.0, the exact same Firefox 1555 (SHA256 `1f637a7cfe8f1a3ec814a7da7e38c360a3e3c39553b8c7245ac5d6643fd495eb`), and complete frozen dist at root via unchanged `node dist/serve.mjs`. It interleaved 25 attempts per arm, one worker, no retries, with unchanged assertions and deadlines. Main `9bc9d40` passed 25/25; frozen PATH head `391ac6c` passed 25/25; separate smoke passed 1/1 per arm. Both arms use `/bin/test-guest` operands, because baseline cannot run bare commands with the canonical-only fixture; this is an explicit-path cancellation control, not identical bare-PATH parity. No startup, admission or worker-retirement failure occurred. The result is **inconclusive** for the original rare failure, not exoneration or proof that it was preexisting. Compact summary: `/work/reports/bash-web/path-search/firefox-matched-control/matched-summary.json`; full small ledger/results belong alongside it after cleanup. Dispatcher evidence: `/work/reports/machine-fleet/remote-gate/bash-path-cancel-pair027-20261018T070716Z-bueuy8mp/`.

Ruled out for the original failure: startup stall (shell and guests ran), simple command-not-found, and the custom relocated-dist setup (examined rerun failures were shell-WASM 404s and are invalid observations). Static engine inspection found synchronous spawn registration with no await gap; access requests use cancellation ownership without spawning workers, and kill/drain code was unchanged from main. This does **not** establish that physical worker termination or Playwright's close notification is correct. Waffle separates logical/job-safe exit from physical Worker termination; prompt readiness alone is insufficient.

Fresh-agent entry point: in an exclusive current checkout on a fleet-reserved host, run ordinary `npm ci && npm run build:browser`, then `npx playwright test tests/pipelines.acceptance.spec.ts --project=firefox --grep 'pipeline Ctrl' --trace on` (checked-in config serves complete dist at 4198). Keep the original bare-PATH command and assertions unchanged. Record each worker's URL/identity, real guest/PID/job ownership, spawn/cancel/drain/terminate/close ordering, and logical exit versus physical close through Ctrl+C. Instrument existing lifecycle boundaries without wrapping the Worker constructor or changing scheduling. Suspected boundary: physical Worker retirement/close notification after Ctrl+C, not yet a proven process leak. A repair needs a reproduced failing control and no longer timeouts, retries, skips or weakened worker assertions. Preserve compact evidence and verify all task processes, profiles, servers, checkouts and reservations are removed on the actual execution host.

### Follow-up: synchronous fork EAGAIN retry parity

Status: Approved. Match Bash 5.3 `jobs.c:2305` for synchronous spawn EAGAIN
(no free process slot): retry with 1, 2, 4 and 8 second backoff before reporting
final status 254 and aborting the reader. Bash's final failure path is
`jobs.c:2329–2342`; `EX_NOEXEC` is 126 (`shell.h:64`) and
`throw_to_top_level` adds 128 (`sig.c:424`) before noninteractive exit
(`sig.c:485`). The current shell reports the final failure immediately; #11 adds
no retry or sleep scheduling. Retry only a synchronous rejected spawn, where no
child identity was allocated. Never retry typed asynchronous START_FAILED EAGAIN:
its child identity has already been used. Tests must show slot exhaustion that
clears during backoff succeeds, and exhaustion that does not clear gives 254
without executing the rest of the submitted reader. Preserve cancellation and
cleanup during every wait and do not retry other synchronous errno values.

### Known difference: direct-child cleanup after a subshell fork failure

Status: Approved follow-up. Bash abandons the failing subshell reader without signaling its already-running children. Our existing reader cancellation currently signals shell-owned direct children with SIGINT (status 130), including on this local fork-failure path. It does not hunt down inherited descendants; those remain owned by the enclosing invocation's group cleanup. The regression `aborted_subshell_leaves_descendants_to_enclosing_invocation_cleanup` records this distinction and covers natural descendant exit and whole-invocation Ctrl+C with no leaked group or process slot. Preserve foreground process-group identity. Restore Bash's direct-child behavior only with bounded lifecycle controls; do not add descendant tracking or change process groups to hide the difference.

### Follow-up: parallel shell WASM and storage startup

Status: Approved. Start fetching and compiling the shell WASM in parallel with the filesystem's storage open, instead of after it. Firefox's first-visit IndexedDB open costs 586 ms median, 877 ms p90 and 2.3 s max (N26 on the PC, /work/reports/bash-web/startup-diagnostics/firefox-idb-profile/). The failed stall trace showed the shell WASM not requested until the filesystem was ready. Measure first-visit time-to-prompt in Firefox and Chromium before and after with #11's stage timestamps; keep it only if it's faster, with zero behaviour change. Sequence it after the fd-3 PR, which changes startup readiness.

### Follow-up: start-status-scoped exec diagnostic ownership

Status: Delivered by PR #20, merge
`02df6429cc142a771ff9ad26fae3f3d250d0bc04`. The runtime adapter holds redirected
stderr until start status resolves, drops it immediately on successful start,
and diagnoses START_FAILED before releasing it. Fork failures still use parent
stderr; genuine program exits 126/127 remain distinct. Exact-main checks and
actual-host cleanup completed for that unit. Its pipe/file diagnostic and
foreground/background EOF-ack controls remain covered. PR #21 separately adopted
Waffle 0.0.50 and covered lazy-loader quiet-start reporting. This historical item
is not another open assignment; later reader-cancellation, filesystem/device
and external Bun work remain separate.

## Follow-up: real-runtime scoreboard differences

Status: Approved (2026-10-18). The frozen replay moved from the standalone `node:wasi`/`InProcessHost` runner to the Waffle Node harness at main `9f0bf6a88ebba236a5db9ac3ca6fbe364632db9e` (see [the receipt](../docs/evidence/own-shell-instrument-migration.json)). These ten cases passed only under the old fake host and fail on the real runtime; each item fixes a real-runtime difference from Bash, and its cases then rejoin the ratcheted baseline.

### R1. File permission predicates on the runtime filesystem

Answer `-k`, `-r`, `-w` (and the related `-u`/`-g`/`-x` family) from runtime metadata, or the documented Bash fallback, instead of an unsupported-predicate error.

- `bashkit-suite:test-operators:32`: Bash status 0, stdout `readable\n`; ours status 2, stdout ``, stderr `/usr/bin/bash: [: -r: unsupported predicate\n`.
- `bashkit-suite:test-operators:40`: Bash status 0, stdout `writable\n`; ours status 2, stdout ``, stderr `/usr/bin/bash: [: -w: unsupported predicate\n`.
- `oils:builtin-bracket:280`: Bash status 0, stdout `status=1\nstatus=1\n`; ours status 0, stdout `status=2\nstatus=2\n`, stderr `/usr/bin/bash: test: -k: unsupported predicate\n/usr/bin/bash: test: -k: unsupported predicate\n`.

#### Authoritative permissions integration, 2026-10-21

Status: Approved, implementation measured and ready for independent review. The selected Waffle
pin is `fc58a532f0d7a617e631ea4b7580a190915d4ed6`, version 0.0.58. The shell now
consumes its four-word permissions query without changing Preview1 filestat.
Supported mode/access masks distinguish denied from unknown answers in the shared
`[ ]`/`[[ ]]` evaluator. Native modes stay unchanged. See
[the contract and control documentation](../docs/file-permissions.md).

The three candidate failures reproduced first in the real production runner and
then matched Bash after implementation. Native/WASI and real-runtime controls cover
actual read/write denial, directory search, metadata-only access, masks and ABI
errors. The memory selector is an equivalent API update. OPFS conformance tests use
the selected source's exact internal test helper, not an IndexedDB substitution.
Frozen identities, fixtures, skips and scoring are unchanged.

Measured source `51b7f366a9a10c9f0a248189ea4cf6f04b2803bc`, against accepted base
`bf9f62b2049f177fb9d293edc136a307d26a8d2f`, completed its single production replay
with JOBS=1. The 9,221 records still contain 5,792 scored cases and 3,429 skips.
Oils gains only `oils:builtin-bracket:280`, 1012 -> 1013. Brush stays1001.
Bashkit gains only `bashkit-suite:test-operators:32` and `:40`, 1404 -> 1406.
Every corpus loses zero passes. Only those three outcome fields and derived counts
change; historical failure payloads stay intact. The strict offline comparator
passes on the saved replay. Stderr is retained, not scored.

The delivery also moves the same blocking scoreboard CI command after its existing
production guest build so the new real-runtime controls have their required guest.
No check is skipped and no extra build is introduced. This wiring change and the
measurement receipt postdate the measured source; production semantics are identical.
See [the receipt](../docs/evidence/permissions-r1.json). Full R3 replay, controls,
reproducers and cleanup evidence live under
`/work/reports/bash-web/hill-climb/r1-permissions-integration/`. Parent owns independent
review, hosted checks, merge and exact-main acceptance. This is not final acceptance.

### R2. Background jobs at `-c` exit

Let `shell-runtime -c` exit without cancelling still-running background jobs, as Bash does; their output must drain to the inherited descriptors.

- `oils:shell-grammar:17`: Bash status 0, stdout `word word\n`; ours status 0, stdout `word`.
- `oils:shell-grammar:23`: Bash status 0, stdout `word_a\nword_b\n`; ours status 0, stdout `word_a\nword_b`.

### R3. Directory-read diagnostics

The original candidate `oils:builtin-read:794` uses `read -n3`. Its stdout/status
failure was option rejection, not proof that runtime errno mapping was wrong.
Counted-read support now makes that frozen case pass. No runtime errno mapping
changed. Bash-formatted directory-read diagnostics remain outside this unit.

### R4. `/proc/self`

Decide and implement a minimal `/proc/self` (at least `comm`) or record it as an explicit unsupported host feature with Bash-compatible failure.

- `bashkit-suite:proc-self:57`: Bash status 0, stdout ``; ours status 0, stdout `denied\n`.

### R5. Read-only `/usr` in the compatibility instrument

Give the Waffle Node instrument the oracle sandbox's read-only `/usr` (needs a Waffle read-only mount or equivalent), so these cases measure the shell rather than the instrument.

- `bashkit-suite:script-exec:132`: Bash status 127, stdout ``; ours status 126, stdout ``, stderr `/usr/bin/bash: chmod: command not found\n/usr/bin/bash: /usr/local/bin/my-tool: Permission denied\n`.
- `bashkit-suite:script-exec:95`: Bash status 127, stdout ``; ours status 126, stdout ``, stderr `/usr/bin/bash: chmod: command not found\n/usr/bin/bash: /usr/local/bin/myutil: Permission denied\n`.
- `bashkit-suite:subprocess-isolation:126`: Bash status 127, stdout ``; ours status 126, stdout ``, stderr `/usr/bin/bash: chmod: command not found\n/usr/bin/bash: /usr/local/bin/check-isolation: Permission denied\n`.

### R6. Ambiguous redirect diagnostics

`oils:var-sub:24` (`echo hi > "$@"` with two words) now passes on stdout and status, but only because `_tmp` is missing: Bash reports an ambiguous redirect. Diagnose multi-word redirect targets as Bash does; the stdout/status score cannot show this.

## Default echo options and bytes, 2026-10-19

Status: Approved. Bounded implementation from main
`dfbf44038ad43602f0e7c381b832fd9e984b577c`; parent owns independent review,
CI monitoring and merge.

The default `-n`/`-e`/`-E` family shares the existing bounded printf printer with
an explicit echo mode. No R1 file-permission code, runtime adapter or broad
option subsystem changes. `xpg_echo` and POSIX echo modes remain deferred.
See [echo behavior and ownership](../docs/echo.md) and `sources.lock.json`.

Strict native failing-first observations had 476 mismatches among 492 cases;
representative production real-Waffle observations had 5 mismatches among 6.
The implemented family matches all 492 on native and real Waffle. The unchanged
printf seeds retain all 1,122 native matches.

The frozen real-Waffle ruler retains its exact oracle/environment/source
identity, 9,221 records and 5,792 scored cases. Measured pass counts change
Oils 948 to 967, Brush 956 to 958, Bashkit 1,339 to 1,357. There are 39 gained
memberships and zero lost memberships. Only these measured outcomes and derived
counts change in the candidate baseline. The original 30 echo-file failures
were candidates, not an assumed gain; 28 of those pass now, while the two Brush
mode-dependent failures remain deferred. Eleven other cases gain from corrected
echo output. Exact IDs and raw candidate evidence are retained under
`/work/reports/bash-web/hill-climb/echo-options/` on the implementation host.

## Counted scalar read, 2026-10-19

Status: Approved. Bounded implementation from exact main
`1bdbacd6c11ca7be31a55a2b3964239eabf10482`; parent owns independent review,
CI monitoring and merge.

Add `read -n` for one scalar, including raw mode, backslash processing, NUL
skipping, UTF-8 character boundaries, newline/EOF/zero behavior and unread suffix
preservation. Keep the uncounted reader unchanged. Multiple destinations,
arrays, other read modes, terminal editing, timeouts and runtime work are outside
this unit. See [counted read](../docs/read.md) for the supported locale domain,
resource limits and unsupported byte sequences.

The native and production real-Waffle failing-first matrix has 124 mismatches
on the exact merged base; both final matrices match all 124 stdout/status pairs
and 123 including stderr. The closed-descriptor diagnostic remains different
and is not claimed fixed. The frozen ruler retains all 9,221 records, 5,792 scored
cases and all four identity hashes.
Measured memberships change Oils 967 to 972, Brush 958 to 961 and Bashkit 1,357
to 1,361: twelve gains and zero losses. Only those twelve records and derived
counts change in the baseline. Exact IDs and verification receipts are in
[read-count evidence](../docs/evidence/read-count.json); host logs and reproducer
are under `/work/reports/bash-web/hill-climb/read-count/`.

## Printf string fields, 2026-10-19

Status: Approved. Bounded implementation from exact main
`4b063eb5b839f93dc26ff2bc0508b8b8d86fa95a`; parent owns independent review,
CI monitoring and merge.

Add literal and star width/precision for `%s`, including valid string flags,
missing/reused operands and byte precision. Keep bare `%d`/`%b`, echo and all
other conversions unchanged. Borrow string bytes and stream space padding
through the existing printer's admission/delivery walks, with output/work
limits, fixed-size writes and cancellation. See
[printf string fields](../docs/printf-string-fields.md) and `sources.lock.json`.

Four production native and real-Waffle cases fail on the unchanged base. Four
new native regressions fail before implementation. The final focused matrix
matches all 167 Bash stdout/status observations on native and real Waffle.
Invalid numeric controls suppress diagnostics in both shells; the existing
adapter diagnostic prefix remains different from Bash's source-line annotation.

The full frozen real-Waffle measurement retains 9,221 records, 5,792 scored
cases and the exact oracle/environment/source identity. Memberships change
Oils 972 to 979, Brush 961 to 964 and Bashkit 1,361 to 1,366. There are fifteen
gains and zero losses. The normal `RECORD=0` gate passes with exact candidate
pass membership; all 9,206 other baseline records remain unchanged. Only these
fifteen records and derived counts change in the baseline. The 34-case discovery pool is not a promise of gains and
contains conversions outside this unit. Exact IDs, source cases and verification
receipts are retained under
`/work/reports/bash-web/hill-climb/printf-string-fields/`; the checked-in receipt
is [printf evidence](../docs/evidence/printf-string-fields.json).

Review fixes, 2026-10-20: the interrupted review exposed two numeric-star error
boundaries. A later `%b` `\c` must clear the earlier numeric status, and a rejected
numeric warning on closed stderr must not truncate stdout. Both failed first on
`916a761` in native and real Waffle. Four new native/WASI regression tests cover
these boundaries, repetitions, output/admission failures and warning cancellation.
The expanded matrix keeps all 222 cases and their raw diagnostics. Eight introduced
stdout/status mismatches are fixed, while seven disclosed bare `%d` cases and one
diagnostic source-line annotation case remain outside this unit. The three accepted narration comments
are deleted without changing `sources.lock.json` provenance.

Second diagnostic correction, 2026-10-20: two raw-byte regressions fail first at
`f9ca50f`. Star diagnostics now use the original spelling rather than the parsed
radix. Invalid suffixes take precedence over range warnings while preserving the
numeric fallback. Native/WASI tests assert exact stderr bytes and merged output;
production native/Waffle checks cover both width and precision. Prior stop-status,
closed-stderr, cancellation, stdout failure and admission controls stay enabled.

The 222-case comparator checks health, status and stdout only, with 214 matches.
It never normalizes or compares stderr. A separate source-line-only diagnostic
audit improves 206 to 213 matches, including stdout and status. The extra remaining
difference is the unchanged missing write-error message on closed stdout.
Complete raw stdout/status/stderr agreement remains 107/222 due to Bash's
source-line annotation. Seven bare `%d` defaults and the `2>&1` annotation case
remain outside scope. No oracle, fixture, score or exclusion is changed.

## Printf integer operands, 2026-10-20

Status: Approved. Bounded implementation from exact accepted main
`ca974e0facd8c578e483dee5433735f69eb5e620`. Parent owns independent review,
blocking CI, merge and acceptance. These are measured gains, not accepted gains.

Bare `%d` and `%i` now convert missing, signed, radix and quoted-character operands
to signed 64-bit decimal. Missing operands give zero without a warning; explicit
empty and malformed operands warn. Signed overflow saturates, while star counts
retain their distinct signed-32 limit and -1 fallback. Fixed-stack decimal output
uses the existing two-pass admission and cancellable chunked delivery. Numeric
fields and all other new conversions stay outside scope. See
[integer behavior](../docs/printf-integer-operands.md) and `sources.lock.json`.

Native and production real-Waffle failing-first controls match 6/147 strict
stdout/status pairs. The same controls now match 146/147, and the expanded matrix
matches 194/195 per target. Raw diagnostic comparisons remain separate. The
existing source-line annotation and closed-stdout write-error differences remain
disclosed in [integer evidence](../docs/evidence/printf-integer-operands.json).
Native/WASI targeted tests, unchanged printf/echo fixtures, prior string/star
controls and the unchanged duplicate/layer gates pass.

One complete frozen real-Waffle replay preserves 9,221 records, 5,792 scored cases
and all identity hashes. Oils changes 979 to 985, Brush 964 to 969 and Bashkit
1,366 to 1,367, twelve gains and zero lost passes. The replay saves all results
then exits 1 at the expected stale-membership assertion. After updating only the
twelve gained rows and derived counts, the unchanged strict membership check
passes offline against that saved replay. No full rerun or re-oracle is claimed.
All 9,209 other baseline rows remain unchanged, including 25 historical failing
payload differences. Exact case IDs, source pins, hashes and reproducer logs are
in the evidence receipt and `/work/reports/bash-web/hill-climb/printf-integer-operands/`.

## Printf unsigned and radix operands, 2026-10-20

Status: Approved. Bounded implementation from accepted main
`2b2b86b54c5b4824163731416a180c7a915096f7`. Parent owns independent review,
blocking CI, merge and exact-main acceptance. These are measured gains only.

Bare `%u`, `%o`, `%x` and `%X` now use the full unsigned-64 operand range.
Checked accumulation distinguishes exact maximum from overflow. In-range
negative input wraps; either overflow sign saturates to maximum. Signed-64 and
string-star signed-32 policies remain separate. A fixed 22-byte integer renderer
preserves two-pass admission, diagnostic ordering, cancellation and real I/O.
Numeric fields, floats, time, `-v`, locale and runtime changes remain outside scope.
See [unsigned behavior](../docs/printf-unsigned-radix.md) and `sources.lock.json`.

Failing-first native and real-Waffle controls match 55/446 strict stdout/status
pairs. The same scripts now match 444/446 per target. Raw stderr is retained and
checked separately; merged source-line annotations and the existing extra Bash
closed-stdout diagnostic remain disclosed. Nine new Rust tests pass on native
and WASI, alongside prior signed/string/star/echo and resource controls. Frozen
printf and echo fixtures, duplicate allowances and layer policy are unchanged.

One complete frozen production-Waffle replay preserves 9,221 records, 5,792
scored cases and every oracle/environment/source/case identity. It measures
Oils 985 to 996, Brush 969 to 975 and Bashkit 1,367 to 1,373, 23 gains and zero
lost passes. The complete saved replay exits 1 only at stale membership. After
updating those 23 gained rows and derived counts, strict membership passes
offline against the saved replay. No second full replay or re-oracle. All 9,198
other baseline rows stay unchanged, including 20 historical failing payload
changes that are deliberately not rewritten. Exact IDs, byte comparisons,
source/artifact hashes and unrun CI gates are in
[the evidence receipt](../docs/evidence/printf-unsigned-radix.json) and
`/work/reports/bash-web/hill-climb/printf-unsigned-radix/`.

## Printf integer fields, 2026-10-20

Status: Approved. Bounded implementation from accepted main
`fa9f07983fc2974404bc58493616757669148471`. Parent owns independent review,
blocking CI, merge and exact-main acceptance. This unit adds literal/star integer
width and precision and the `-`, `+`, space, `0` and `#` interactions. It shares
field/count parsing with strings and preserves signed-32 star versus signed and
unsigned-64 operand policies. Fixed digit storage and chunked padding retain
admission before delivery, cancellation and stream ordering. No floats, time,
locale grouping, `%c`, `-v`, dependency, runtime or architecture changes.
See [integer fields](../docs/printf-integer-fields.md).

Failing-first native and production-Waffle controls match 31/542 strict Bash
stdout/status observations per target, improving to 537/542 with raw stderr
retained separately. Ten new Rust tests pass on native and WASI alongside prior
signed/unsigned/star/string/echo and resource controls. Frozen printf/echo
fixtures, duplicate allowances and layer policy are unchanged.

One complete frozen production-Waffle replay preserves 9,221 records, 5,792
scored cases and all case/oracle/environment/source identities. It measures
Oils 996 to 1,002, Brush 975 to 983 and Bashkit 1,373 to 1,383, 24 gains and zero
lost passes. Its expected exit 1 follows the complete saved result and stale
membership assertion. Only those 24 gained rows and derived counts change.
The unchanged strict comparator passes offline against the same saved replay;
no second replay or re-oracle. All 9,197 other baseline rows stay unchanged,
including 18 historical still-failing payload differences. Production/test
source is frozen at 8b8ce95b3bfb04405eaa5c494eb7d883ee0b33fd. Exact gains,
hashes, comparisons, unrun gates and cleanup ownership are in
[the evidence receipt](../docs/evidence/printf-integer-fields.json) and
`/work/reports/bash-web/hill-climb/printf-integer-fields/`.

## Printf character conversion, 2026-10-20

Status: Approved. Bounded implementation from accepted main
`07ad8801561afe1a25457801bd52e1f490058c15`. Parent owns independent review,
hosted CI, merge and exact-main acceptance. These five gains are measured only.

`%c` now prints the first operand byte, not an integer code or Unicode scalar.
Missing and empty operands print a real NUL. Literal/star fields keep alignment,
argument consumption/reuse and count diagnostics; precision is consumed but
ignored for the character. Borrowed byte/static NUL and existing string padding
preserve admission before output, fixed buffering, partial writes and cancellation.
See [character behavior](../docs/printf-character.md).

Failing-first native and production-Waffle controls match 2/160 strict raw
stdout/status observations per target, improving to 151/160. Normalized stderr
is checked separately, 157/160. All five direct inventory cases match. Twelve
character tests pass; the native workspace, focused WASI tests, all-target
Clippy, frozen printf/echo fixtures and unchanged duplicate/layer gates pass.

One complete frozen production-Waffle replay preserves 9,221 records, 5,792
scored cases and all case/oracle/environment/source identities. Oils changes
1,002 to 1,003, Brush 983 to 986 and Bashkit 1,383 to 1,384. Five gains, zero
losses. The full saved result exits 1 only at the old strict membership check.
After refreshing those five rows and derived counts, strict membership passes
offline against the saved replay. All 9,216 other baseline rows stay unchanged,
including 16 historical still-failing payload differences. No repeated full
replay or re-oracle. Measured production and test source is commit
`5ce47589e53004944beb42a3ec7d9147feb7c555`. Later edits update evidence and
baseline memberships and remove redundant comments. Production code and test
assertions remain unchanged. Exact IDs, hashes, unrun gates and cleanup ownership
are in
[the evidence receipt](../docs/evidence/printf-character.json) and
`/work/reports/bash-web/hill-climb/printf-character/`.

### Finding outside this unit: invalid byte input

The parser already turns invalid ANSI-C byte escapes into Unicode U+00xx in
`shell/parser/src/parser/lexer.rs:2000`, `flush_escape_bytes`. Both native and
Waffle repeat this in C and C.UTF-8. Reproduce with
`LC_ALL=C; printf '[%c]' $'\xffZ'`. Bash stdout hex is `5bff5d`, the measured
shell gives `5bc35d`, both status 0. The parser passes `ÿZ` encoded as UTF-8 to
printf. Valid UTF-8 input still produces its raw first byte, as Bash does.
`after.json` and `targeted-audit.json` retain all six invalid-input controls per
target. This is not a numeric or scalar conversion problem in printf. A future
byte-preserving word representation needs its own bounded contract decision;
no runtime/parser rewrite or gain is claimed here. The mixed Brush basic3 case
also remains blocked on self-invocation and was not chased. Existing merged
source-line annotations and extra Bash closed-output diagnostics stay disclosed.

## Printf option boundaries, 2026-10-20

Status: Approved, implementation awaiting independent parent review and CI.

Consume one leading `--`, preserve a lone `-` and empty formats, and stop option
parsing at FORMAT. Missing formats, bare `-v`, and unknown options receive bounded
usage diagnostics and status 2. Both admission and delivery borrow the same
argument slice; the formatter and runtime contracts do not change. Supplied
`-v` and exact `--help` remain explicitly unsupported, with no fabricated
assignment or help output. See [behavior](../docs/printf-options.md) and
[measurement receipt](../docs/evidence/printf-options.json).

The existing utility integration control used `printf '-needle\n'` to feed grep.
Bash rejects that input as option `-n`. Its producer now uses `printf --` so the
unchanged grep output/status assertions test grep rather than printf's old bug.
No frozen fixtures, oracle, replay inputs or gates change.

An outer Bash wrapper waits on stdin before exec, then starts `printf -x` with
its OS stderr reader already closed. The native CLI still returns 2 instead of
Bash SIGPIPE, recorded in `closed-diagnostic-exec-gated.json`. Earlier
`closed-diagnostic-before.json` and `closed-diagnostic-after.json` used a read
inside the target, which was not a reliable native gate because standalone stdin
is null. Those remain historical observations only. The engine
closed-reader regression passes with 141 on native and WASI. In
`shell/engine/src/compat.rs:554-599`, the standalone adapter drives the job before
draining internal diagnostic pipes and interrupts on host write failure, which
can arrive after completion. No formatter defect is claimed for this remaining
adapter behavior, and no runtime work was added. A future adapter unit should
reproduce through `closed-diagnostic.ts` from the unit report and decide how host
write failures reach completed jobs.

One unchanged frozen production-Waffle replay at source
`fe57a8981db097a3969f237050d05b88aacb6de6` predates the accepted comment-only
delivery delta from source-reviewed `206bae6a271a7f924e59a0bfb7452e7ec86fd8c4`.
Only K1, K2, R1 and R2 comment spans change; executable, assertion and source-string
bytes remain unchanged. Original measurement hashes are retained separately from
delivery source hashes. No rebuild or second full replay ran. That replay measured
10 gains and zero losses,
with 9221 records, 5792 scored and 3429 skips. Oils 1003 to 1006, Brush 986 to
989, Bashkit 1384 to 1388. Only ten gained baseline rows and derived counts
changed. The strict unchanged comparator passes offline against that saved
result. The cumulative measured gain is 140, pending parent acceptance. Two
additional negative `-v` cases pass stdout/status because unsupported-operation
rejection returns 2, `oils:builtin-printf:76` and
`bashkit-suite:bashbox-declare:354`. Their diagnostics differ from Bash. They do
not establish variable-name validation or assignment support. The mixed help
record remains failing.

### Unresolved compatibility timeout evidence

Status: Approved. PR34 push run 39486769464 timed out on consecutive scored
ordinals 4260 through 4263 in the unchanged four-worker pool and 10-second case
deadline. These include two prior passes, UTF-8 lines 49 and 72, and two known
failures, UTF-8 line 56 and word-expander line 5. Run 39486886987 succeeded with
the identical Git tree. This does not establish a pre-existing defect, a flake,
or a resolved failure. The 2,490 completed local candidate/base probes had no
timeouts. The incomplete local OOM probe does not explain hosted CI. Parent
subsequently verified all ten jobs across push 39491917246 and PR run 39491923353 succeeded
at exact 790ccad. That is CI status, not a diagnosis of the earlier stall.

`scripts/diagnose-compat.ts` observes the existing `npm run compat:shell` command
from a separate Linux process. It inherits all three standard streams and the
unchanged environment. It does not import the runner, replace Workers, inject
hooks, set Node flags, add a case deadline, or replay cases. The workflow runs
its isolated controls once and uploads its trace directory in the existing
`own-shell-current` artifact, beside the unchanged scored result.

The bounded trace retains `host.jsonl` and `host.previous.jsonl`, each at most
16 MiB. Read both by `ms`, then align `utc` with the existing job log's
`[bash-compat] own-shell: N` progress. Each one-second snapshot includes process
and thread birth ticks, CPU ticks, RSS/high-water/swap in KiB, task state, kernel
wait channel, scheduler runtime/wait/timeslices, context switches, faults and
host CPU/memory/pressure counters. `wchar` and `syscw` count host writes, not
completed cases or guest output. No command lines, environments, process names,
file contents or guest output are retained. Caps and omitted counts are explicit.
Sampler gaps and observer CPU/RSS distinguish observation delays from child
counters. Short-lived threads between snapshots remain unobserved.

Increasing thread CPU with little scheduler wait supports active computation;
flat CPU with increasing scheduler wait supports host contention. Flat CPU and
parked threads supports blocked work. Thread disappearance/replacement bounds
host lifecycle changes. None of these signals alone identifies a guest loop,
GC, case dispatch, or disposal. In particular, frozen code publishes no case or
runtime phase events. Attributing dispatch versus disposal, or proving GC,
remains blocked without an explicitly allowed internal observation mechanism.
The former probe's replaced Worker/runner cannot supply that evidence for the
frozen ruler. Do not infer phases from empty scored output.

The observer forwards SIGINT/SIGTERM to its owned detached command session,
returns the command's exit code or terminating signal, and stops remaining
session members after the command exits. Birth ticks guard signal delivery.
Isolated controls cover success, status 37, timeout 124, SIGINT, SIGTERM,
SIGKILL of the child, stopped-task detection, fast-parent/reparented-descendant
cleanup, spawn failure and trace rotation. No runtime or guest runs in those
controls. An unavailable trace destination does not skip the command or replace
its status. A null `cleanup.remaining` means the cleanup scan failed, not that no
processes remained. They do not prove cleanup after an uncatchable SIGKILL of the observer
or for commands that deliberately escape into a new session. There is no new
cancellation deadline imposed on the scored command. Missing terminal
`exit`/`cleanup` records mean incomplete evidence, not successful cleanup.

The original saved measurement and strict offline comparator remain the only
measurement evidence. New diagnostics require independent source review and a
narrow workflow/lifecycle review before parent acceptance. No semantic repair
or compatibility gain is claimed by this diagnostic change.

## Printf shell quoting, 2026-10-21

Status: Approved, implementation and one frozen measurement finished. Parent owns
independent review, hosted CI, merge and exact-main acceptance. This is review-ready,
not accepted or merged.

Implement `%q` and `%Q` inside the existing formatter, with byte-counted width,
precision, stars, alternate quoting, argument reuse and named/octal escapes.
No parser/runtime changes or dependencies.
See [behavior and boundaries](../docs/printf-quoting.md) and
[measurement receipt](../docs/evidence/printf-quoting.json).

### Remaining classifier and byte-input boundaries

The actual Waffle target's pinned WASI libc classifies unassigned U+0378 as
printable. Native GNU libc and Bash classify it as nonprinting. Reproduce with
`LC_ALL=C.UTF-8; printf '[%q]' '͸'`. Bash stdout hex is
`5b24275c3331355c323730275d`, while Waffle emits `5bcdb85d`, both status 0.
The helper's character classifier is in
`shell/engine/src/builtins/printf/quoting.rs`. All 16 affected width/precision/
alternate controls are retained in `after.json` under
`/work/reports/bash-web/hill-climb/printf-quoting/`. This unit does not introduce
a replacement Unicode table or a locale architecture. A later classifier unit
must choose a portable printability contract and measure table differences first.

The earlier invalid-byte word-decoding finding still applies to `%q`.
`LC_ALL=C.UTF-8; printf '%q' $'\xff'` produces `c3bf` instead of Bash's
`24275c33373727` because the lexer has already replaced byte `ff` with U+00FF.
The formatter cannot reconstruct that byte without guessing. Controls preserve
this mismatch; no gain or byte-preserving input support is claimed for it.

The earlier four-case compatibility CI stall remains unresolved. Its Approved
finding and unchanged observer/command above are preserved. No CI diagnosis or
infrastructure change is part of this unit.

### Measured result

Measured source `e050d54ae26c54ba3af9da72ee6186f05914d82d`, accepted base
`46a6bb090e1bdcc3d447bc2c70a3a7f4c72fd4b4`. Exactly one production-Waffle
replay, JOBS=1 and RECORD=0: 9,221 records, 5,792 scored, 3,429 unchanged skips.

- oils: 1006 -> 1012, gained 6, lost 0.
- brush-suite: 989 -> 1001, gained 12, lost 0.
- bashkit-suite: 1388 -> 1404, gained 16, lost 0.

Only 34 proven gained rows and derived baseline counts change. Every other
baseline record retains its historical payload. The unchanged strict comparator
passes offline on the saved replay. Oracle, cases, environment, source pins,
exclusions, scorer, fixtures, deadlines and blocking gates are unchanged.
Raw stdout/status define scores; stderr is retained but unscored.

Full native workspace tests and native/WASI all-target Clippy pass. Focused WASI
checks pass 102 printf, 10 echo and two memory-budget tests. Unchanged printf
fixtures pass 1,122 each on native and actual Waffle; echo passes 492 each.
Fifty I/O/admission/closed-descriptor controls pass. Four quoting regressions
failed first; all 14 new tests now pass. See the receipt for exact commands,
artifacts, version-only rebuild correspondence, retained raw differences and
skipped local checks. Parent owns independent reviews and all hosted gates.

### Closed-stdout printf diagnostics, 2026-10-21

Status: Approved, separate shared-Printer repair. Not fixed by the quoting unit.
At reviewed `8242cd0125b0c40526728ac88dacd384ba2f358f`, independent review
reproduced missing stderr for `printf '[%q]' 'a b' 1>&-` and
`printf '[%.0q]' x 1>&-`. Both Bash and the native shell return 1 with empty
stdout; Bash emits `/usr/bin/bash: line 1: printf: write error: Bad file descriptor\n`,
while the native shell emits no stderr. The reviewer also reproduced ordinary
`printf '%s' x 1>&-`; the fix lane independently repeated all three controls
with the retained measured native binary, with the same results.

Reproduce each source with `/usr/bin/bash -c "$source"` and
`/work/tmp/bash-web-printf-quoting/target/release/shell-cli -c "$source"`.
The latter measured binary has SHA-256
`b02f86cc46a818d7cd40c2d95bbc120ee1c7ec4f2c4a87a38940860404feef6e`.
Review records and exact stderr hex are in
`/work/reports/bash-web/hill-climb/printf-quoting/review-r1-native.json`;
controls reproduce on every one of the three reruns, not intermittently.
Inspect `Printer::flush_output` at `shell/engine/src/builtins/printf.rs:230-236`,
its shared `write` error handling and the final flush/status propagation.
Those paths are unchanged by this PR. This rules out a quoting-only failure,
not the bug's age or root cause. Repair and test ordinary `%s`, `%q` and `%Q`
in a bounded follow-up. Stderr is retained but not part of the frozen score.

### Darwin quoting review fix

Review found the Apple locale mask selected messages rather than character
classification. The narrow correction uses Darwin's `LC_CTYPE_MASK = 1 << 1`,
`en_US.UTF-8` and the declared `int` return from `freelocale`. A Darwin-only
regression queries the initial process C locale, exercises actual `%q`/`%Q`
UTF-8 output, then checks that locale again without changing it. A path-filtered
hosted macOS gate confirms that locale name exists and runs the quoting tests.
Local Mac Mesh and documented SSH recovery were unavailable before setup.

The original one-replay result above remains historical. The later delivery's
Linux/WASI active production source matches the reviewed source after comments
are removed and actual rustc target cfg expansion. The unchanged comparator
still accepts the saved replay; no new gain, second replay or Darwin execution
is inferred from those checks. See `review-fixes-r1.md` in the report directory
for separate hosted Darwin results and current delivery/source correspondence.

The first actual hosted Darwin run, `39515015387/job/118944969036`, compiled
successfully and passed 14/15 quoting tests, including initial-C-locale `%q`/`%Q`.
Its sole failure was the GNU-specific Unicode expected output at
`printf_quoting.rs:126`. Darwin escaped U+00AD, U+200B and U+FEFF while leaving
U+2028 literal; the retained GNU expectation did the reverse. The narrow test
correction preserves the non-Apple expectation and checks the recorded Apple
expectation against direct native `iswprint_l` classifications. Native Bash
3.2.57 emits a distinct byte-level quote representation; its captured output
and round-trip check are independent observations, not the GNU 5.3.15 oracle. No skip, filtered assertion, portable Unicode
table or scoring change is included. Raw first-failure and follow-up logs stay
in the report directory under `review-fixes-r1-darwin*`.

## Printf scalar assignment, 2026-10-21

Approved.

Measured source `286dd4cd0bc59410bda90348992044812a208dd3`, accepted base
`50ab6a7f3cdf6c4c7a7e1ad875d4e804e76da5fd`. Plain and attached `printf -v` capture
through the existing two-pass formatter, then use existing scalar bindings for
dynamic locals, namerefs, readonly and IFS. No stdout writes occur. Capture and
assignment storage remain budgeted and cancellable. NUL output shrinks to its
stored prefix; invalid UTF-8 before NUL returns 2 without replacing the old value.
No array lvalues, attributes, float/time formats or parser/runtime changes.
See [behavior](../docs/printf-scalar-assignment.md) and
[the measurement receipt](../docs/evidence/printf-scalar-assignment.json).

Exactly one full production-Waffle replay, JOBS=1 and RECORD=0, retained all
9,221 records, 5,792 scored and 3,429 unchanged skips. Waffle stays pinned to
`fc58a532f0d7a617e631ea4b7580a190915d4ed6`.

- oils: 1013 -> 1015, gained 2, lost 0.
- brush-suite: 1001 -> 1007, gained 6, lost 0.
- bashkit-suite: 1406 -> 1412, gained 6, lost 0.

Only actually gained outcome fields and derived baseline counts change; all
historical payloads remain. The unchanged strict membership comparator passes
offline against the saved replay. Cases, oracle, environment, source pins,
classification, scorer, fixtures, deadlines, exclusions and blocking gates stay
unchanged. Full evidence and reproducer are in
`/work/reports/bash-web/hill-climb/printf-scalar-assignment/`.

Native/WASI Clippy, native workspace and selected WASI suites pass, including
113 printf and 9 echo word tests per target and existing low-memory controls.
The real-Waffle controls pass 29 Bash comparisons and four explicit boundaries.
Scoreboard controls pass 107/107. Quality, unchanged duplicate gates and layer
checks pass, with zero layer violations. Browser verification passes 228 tests
with 16 existing skips in Chromium/Firefox, plus 143 runtime-terminal tests.
No local Darwin claim; the unchanged hosted gate remains parent-owned.

### Review fixes after the full measurement

Source `c29fab56685afceadc7449e7b2e15f59b7ca3aed` fixes the closed-stderr
PR37 review finding. Capture-mode malformed escape warnings tolerate a closed
stderr without losing assignment. Cancellation and broken pipes still abort.
Its indirect-IFS cache approximation was incomplete and has been removed under
the approved parent decision. Printf now uses `State::assign_parameter`, exactly
as ordinary scalar assignment does. Resolved IFS writes refresh the ordinary
derived caches from the new value. This is safe semantics, not a claim of Bash
equality for the confirmed nondeterministic cases. Fresh independent review and
hosted compatibility remain required.

Historical c29fab5 checks used source different from the full replay's measured
source above. Native and WASI focused tests and Clippy passed. Its production-Waffle
controls passed 44 Bash comparisons and four explicit boundaries. Its separate
bounded check passed all 392 committed passes in the printf, nameref, IFS and
word-split files plus the historical gains, including all 14 gains. Historical
follow-up evidence is
`/work/reports/bash-web/hill-climb/printf-scalar-assignment/review-fixes-r1.md`.

Final safe-IFS production-Waffle evidence records 62 controls: 45 stable Bash
comparisons, four preserved boundaries and 13 declared-safe controls. Its separate
bounded check passed 392 committed passes, including all 14 historical gains.
Neither stage changes membership or scorer. No second full replay ran, and the
historical 14 gains and zero losses are not claimed as a complete measurement of
the final source. Final evidence is
`/work/reports/bash-web/hill-climb/printf-scalar-assignment/safe-ifs-r3.md`.

### Finding retained at the existing builtin-prefix boundary

At the measured source, run
`x=outer; x=prefix printf -v x %s assigned; echo "$x"` through the production
Waffle control in `scripts/test-own-shell-printf-assignment.ts`. Bash 5.3.15
prints `assigned\n`; this shell prints `outer\n`, both status 0 with empty
stderr. This reproduces every run. The control logs both raw byte observations
in `final-controls.log`. Ordinary scalar assignment, nested local scope and
nameref assignment pass their Bash comparisons; the discrepancy requires a
temporary command prefix.

`PrefixFrame::builtin` in `shell/engine/src/state.rs` keeps private restoration
saves and its drop restores them. `State::assign_parameter` updates expansion
saves, not builtin saves. There is no selective durable-write operation for the
builtin guard. A follow-up should give the guard
an explicit way to retain a builtin's successful writes, with admission,
cancellation, readonly, local/nameref and IFS tests. None of this unit's eleven
candidate observations uses a temporary command prefix. Invalid UTF-8, arrays
and unsupported conversions remain separately named boundaries, not scored gains.

### Indirect-IFS review blocker

The original PR37 review blocker 2 concerns supported ASCII scalar, nameref
and IFS behavior, not an exclusion or a deferred feature. The approved safe
assignment decision below addresses the production design, not the original
review verdict or final acceptance. The initial three observations
recorded one Bash result, `<a:b;c>\n`, for the following custom-prior case.
The starting PR37 source printed `<a>\n<b>\n<c>\n`; source c29fab5 printed
`<a>\n<b;c>\n`. Those raw results remain in the report directory.

```sh
IFS=:; declare -n ref=IFS; printf -v ref ':;'; set -- 'a:b;c'
for y in $1; do echo "<$y>"; done
```

The continuation repeated identical commands 1,000 times with the same Bash
5.3.15 binary and explicit `PATH`, `LC_ALL=C` and `LANG=C`. The exact original
default-IFS review reproduction produced five distinct stdout values. The
custom-prior case above produced eight. An empty prior IFS produced seven;
an alias-chain and changed-separator case produced 21. Unset prior IFS,
direct printf-to-IFS and ordinary nameref assignment controls each produced
one stable result. All returned 0 with empty stderr. The source, per-output
counts and raw base64 streams are in `ifs-exact-repeat.ts` and its log under
`review-fixes-r1-evidence/`. An earlier 84-case matrix and 24-by-100 repetition
probe cover additional prior values and separators there.

A debugger trace of the actual installed binary confirms that
`builtin_bind_variable` frees the buffer still referenced by `ifs_value` during
printf assignment. At the next `list_string` call the separator argument is
that same freed address, now containing different bytes. This happens for
default, custom and empty prior IFS. Unset IFS instead references a stable
default literal. `ifs-free-argument.log` retains the trace and binary identity.
The inspected GNU Bash 5.3 source explains the path: printf refreshes special
variables using the requested alias name, while the variable owner frees the
resolved IFS value. The splitter retains a borrowed pointer, a byte map and a
separately copied first separator.

The parent approved normal resolved scalar assignment in
`/work/reports/bash-web/hill-climb/printf-scalar-assignment/parent-ifs-decision.md`.
The PR37-specific old-member-map and old-`$*`-separator restoration are removed.
`State::assign_parameter` resolves the destination, enforces readonly/storage
rules, updates the one binding and refreshes IFS-derived state from the new value.
Existing local and prefix guards retain their ordinary scope restoration rules.
Focused tests declare safe splitting and `$*` semantics for default, custom,
unset and empty priors, alias chains, changed and empty separators, and local
scope restoration. They do not compare nondeterministic Bash output. Stable
direct-IFS and ordinary nameref writes remain separate Bash equality controls.
No majority-output choice, allocator emulation, frozen-ruler change or scored
failure waiver follows from this decision. The original review and all raw
observations above remain retained. Final source checks and cleanup are in
`/work/reports/bash-web/hill-climb/printf-scalar-assignment/safe-ifs-r3.md`.
Historical replay and 14 gained memberships remain unchanged.

## Escaped printf fields, 2026-10-21

Approved bounded unit. Review-ready, not merged or accepted. Parent owns final
membership and PR-body audit, hosted gates, merge and exact-main acceptance.

`%b` now applies width and alignment to decoded bytes, with space padding for the
zero flag. The borrowed counting walk reuses the existing decoder, reports escape
diagnostics once and preserves byte precision, whole-command `\c` stop, scalar
capture and chunked output. Literal width or precision overflow recovers as zero
only for `%b`. Bare `%b`, ordinary `%s` and the runtime remain unchanged. The parent
closed the independent literal-precision finding after reviewing the exact fix
and raw native/Waffle before-and-after controls.

Exactly one frozen production-Waffle replay measured immutable
`ec8b801c8ded5ada99d9be9edc847ff856936ad3` against accepted main
`6f292e1ecafdb0f1638860092d0f4e96722480ac`. It preserves all 9,221 IDs,
classifications, exclusions and frozen identities, with 5,792 scored and 3,429
skipped. Measured changes are:

- Oils: 1,015 unchanged, no gained or lost pass.
- Brush suite: 1,007 to 1,008, gained `brush-suite:builtins/printf:34`, lost zero.
- Bashkit suite: 1,412 to 1,413, gained `bashkit-suite:bashbox-printf:132`, lost zero.

No nonpass outcome changed. Twenty-five failure payloads differ from historical
observations without changing their fail outcomes. The report retains those
observations, and the baseline preserves every historical payload. Only the two
proven gained memberships and derived counts change. The original replay exits 1
because the strict comparator rejects those new passes after saving the complete
result. That unchanged comparator then passes offline on the same saved result.
No second full replay ran.

Exact-source focused native and WASI printf checks each pass 138 tests. Production
printf/scalar checks pass 98 tests. The two candidates, 12 preservation cases,
25 nearby probes and 14 review-finding controls match Bash on native and Waffle.
Quality and layers pass. After updating membership, the scoreboard suite passes
172 tests. No runtime pin, deadline, exclusion, migration rule or blocking gate
changed. Root is 0.0.74, engine 0.0.42, Vite 8.3.3 and Waffle remains `fc58a532`.

See [the behavior notes](../docs/printf-escaped-fields.md) and
[measurement receipt](../docs/evidence/printf-escaped-fields.json). The complete
saved replay, original exit, before-and-after controls, offline comparator and
cleanup receipt remain in `/work/reports/bash-web/hill-climb/printf-b-fields`.

## Builtin-wrapper review follow-ups, 2026-10-21

Approved future work, separate from the bounded wrapper repair. At immutable
`e0a44aa8fe135713a2773cc46ddb660a395db1ec`, the independent observations in
`/work/reports/bash-web/hill-climb/builtin-wrapper/review-r1/followup-results.json`
reproduce these inherited failures on each recorded run. The wrapper is not the
first owner of either behavior.

- Readonly prefixes abort the submitted sequence. Reproduce with
  `readonly v=old; v=new echo target; echo rc=$? v=$v`, and compare direct `echo`,
  `command echo`, `builtin echo` and unknown `nocmdq` targets from that JSON.
  Bash prints `target` then `rc=0 v=old` for the echo forms, diagnoses the readonly
  binding on stderr, and continues. Native and production Waffle stop at the
  diagnostic with status one and no stdout. Suspected owners are prefix assignment
  admission in `shell/engine/src/interpreter.rs:3366-3432` and `expansion_failure`
  at lines 1902-1926 of that immutable source. Distinguish prefix failure from
  fatal expansion failure without changing ordinary readonly assignment rules.
- Production Waffle treats inherited stdin as a writable diagnostic endpoint.
  Reproduce `printf -z 2<&0; echo rc=$?` with empty inherited stdin. Bash and native
  print only `rc=2`; Waffle emits the usage diagnostic on stdout before that line.
  The direct printf control rules out new wrapper dispatch as the cause. The
  here-string variant `printf -z <<< x 2<&0; echo rc=$?` does not reproduce it.
  Inspect the host-descriptor bridge at `shell/engine/src/runtime.rs:730-736` and
  `runtime/wasi.rs:362-363` at that checkpoint, then the pinned Waffle host owner.
  Endpoint rights must be proved on the actual descriptor, not inferred from open
  success. A complete host-side root cause has not been established. Runtime/FS
  fixes and pin changes are outside this wrapper unit.

R1 execution-diagnostic provenance also remains blocked. Keep lexical
`expansion_line` unchanged and retain the exact diagnostic captures in
`/work/reports/bash-web/hill-climb/builtin-wrapper/repair-r1-red-review32.json`.
The repair progress file records the proposed owning data shape and additional
Bash-only function/assignment controls. No line offset or prose waiver resolves it.


## Builtin diagnostic coordinates, later family

Status: Approved, later. Dispatch-only extraction is not R1 coordinate clearance.
No `Context::diagnostic_line` ships here. Getopts' exact binding-prefix checks
`root-invalid`, `root-readonly`, `nameref-readonly`, `function-invalid` and
`eval-invalid` remain blocked. Preserve
`/work/reports/bash-web/hill-climb/builtins/getopts/binding-diagnostics-pending.json`
verbatim. Their expected Bash lines are 3, 3, 3, 2 and 3. Ordinary option errors
stay prefix-free. Retain getopts review controls p19, p23, t05, t08 and q06.

The stopped provenance implementation begins at `6d84037`; its failed r6 head is
`0253be66210bf88475730134d2e89d640908676b`. Do not add another endpoint switch.
Establish separate Bash reader, function-definition, redirect-expansion and
conditional-construction ownership from source before changing metadata. A lexical
expansion hint, constant fallback or empty getter cannot fulfill that contract.
Preserve accepted main's canonical existing-expansion line-1 limitation until the
later family's own decision changes it, even though Bash reports line 2.

Keep R1a through R1d, conditional20, physical3, reduced function4, the broader r5
failures and r6 inner/caller mismatch. Exact evidence under
`/work/reports/bash-web/hill-climb/`:

- `builtin-wrapper/review-r1/{targeted,followup}-results.json`, including
  `retained-extra-2`, assignment versus argument, functions and existing writers.
- `builtin-wrapper/provenance-review-r2/{main,followup}-results.json` for lazy
  operands, compound headers, heredoc delimiter endpoints and function connectors.
- `builtin-wrapper/conditional-repair-r4/{extra-red,extra-green}-results.json`
  and its complete conditional control set.
- `builtins/wrapper-review-r4/{main,review,discriminators}-results.json`.
- `builtins/wrapper-redirect-review-r5/{review,function,main}-results.json`.
- `builtins/wrapper-function-repair-r6/{first-candidate-cases,first-candidate-results,prior-results,conflicting-probes}.json`,
  `first-candidate.patch` and `first-candidate.json`.
- `builtins/wrapper-dispatch/deferred-coordinate-tests.rs`, the exact old tests,
  and the new unprojected 207-script outcomes, including lost unaccepted matches.

Minimum discriminator, including its initial blank line:

```bash

f() {
:
} > "$(builtin redir)out"
f
```

Bash/prior84 report line 2; r5 reports line 4, with empty stdout and status 0.
`f 2>&1` puts the difference in stdout. R6 repairs these but still reports redir
line 3 instead of 2 in this case:

```bash

f() {
[[ "$(builtin body)" == "a
b" ]] > "$(builtin redir)out";
}

f
builtin after
```

Bash's ordered stderr is redir2/body4/after8. R6 is redir3/body4/after8; empty
stdout, status1. `r5-function-child-reader-does-not-leak` also emits an extra
caller redirect diagnostic in r6. Keep that complete-output difference, not a
passing decimal projection. The next worker must preserve every accepted-main
pass and run the unchanged frozen ruler. Earlier unmerged matches are evidence,
not accepted baseline memberships.

## Getopts caller-local dynamic unbind, 2026-10-21

Status: Approved. Owner: Variables track for general dynamic scope/unbind
semantics, coordinated with BUILTINS for the getopts caller. This is a separate
follow-up, not part of the bounded scanner repair.

Independent getopts repair review r3 retained an inherited caller-local OPTARG
limitation as `F2-caller-local-error`. Run the exact script with Bash 5.3.15 or
the production Waffle shell:

```sh
OPTARG=g; g() { getopts a o x; echo "g:${OPTARG-unset}"; }; f() { local OPTARG=l; readonly OPTARG; g; OPTARG=after; echo "f:$OPTARG"; }; f; echo "global:$OPTARG"
```

Bash prints `g:g\nf:after\nglobal:after\n`. Reviewed shell source
`339a5b9e635637ffd9734e889d43a1bf3186bc34` prints
`g:unset\nf:after\nglobal:g\n` on both native and real Waffle. All three return
status 0 with empty stderr. Exact script and raw observations are the
`F2-caller-local-error` records in
`/work/reports/bash-web/hill-climb/builtins/getopts-repair-review-r3/native.json`
and `waffle.json`; disposition and source inspection are in the adjacent
`report.md` and `RESULT.json`.

The current direct getopts unbind removes the visible value but does not reveal
the outer binding when the removed local belongs to a caller. Inspect
`State::unset_getopts_argument` and local-frame restoration in
`shell/engine/src/state.rs`. The prior helper had the same visible-value removal
policy; this is not a new scanner-repair regression. Define general dynamic
unbind/restoration semantics with the Variables owner, then cover caller-local,
current-local, readonly, nameref and function-return behavior. Keep the exact
Bash/native/Waffle control nonpassing until that contract lands. Do not add a
getopts-only scope rewrite, change score inputs or claim full dynamic-unbind
parity for the current scanner PR.

## Input-only substitution and inherited file aliases, 2026-10-21

Approved bounded command-substitution family. Typed parser metadata distinguishes
Bash's eligible `$(<file)`/legacy backtick shortcut from ordinary redirect-only
commands. The file capture expands its filename in caller state and reuses the
bounded decoder, while normal substitutions retain their streaming supervisor.
See [behavior, tests and provenance](../docs/file-substitution.md).

Measured source `3a0268b52d6a643ec7326d376d8746138d7f49c9` completes one frozen
production-Waffle replay with JOBS=1 and RECORD=0. All 9,221 records, 5,792
scored cases, 3,429 skips and four frozen identities are unchanged. Oils stays
1,015. Brush gains two cases, 1,008 to 1,010. Bashkit gains five, 1,413 to 1,418.
Every corpus loses zero passes. Only seven outcome fields and derived counts
change; all historical payloads remain. The unchanged strict comparator accepts
the saved replay after that update. Exact IDs, source/artifact hashes and checks
are in [the receipt](../docs/evidence/file-substitution.json).

Native/WASI workspace checks pass 1,311/1,291 tests. The 111 production controls
include 110 Bash stdout/status comparisons and one explicit invalid-UTF-8
boundary. Runtime tests pass 143, and both browsers pass 228 active cases with
the same 16 existing skips. The scoreboard suite now includes the new production
controls; its complete 283-test selection and the nine CI-recipe assertions pass.
Independent parent review, hosted CI, normal integration and exact-main
verification remain required.

### Separate follow-up: independently reopen regular-file descriptor aliases

Historical finding, addressed by the bounded adoption below. Its local-buffer
exception remains an Approved follow-up, not full alias-removal parity.

Approved separate CONTROL family after the Waffle owner supplies an actual
merged independent-reopen contract. Do not block the bounded shorthand family
on it, change the shared I/O helper here, add path blacklists or restore offsets
by guessing. Preserve pipe/terminal sharing and all current frozen passes.

Exact reproduction: `printf 'one\ntwo\n' >f; exec 3<f; x=$(</dev/fd/3); IFS= read -r y <&3; printf 'x=<%s> y=<%s>\n' "$x" "$y"`.
GNU Bash 5.3.15 prints `y=<one>`; before adoption, both the native candidate and
production Waffle printed `y=<>`, all status 0. Replacing the shorthand with
`$(cat </dev/fd/3)` reproduces the same production mismatch. Observed once per
form in the bounded probe; the source behavior is deterministic.
The old `io.rs::device_endpoint` returned the identical endpoint, so reads consumed
the inherited regular file offset. At that pin neither `FileSystem` nor
`HostEndpoint` exposed independent reopening. This rules out the new capture decoder as the
cause. Evidence and exact script are retained in
`/work/reports/bash-web/hill-climb/control/file-substitution/fd-observation.json`;
no worker, route or container is retained. Root accepted this boundary and routed
the runtime contract to Waffle. The bounded adoption below first reproduces both
forms, tests fresh regular-file offsets versus shared pipes/terminals, preserves
cancellation and lifetime ownership, then replays the unchanged frozen ruler.

## Waffle descriptor paths and retained here-input boundary, 2026-10-21

Approved adoption of exact Waffle 0.0.63 pin
`c4111d15f28bd1db9e5c2ef5d08c6ff1e6477289`, from actual main's 0.0.58 pin
`fc58a532f0d7a617e631ea4b7580a190915d4ed6`. Translate logical shell fds through
`Endpoint::runtime_fd`, then use real `path_open`; do not clone regular host
endpoints. Native MemoryFs reopens use the same inode with a new description in
its owning I/O implementation. This adoption adds no generic I/O trait, export
pump, producer/session owner or compatibility fallback.

### Approved follow-up: remove the remaining local buffer alias boundary

The follow-up is not implemented in this bounded adoption. The source boundary is
`io.rs::Open::Bytes`, `buffered_source`, `export_buffer` and `reopen_descriptor`,
plus the existing runtime child-export machinery. Unexported buffers share their
cursor; exported buffers use an actual host pipe. Native local pipes deliberately
duplicate their shared description, capture/null fixtures remain local, and opaque
Host endpoints without `runtime_fd` return Unsupported. Native regular endpoints
are no longer aliases. No copied data, fabricated offsets or metadata stand in for
an independent regular-file reopen.

Exact Bash 5.3.15 versus production Waffle reproducer, with N=3 and N=65536 and
both a here-document and the equivalent `<<<"$payload"` here-string:

```python
# Generate the exact guest script. Use N=3 or N=65536.
N = 65536
body = '{ IFS= read -r x </dev/stdin; IFS= read -r y; printf "%s:%s\\n" "${#x}" "${#y}"; }'
payload = "x" * N
print(body + " <<'END'\n" + payload + "\nlast\nEND")
# Here-string alternative: print(body + " <<<'" + payload + "\nlast'")
```

For an exact generated script without relying on shell interpolation, the retained
`/work/reports/bash-web/hill-climb/control/waffle-reopen/buffer-controls.ts` builds
`{ IFS= read -r x </dev/stdin; IFS= read -r y; printf '%s:%s\n' "${#x}" "${#y}"; }`
followed by `<<'END'`, N literal `x` bytes, `last`, `END`, each on its own line.
Its here-string form appends `<<<'` plus N literal `x` bytes, newline, `last'`.
The report's JSON contains all eight Bash/production observations.

After export, replace that body with
`{ cat /dev/stdin >copy; if IFS= read -r x </dev/stdin; then printf 'next=%s\n' "${#x}"; else printf 'EOF\n'; fi; IFS= read -r y <copy; printf 'copy=%s\n' "${#y}"; }`.
Short input gives `EOF` then `copy=3` on both. Large input gives `next=65536`
then `copy=65536` on Bash, but `EOF` then `copy=65536` on production Waffle.
This proves actual post-export pipe sharing, not large here-input parity.
The committed production controls retain both sizes and both here-input forms.

Removal condition: a separately authorized bounded design must give buffered
here-inputs Bash's actual reopen identity, offset and lifetime behavior before and
after export, without copied snapshots or invented metadata. It must preserve
actual pipe sharing, process/session cleanup and every frozen individual pass.
Until then, only production host-backed regular-file paths are the gain claim.
See [descriptor contracts and consumer audit](../docs/descriptor-reopening.md).


### Adoption measurement and landing gate

Status: Approved, final integrated replay qualified on 2026-10-22. Parent owns
hosted CI and landing; this is not merged completion. Root's explicit
CONTROL48-then49 grant supersedes all older PR50 holds.

Measured production source `d7009e1afbdc06cd29ebb52dc78c97a2326154e3` normally
merges exact main `4bf6a474ef6bb32dd5de44c1b6d30a300a079d93`, including PR41.
No Rust semantic conflict required manual resolution. Patch versions, the exact
combined scoreboard recipe, derived layer receipt and plan text were resolved;
parent independently accepted the integration delta.

Both ordinary redirects and `interpreter/file_substitution.rs` use the same
logical-to-physical helper. Independent R2 review found one omitted consumer:
grep operands opened directly against the utility's physical WASI table.
`printf 'secret-stdin\n' | grep secret /dev/fd/4` printed private stdin data
and returned 0, while Bash 5.3.15 returned 2 without stdout. Grep now uses the
existing typed opener and returns 2 without leaking data. Its operand error,
quiet-success and cancellation policies remain intact. No generic API changed.
R3 independently approved that repair at `e9740d8`; adoption code is unchanged.

The final production-Waffle replay preserves all 9,221 records and every outcome
against immutable integrated main. Oils/Brush/Bashkit stay 1154/1120/1554;
gained=[], lost=[] and newlyFailing=[] in every corpus. Official validation and
membership comparison pass. Baseline bytes and historical failure payloads are
unchanged. The oracle includes 16 descriptor-path cases, with 10 passes preserved,
four frozen skips and two unrelated failures. See the
[measurement receipt](../docs/evidence/waffle-descriptor-reopening.json).

Native/WASI suites pass 1,438/1,418 tests, production controls pass 154, the exact
combined scoreboard recipe passes 710, CI tests pass 105 and runtime controls
pass 145. Chromium/Firefox pass 234 browser cases with 16 unchanged skips.
Foreign-format errors survive Restart without wiping the sentinel; SAFE never
falls back. Both ordinary redirects and the file-substitution shortcut pass
host-fd translation controls. All eight short/large here-input observations are
unchanged. Rust, JS quality, typecheck, capability, guest and layer gates pass,
with zero violations and 42 production/30 test-only edges. Only documentation and
evidence change after the measured source. The Approved local-buffer follow-up
above remains required before full alias removal. No new runtime/export contract
was added, and no skipped case is counted as a gain.

## Scalar parameter transformations, 2026-10-21

Approved bounded unit, implemented by Claude after a Sol provider refusal. Review
stays on Sol; the expansion track owns review, merge and exact-main acceptance.

`${name@op}` now supports Q, E, u, U, L, K, k, A and a on scalar, nameref, `$?`
and positional names, in the new `expand/transformation.rs`. Quoting matches
Bash's reusable quoting, `@E` matches `$'...'` decoding, case operators reuse the
existing locale mapper and `@A`/`@a` read readonly and export state. The locale
printability classifier moved unchanged from printf quoting into `expand` so both
share it. Arrays, locale variables that are namerefs, `${@@op}`, indirect names,
`@P` and transformations nested in other operands remain unsupported and fail
closed.

One frozen production-Waffle replay against main
`f3dbd5e13e9d4875c5efd79db98aeabc7c8838fb` preserves all 9,221 IDs, frozen
identities and exclusions, with zero lost passes:

- Oils: 1,051 to 1,058, gained `oils:var-op-bash:163`, `:182`, `:264`, `:381`,
  `:410`, `oils:builtin-printf:95`, `oils:serialize:193`.
- Brush suite: 1,057 to 1,062, gained `brush-suite:nameref:102` and
  `word_expansion/param_transformation:5`, `:9`, `:10`, `:12`.
- Bashkit suite: 1,443 to 1,449, gained `bashkit-suite:variables:377`, `:384`,
  `:391`, `:398`, `:405`, `:795`.

Remaining scored transformation failures need arrays, positional lists, integer
or case attributes, `@P` or indirect names. See
[the behavior notes](../docs/parameter-transformation.md) and
[the receipt](../docs/evidence/parameter-transformation.json).

## Follow-up: all-zero and overflowing digit parameters, 2026-10-22

Status: Approved. Fix this in the direct parameter adapter, not in indirection.
Bare `${!p}` reaches digit targets through the same direct read, so one fix
covers both spellings.

The review of the indirect special-target unit (PR #46) compared GNU Bash
5.3.15 with the release Waffle guest (sha256 `e0aa18e3…`) after
`set -- a b c d e f g h i j`:

| Form | Bash | Waffle |
| --- | --- | --- |
| `"${00}"`, `"${000}"`, `r=00; "${!r}"` | `$0` (`/usr/bin/bash`) | empty |
| `"${18446744073709551616}"` and its `${!r}` form | `a` | empty |
| `"${9999999999999999999999999999999999999999}"` and its `${!r}` form | `i` | empty |
| the two overflowing forms under `set -u` | `a` / `i`, status 0 | fatal `unbound variable`, status 127 |

`r=01` and `r=0010` already match Bash. Suspected cause:
`State::parameter` (`shell/engine/src/state.rs:343`) matches `$0` only on
the literal `"0"`, so `00` parses to 0, fails `checked_sub(1)` and reads as
empty. Overflowing digit strings fail `parse::<usize>()` and also read as
empty. `require_bound` (`shell/engine/src/expand.rs:668`) treats the failed
parse as unset under nounset. Bash converts the digits with wrapping
arithmetic and selects the resulting positional. Derive the exact wrap rule
from Bash's source and check it against controls before changing the code.
Evidence: `/work/reports/bash-web/hill-climb/expansion/indirect-special-review-r2/controls.json`
(rows `direct:00:` through `indirect:9999…:set -u; `). No frozen scored case
has been checked against this; claim no gain unless a replay proves one.

## Follow-up: command substitution loses a 700,000-byte capture, 2026-10-22

Status: Approved. Bounded to the command-substitution capture path, which
the control track owns (`shell/engine/src/expand/command.rs`). Do not fix it
from the tilde or pathname units.

The pathname unit's budget probe compared GNU Bash 5.3.15 with the release
Waffle guest built from main `77b3963` (shell tree `2f38c80d`, sha256
`4329f221…`), locale C.utf8, inside an empty `$TMP`:

| Script | Bash | Waffle |
| --- | --- | --- |
| `x=$(printf '%0700000d' 0); echo ${#x}` | `700000`, status 0 | `0`, status 0 |
| `x=$(printf '%0300000d' 0); echo ${#x}` | `300000`, status 0 | `300000`, status 0 |

The large capture comes back empty with status 0. It neither fails at an
explicit limit (status 2) nor keeps the bytes. Find which capture or
assignment ceiling discards the value, then make it either keep the value
or fail explicitly the way other limits do. Evidence:
`/work/reports/bash-web/hill-climb/expansion/pathname/budget-probe2.log`
(rows `capture-700k` and `capture-300k`). No frozen scored case is tied to
it yet; claim no gain unless a replay proves one.

## word fields carry bytes, not UTF-8 String

Status: Approved, 2026-10-21. Follow-up to indexed arrays in PR41. Keep this as
one shared item for variables, expansion and control, with exact scored IDs
added only when byte-level observations establish this boundary.

The engine's word fields, bindings and command-substitution captures currently
use Rust `String`. That cannot represent a lone `0xff` byte. In
`expand/command.rs`, invalid-UTF8 capture is rejected before a later case match
can receive the bytes. Do not replace invalid bytes with Unicode replacement
characters, emulate allocator-dependent bytes, or change the frozen ruler.

Confirmed scored cases:

- `bashkit-suite:bashbox-declare:301`, "declare -p quotes control characters
  and bytes that aren't UTF-8". The script sets `z=$'\xff'`; its escaped
  declaration must be `declare -- z=$'\377'`, not the distinct UTF-8 spelling
  for U+00FF. The lexer currently converts invalid escape bytes into Unicode
  scalars in `flush_escape_bytes`. This is a raw-byte prerequisite in a mixed
  declaration case. Missing declaration formatting is another blocker, so
  changing word storage alone does not promise this gain. The validated raw
  native observations and frozen mapping are retained in
  `/work/reports/bash-web/hill-climb/variables/byte-field-blocked-ids.md`
  and `.json`.
- `oils:var-op-slice:107` and `oils:var-op-slice:124`. Both construct
  `s=$(echo -e "\\xFF")bcdef` then run `echo -${s:1:3}-`, expecting `-bcd-`.
  The leading raw `0xff` must survive command substitution and word storage.
- `oils:case_:147`, "matching the byte 0xff against empty string". It captures
  `c=$(printf \\377)`, then matches both `case $c` and `case "$c"`. Both paths
  must preserve the captured byte. Control identified invalid-UTF8 rejection in
  `expand/command.rs` as the current boundary.

Separate custom observations are not scored IDs. Native Bash observations of
array-valued IFS include a raw `0xff` separator for `IFS=(); ... "${a[*]}"`.
PR41 fixes the independently reproducible field-splitting and local-restoration
bugs, but does not claim raw-byte star-join compatibility. The native binary
identity, environment, status and raw base64/hex streams are retained in
`/work/reports/bash-web/hill-climb/variables/indexed/review-probes.ts` and
`review-probes.jsonl`. Cases are not blocked by this item just because they mention arrays
or IFS. In particular, `oils:var-op-patsub:245` is not in this raw-byte list:
it exercises locale-C matching of valid UTF-8, which is not itself a String
representation failure.

Change the word-field representation and its bindings, captures, splitting,
patterns, argv and output consumers together so arbitrary non-NUL shell bytes
survive end to end. Keep byte offsets distinct from locale-aware character
operations. Add failing-first byte-level tests for each confirmed ID and for
valid UTF-8, ASCII, empty fields, quotes and NUL handling. Preserve bounded
storage, work admission, cancellation and scope restoration. Qualify through
production Waffle with the same frozen identities, exact gained/lost IDs and
zero lost passes. No gate, oracle, environment, exclusion or threshold changes.


## Effective IFS publication provenance

Status: Approved, 2026-10-22. Owner: VARIABLES. This is the next VARIABLES
family after PR41 lands, ahead of explicit-name declaration printing. This
future plan item does not expand PR41's implementation.

CONTROL's BASH_REMATCH adapter can publish an indexed value through a nameref
into IFS. Bash uses that value's element zero for field splitting while
retaining the prior quoted-star separator. Ordinary `IFS=(...)` instead
disables splitting. The current `field_ifs` returns an empty string for every
indexed binding. `Ifs::new` enumerates that string, and `IfsMembers` only filters
its characters. A new cache plus `StarSeparator::Snapshot` cannot supply the
missing delimiter. Do not use that workaround.

First, have CONTROL retain a distinguishing multi-argument quoted-star control
and an ordinary indexed-IFS control in its GNU Bash 5.3.15 observations. The
existing single-argument star print does not distinguish separators. Then
re-inventory scored failures against merged PR41 and record exact IDs. Separate
direct IFS gains from cases enabled for CONTROL. No direct scored IFS gain is
established yet. CONTROL's capture assignment has 18 scored candidates, but none
mentions IFS. Do not count all captures as gains of this prerequisite.

Define a state-owned effective-IFS source or publication-provenance contract.
Preserve the distinction between rematch-published indexed IFS and ordinary
indexed IFS. Cover direct and resolved targets, subsequent assignment, unset,
nameref changes, no-match publication, local restoration, prefix restoration,
and isolated state snapshots. Stage and admit fallible work before atomic
publication. Resource rejection and cancellation must preserve prior state and
refund storage. Keep ordinary OPTIND assignment separate from rematch
publication, which must not reset the hidden getopts cursor.

Publish the exact API agreement to CONTROL before implementation. Keep the
existing `State::publish_rematch` signature and typed publication outcomes
unless evidence requires a coordinated change. The adapter must consume the
state contract without manipulating cache bits or restoration records. CONTROL
keeps its matcher and ordinary publication work disjoint until this prerequisite
lands, then integrates its actual merge normally before final acceptance.

Use a separate VARIABLES worktree and PR after PR41. Add failing-first native
and production-Waffle controls, independent exact-source review, unchanged
blocking gates, and a frozen replay with zero lost cases. Preserve all ruler
identities, exclusions, and limits. This unit is not the raw-byte field rewrite.
Detailed source proof and evidence limits are in
`/work/reports/bash-web/hill-climb/variables/rematch-ifs-prerequisite.md`.

### Inherited nameref IFS joining control from PR60 review

Status: Approved, VARIABLES IFS-family ownership. This is evidence for the
existing effective-IFS contract above, not extra scope for index enumeration.

At source `728ac9c0c3426bf935789df73df9cd4ae5af50f1`, run with GNU Bash
`5.3.15(1)-release` or the native shell CLI using `-c`:

```sh
a=(x y); sep=:; declare -n IFS=sep; sep=; printf '<%s>\n' "${!a[@]}"
a=(x y); sep=:; declare -n IFS=sep; sep=1; printf '<%s>\n' "${!a[@]}"
a=(x y); sep=:; declare -n IFS=sep; sep=; printf '<%s>\n' "${a[@]}"
a=(x y); sep=:; declare -n IFS=sep; sep=1; printf '<%s>\n' "${a[@]}"
```

Bash stdout is `<0 1>\n`, `<0:1>\n`, `<x y>\n`, `<x:y>\n` respectively.
Native and fresh production Waffle instead print `<0>\n<1>\n`, `<011>\n`,
`<x>\n<y>\n`, `<x1y>\n`. All statuses are 0. The first two are retained
in `review60-r1-minimal-repros.json` and `review60-r1-waffle-repros.json` under
`/work/reports/wave-20261022/shell/`; the full review records the value controls.
The 452-probe sweep in `review60-r1-probes.log` reports nine mismatches when a
nameref IFS target changes, apart from three index-star adjacency failures.
No crash or nondeterministic output was reported for these controls.

Inspect `Expansion::elements` in `shell/engine/src/expand.rs:1869-1887` and its
existing `positional_star_separator` and `field_ifs` adapters. The unchanged
ArrayAccess value path reproduces the same IFS joining policy limitation,
so fixing inserted index-star separator protection alone cannot resolve it.
Do not change the frozen oracle or treat the inherited mismatch as an accepted
semantic match. Resolve the effective-IFS ownership contract in its own family.

## Indexed array index-name expansion

Status: Approved follow-up in the VARIABLES array-expansion family. Do not add
this implementation to PR41 or CONTROL's capture adapter.

CONTROL's production-Waffle capture checkpoint exposes two exact scored
prerequisites: `brush-suite:extended_tests:29` and
`brush-suite:extended_tests:30` iterate `${!BASH_REMATCH[@]}`. Capture contents
match, but index enumeration still returns status 2. Evidence is retained in
`/work/reports/bash-web/hill-climb/control/regex-captures/focused.log`,
`after.json`, and `assigned-cases.json`. These are pending gains, not accepted
baseline memberships.

Implement index-name expansion over the existing state-owned sparse traversal
in a separate bounded family. Verify sparse order, empty arrays, quoted and
unquoted forms, nameref targets, scalar and positional boundaries, budgets, and
cancellation against Bash. Re-inventory other scored candidates after PR41
rather than treating historical array failures as new gains.

## Compound local array declarations

Status: Approved follow-up in the VARIABLES declaration and scope family. Keep
CONTROL's rematch adapter and PR41 unchanged.

CONTROL's custom production-Waffle control sets `BASH_REMATCH=(global)`, then
calls a function containing `local BASH_REMATCH=(local spare)` and a regex
capture. Bash restores the global array after return. The current declaration
path does not establish that compound local, so the capture remains global.
The exact script and byte output are retained in CONTROL's
`regex-captures/focused.log` and `scripts/fixtures/shell-regex-captures.json` in
its worktree. This custom control is not a scored ID.

Start by reproducing the declaration without regex on merged PR41. Separately
check scalar locals and existing indexed-local restoration to isolate the
compound declaration path. Candidate scored rows include
`bashkit-suite:arrays:213`, `bashkit-suite:arrays:226`,
`bashkit-suite:arrays:237`, and `bashkit-suite:arrays:250`. Their status must be
recomputed after PR41. Implement through the typed declaration path and state
ownership, with no ad hoc BASH_REMATCH scope logic. Preserve local admission,
readonly and nameref behavior, nested restoration, and resource or cancellation
rollback. Qualify independently with the unchanged frozen zero-loss gate.


## Automatic numeric special-scalar presence and values

Status: Approved prerequisite, scheduled by scored gain and concrete dependency after the indexed-array family. No indexed-array implementation expansion. The existing Approved process-identity unit remains canonical for BASHPID.

PR52 independent review at48634c07141a47fa3569adcd5ef3e96d624189ad demonstrates five deterministic ordinary-control regressions when new arithmetic nounset enforcement treats unsupported automatic scalars as absent. `set -u; printf '%s\n' "$((BASHPID-BASHPID))"` and the corresponding `0*BASHPID`, `0*UID`, `0*EUID` and `0*LINENO` controls print `0\n` with empty stderr/status0 on exact Bash5.3.15 and unchanged production base, but the candidate returns fatal Unbound/status127. These are not claimed frozen-corpus losses. Exact observations and runnable driver are in `/work/reports/bash-web/hill-climb/control/review-52-r1/special-probes.json` and `special-probes.ts`.

VARIABLES owns coherent actual presence/value lookup and its host/session or execution-source inputs. CONTROL owns arithmetic consumers. BASHPID must use real process identity under the existing same-process task decision. UID/EUID need verified runtime identity semantics, and LINENO needs actual execution source position with observed assignment/unset behavior. Preserve local/prefix restoration, snapshots and resource/cancellation guarantees. No special-name whitelist, fabricated values, build-host identity in a browser guest or present-without-value marker. Inspect current runtime capabilities before claiming an external prerequisite is absent. A bounded arithmetic correction can proceed independently if it preserves these controls honestly; otherwise defer the conflicting fatal-absent change until the prerequisite. Scope and ownership receipt: `/work/reports/bash-web/hill-climb/variables/special-scalar-prerequisites.md`.

## Indexed array storage and reads, 2026-10-22

Status: Approved. Current-source local qualification is complete for PR41;
parent owns independent integration acceptance, hosted CI, merge and exact-main
verification. This is not a merged-family completion claim.

Source `c94275f4d56767cf0a45f2e448c205c1365285f1` includes a normal merge of exact main
`93fdf762f2a694427440d07156c7a8c458ecc995`. One authoritative real-Waffle
replay retains all 9,221 records, 5,792 scored cases, 3,429 skips and the five-field
frozen identity. Oils gains 55, 1099 to 1154; Brush gains 40, 1080 to 1120;
Bashkit gains 85, 1469 to 1554. Every corpus loses zero passes. The saved
finalizer reconstructs membership from immutable main plus those 180 proven
gains, preserving every nongained historical row and passing the unchanged
strict comparator. The earlier ad190 replay predates the scalar-transformation boundary correction and is historical, not final proof. Earlier source657 measurements remain historical pre50
observations, not current-source proof.

State owns unique in-place sparse writes and admitted shared copy-on-write.
An admitted inverse journal retains completed assignments on ordinary semantic
errors but reverses them on resource rejection or cancellation, without losing
durable RHS effects. Local/prefix restoration and getopts cursor state retain
their existing owners. Indexed-local getopts aggregate preflight admits the same
publication growth as the synchronous writer, including repeated resolved aliases.

Full native/WASI suites pass 1434/1414 tests. Unchanged Rust, JS quality, layer,
duplicate and scoreboard checks pass; the scoreboard selection passes 670 tests.
Nineteen recorded local Bash 5.3.15 controls match native and production Waffle,
including 5,000 individual writes, 5,000 appends and a 10,000-element compound
assignment under unchanged default limits. No skipped case is counted as a gain.

See [the behavior and remaining forms](../docs/indexed-arrays.md) and
[exact source/artifact/result evidence](../docs/evidence/indexed-arrays.json).
Explicit-name declaration printing, index enumeration, compound-local forms,
effective IFS provenance and raw-byte fields remain separately scoped. The
single Approved byte-fields item above remains canonical for its four proven
scored prerequisites. No pathname/noglob, tilde or rematch branch was copied.

The sole integration-review P2 is repaired by rejecting resolved indexed bindings before scalar transformation projection. Nounset ordering and local scalar behavior are unchanged. Seventeen recorded unsupported-family/nounset controls pass on fresh native and Waffle artifacts; these are not scored gains. The initial replay and scoreboard attempts hit the host light queue's cgroup memory ceiling. Their failed logs remain separate from the completed suite-class final evidence, with no guest limit or gate changes.

### Inherited extglob parse-option timing

Status: Approved follow-up in the parser/options family, not PR41 storage scope.
A custom scalar-only control on source `ad190b8` runs
`shopt -s extglob; case foo in @(foo|bar)) printf "yes\n";; esac`.
Local GNU Bash 5.3.15 rejects the same-line unit with syntax status 2; the native
shell prints `yes\n` with status 0. Splitting after `shopt` with a newline makes
the recorded integration control agree. This needs no indexed assignment.
Parser/grammar source is identical to integrated main `93fdf762`; PR41 does not
change parser option timing. No frozen scored mapping or lost pass is claimed.
Exact bytes and binary identities are in
`/work/reports/bash-web/hill-climb/variables/indexed/post93f-inherited-extglob-timing.json`.
Before changing this behavior, reproduce direct case and ordinary argument
patterns with extglob unset, enabled on the same read unit and enabled on a
previous read unit. Coordinate with the parser/options and expansion owners;
do not broaden indexed storage or alter the frozen ruler.

## Leading tilde-colon parameter literal handling

Status: Approved follow-up in the expansion family, outside PR57's reviewed
assignment-looking brace repair and call-only main integration.

Minimal relevant form from the independent narrow review:

```sh
HOME=/one; set -- {~,:~}:$HOME; printf '<%s>\n' "$@"
```

The leading `~:$HOME` result is `</one:$HOME>\n` in GNU Bash
`5.3.15(1)-release` but `</one:/one>\n` in the reviewed Waffle guest.
Status is 0 and stderr is empty. The old Word and repaired Generated contexts
both leave this leading path unchanged. Reproduce and isolate Bash's literal
parameter handling after the leading tilde-colon before changing it. Preserve
HOME side-effect order, quote protection, budgets and cancellation.

Exact full control and expected/actual base64 bytes are in
`/work/reports/bash-web/hill-climb/expansion/tilde/review-r2/classified-results.json`,
`nonRepairDifferences` entry `context-order-3`, reviewed at
`19bcd7ffe407d1c3d6c73940fb464d41fc8b4f37`. No fresh integrated-source result or
frozen gain is claimed for this follow-up.

## Missing redirect diagnostic in tilde fixture 25

Status: Approved follow-up in the redirect/diagnostic family, not a PR57 tilde
repair. Preserve the actual redirect failure and final command status.

```sh
HOME=.; printf data >'x=~'; IFS= read -r v <x=~; printf '<%s>\n' "$v"
```

Both GNU Bash `5.3.15(1)-release` and the reviewed guest return status 0 with
stdout `<>\n`. Bash stderr is
`/usr/bin/bash: line 1: x=.: No such file or directory\n`; guest stderr is empty.
The earlier review incorrectly labelled identical recorded bytes `match=true`
because it did not compare nonempty expected stderr. This is an existing
diagnostic difference, not an exact Bash match or a repair regression.

Reproduce through real Waffle and trace the failed input redirection's diagnostic
publication. Exact evidence is `nonRepairDifferences` entry `fixture-25` in the
same `review-r2/classified-results.json`; the older bytes are also retained as
`recorded-25` in `review-r1/observations.json`. Do not weaken status/stdout checks
or change the frozen diagnostic payloads to hide it.

## Tilde plus brace-generated pathname expansion

Status: Approved follow-up owned by expansion/pathname. Retest after PR54's
actual normal-main integration before deciding whether further work is needed.
No pathname source change belongs in PR57.

```sh
HOME=.; printf data >present; set -- ~/{*,x}; printf '<%s>\n' "$@"
```

The reviewed guest leaves `./*` literal, while Bash matches `./present`; the
other result is `./x`. Both return status 0 with empty stderr. Leading tilde
eligibility is unchanged by the assignment-looking repair. The full recorded
control also includes unchanged ordinary and assignment-looking brace forms.
Its exact expected/actual bytes are in `nonRepairDifferences` entry
`context-order-4` in the same `review-r2/classified-results.json`.

All three follow-ups come from the narrow review's 152 observations: 146 exact
Bash matches, three declared boundary matches and these three differences.
The append boundary was still declared at that reviewed pin; PR41 integration
now compares it directly with its unchanged genuine Bash recording.

### Approved: special-variable unset follow-ups from declaration review

Owner: VARIABLES, after the bounded declaration-printing landing. Source
`71eebbd4ff480aeffb68ec4df502d3613f49f3e4`; independent review
`/work/reports/wave-20261022/shell/review55-opus-r1.md` contains Bash 5.3.15
observations. These are not claimed frozen-score gains or losses.

- Effective IFS cache: `sep=:; declare -n mid=sep; declare -n IFS=mid;
  v="a:b c"; printf "<%s>" $v; echo; unset -n mid; printf "<%s>" $v; echo`
  prints `<a><b c>` twice in Bash, but the second expansion is `<a:b c>`
  in this engine. Ordinary `unset mid` has the same older mismatch.
  Diagnose live chain lookup versus Bash's cached effective IFS, preserving
  the separately planned effective-IFS provenance contract. Direct
  `unset -n IFS` already matches Bash.
- OPTIND operand hooks: `set -- -ab; getopts ab o; echo "$o $OPTIND";
  unset -n OPTIND; getopts ab o; echo "$o $OPTIND"` prints `a 1` twice
  in Bash, but `a 1` then `b 2` here. The direct non-nameref no-op bypasses
  `unset_binding`'s hook. Preserve ordinary variable values while applying
  verified operand-specific hooks. No frozen unset-n case covers this.
- Ordinary readonly-target diagnostic: `readonly t=x; declare -n r=t;
  unset r` names `r` here, but Bash names `t`. The pre-existing builtin
  diagnostic uses the operand instead of its resolved target. Cover both
  ordinary and reference-only modes with recorded Bash observations.

Reproduce through production Waffle before repair. Keep recorded fixtures,
local/prefix restoration and cancellation/storage controls; do not invent
special-variable values or widen the current declaration PR's semantics.

### Inherited declaration-function brace expansion

Status: Approved bounded follow-up. Owner: VARIABLES declaration/dispatch.
PR57 integration review recorded this inherited behavior, not a PR60 regression
or an accepted Bash match. Reproduce before repair:

```bash
HOME=/one; declare() { printf '<%s>\n' "$@"; }; declare x={~,~/tail} {~,~/tail}
```

Bash 5.3.15 prints `<x=~>\n<x=~/tail>\n</one>\n</one/tail>\n`.
The reviewed PR57 source `0d4cd315` prints
`<x={~,~/tail}>\n</one>\n</one/tail>\n` in native and production Waffle.
PR60 source `67462b95`, which integrates main241 without PR57, prints
`<x={~,~/tail}>\n<~>\n<~/tail>\n` in both engines.
All return status 0 with empty stderr. The old `a03e3a1` native minimal
control and current PR57 runtime agree on the mismatch. The first old-source
eight-case probe is invalid because it requires later declaration printing;
do not use that failed probe as preservation evidence.

At `shell/engine/src/interpreter.rs:2804-2828`, spelled declaration syntax
selects scalar operand expansion before function lookup at `2996-3001`.
The interpreter is unchanged by PR60. Exact byte evidence, source attribution,
and rerunnable controls are in
`/work/reports/wave-20261022/shell/review57-main3fd-integration-r3.md`,
its sibling `classification.json`, and the author's `shadow-prior.json` and
`shadow-current.json`. Those recorded controls, not a full replay, own the
observation. Distinguish real declaration operands from function argv without
weakening real declaration expansion, storage admission, or cancellation.
Do not fold the repair into index-name integration or count this as a pass.


### Inherited declaration invalid-operand diagnostic

Status: Approved bounded follow-up. Owner: VARIABLES declaration/builtin
diagnostics. Independent PR60 integration review reproduced both controls once
in native and production Waffle at `67462b958932322deace9332962080eee7b12702`:

```bash
v="2 20"; builtin declare k=$v; declare -p k
```

```bash
a[20]=twenty; a[2]=two; builtin declare k="${!a[@]}"; declare -p k
```

Bash 5.3.15 and both engines print `declare -- k="2"` followed by a newline
and finish with status 0. Bash also diagnoses invalid identifier `20` on stderr;
both engines omit that diagnostic. Neither control is an exact Bash match.
The scalar control does not use index-name expansion. The suspected error return
at `shell/engine/src/builtins.rs:738-743` is byte-identical to main241.
No exact-main binary was run, so the source proof and scalar isolation, not a
claimed main execution, establish the inherited boundary.

Reproduce on current main through production Waffle before repair. Record
Bash all-stream/status observations locally and preserve later-operand behavior,
status propagation, storage admission and cancellation. Implement the general
declaration diagnostic in its owning builtin, not in array expansion. Do not
claim a frozen gain without a qualified replay. Exact scripts, bytes and setup
failures are retained in
`/work/reports/wave-20261022/shell/review60-main241-integration-r3/non-blocking-observations.md`
and sibling `observations.json` / `small-observations.json`.

## Native `-c` missing-parent redirection, 2026-10-22

Status: Approved follow-up. Owner: BUILTINS coordinator, outside the trap
registration family. Fix the native fixture filesystem before using native
controls to judge missing-parent redirection failures.

At source `6609e3cb0b8b5ababcca7ba0ee0269f09492d337`, run:

```sh
/work/tmp/bash-web-builtins-trap-exit-review-6609e3c/native/shell-engine -c ': > /nonexistent/dir/x; echo $?'
/usr/bin/bash -c ': > /nonexistent/dir/x; echo $?'
```

Both processes exit 0. Native stdout is `0\n` with empty stderr. GNU Bash
5.3.15 stdout is `1\n`, with a missing-directory diagnostic. The same script
through production Waffle prints `1\n`. Reproduced in the independent trap
review and again in the correction lane, without any trap command, so this is
not evidence of trap registration behavior.

Pinned native SHA-256 is
`915e44c2c92591245ef33a62f3d8c46650f4765074ee112af421fe1d0878ee4e`.
Production Waffle uses `shell-runtime.wasm` SHA-256
`eb435393f9ff7a0b6d596497f6a7fd10080c94d4195a1c50efbf5513bfc40aaa`
and the unchanged launch Node bundles. Bash's full version is
`GNU bash, version 5.3.15(1)-release (x86_64-pc-linux-gnu)`.
Its binary SHA-256 is
`575e03ac834b739349a4484de481abcd06a6f7193cefc795260a32a1943f20a5`.

Suspected cause: `compat.rs:492` installs `MemoryFs` for native `-c`, and
`io.rs:733` creates a missing file without checking its parent directory.
`ReadOnlyMount::open` delegates to that method. This rules out trap dispatch
and action execution. Add a missing-parent fixture and preserve successful
opens, directory errors, permissions and the production-Waffle control when
repairing it. Do not change frozen oracle identities or scoring to hide it.

Reproducer and exact observations are in
`/work/reports/wave-20261022/shell/trap-repair-r1-evidence/redirect-control.ts`
and `redirect-before.json`. This lane leaves `main.rs`, `compat.rs` and `io.rs` unchanged. The coordinator owns the follow-up and retained evidence until it
is repaired and verified.

## Re-ignored inherited EXIT registration, 2026-10-22

Status: Approved follow-up. Owner: BUILTINS coordinator. Separate from the
nested-parent trap correction, with no trap action execution needed. At
`535197097ea359ee15b2e73bdf0a944b41df0c82`, local GNU Bash 5.3.15
and the guest differ on these exact registration controls:

```bash
trap '' EXIT; while read -r l; do echo "got:$l"; done < <(trap '' EXIT; trap -p EXIT); trap - EXIT
trap '' EXIT; (trap : HUP; trap - EXIT; trap '' EXIT; trap -p EXIT); trap - EXIT
```

Both Bash scripts exit0 with no stdout. The guest prints
`got:trap -- '' EXIT\n` for the first and `trap -- '' EXIT\n` for the
second. The review found three such quirk rows. Setting a handler before the
new ignore, or using a nested ordinary child, already matches. The suspected
state belongs to ignored EXIT provenance after the inherited binding is cleared,
not action execution or general process-substitution inheritance.

Independent native and production-Waffle observations and exact scripts are
retained in `/work/reports/wave-20261022/shell/review63-trap-opus-r1-evidence/`
under `probe1.json`, `probe2.json`, `probe3.json` and `probe-categories.json`.
The nested-parent correction deliberately does not encode this extra state.
Record a narrow failing-first fixture before fixing it and preserve the173
registration controls. Do not claim that any new ignored EXIT always stays
visible in a process substitution. No frozen exclusion or scoring change.

## Function-name grammar prerequisite, 2026-10-22

Status: Approved. Owner: CONTROL follow-up after literal declaration-name validation.

The current parser rejects `f\oo() { :; }`, `'foo'() { :; }` and `"foo"() { :; }`
with syntax status 2 before producing `Command::Function`. GNU Bash 5.3.15 instead
executes these declarations as failures with status 1 and an identifier diagnostic.
For the escaped POSIX form, `parser/mod.rs::command_start` requires
`current_escapes.is_empty()` before considering `FunctionPosix`; fully quoted
names do not enter the `Token::Word` branch. `function f\oo { :; }` already reaches
the function parser and now correctly fails at execution. This PR intentionally
changes neither grammar nor token admission.

Reproduce strictly after the toolchain setup in `docs/development.md`, with
`npm run build:shell` then `npm run test:shell:function-names:pending`. The explicit pending recipe must
fail until its recorded Bash comparisons pass. It is separate from the ordinary
blocking scoreboard recipe, with no skipped or relaxed assertions. Expected bytes
and exact Bash version are in `scripts/fixtures/shell-function-names-pending.json`.
Before/after evidence, including the original escaped-POSIX failure, is retained in
`/work/reports/bash-web/hill-climb/control/function-names/{before,after,pending}.log`.
The follow-up must admit these names in the owning grammar, keep dead definitions
inert, and reuse the execution-time validator rather than adding a parse-time
identifier rejection. No new frozen case, exclusion or oracle change is authorized.

### Alias runtime prerequisite

Status: Approved. The parser's injected-alias function-name and print controls pass,
but this base has no `alias` builtin and rejects `shopt -s expand_aliases`. End-to-end
alias declaration controls therefore remain strict pending comparisons under
`npm run test:shell:function-names:aliases-pending`, using
`scripts/fixtures/shell-function-names-aliases-pending.json`. Their exact failures
are retained in the function-name report's `verify6.log` and `aliases-pending.log`.
This is a separate builtin prerequisite, not permission to add alias, shopt or
function-name grammar in the literal-name validation change. Keep parser alias
coverage and reuse its raw-token provenance when runtime aliases are implemented.

## Invalid nameref target review follow-ups, 2026-10-23

Status: Approved. Owner: VARIABLES declaration/builtin family. These inherited
notes are outside PR59's bounded invalid ordinary-target status correction.
Independent review approved source `6bc405d677b24d3b3d961ebda559874d7158f76b`.
The exact review and recorded controls are retained in
`/work/reports/bash-web/hill-climb/variables/nameref-invalid-review-opus-r1.md.result`
and its sibling evidence directory.

- Caller cancellation classification: `nameref_declaration` maps its own
  per-target checkpoint cancellation to `Err(130)`. The declaration caller
  aborts only on status 2 or `RESOURCE_STATUS`; other errors become status 1
  and processing continues. The existing large-value cancellation regression
  interrupts the caller's earlier operand scan, not this target scan. The
  reviewer found this in source and did not execute it. Reproduce cancellation
  specifically inside the target scan on current native and production Waffle,
  inspect the interpreter's final status handling, then repair in the owning
  declaration path with a deterministic cancellation control. Preserve
  nonmutation, ordinary status-1 continuation, resource rejection and refunds.
- Invalid-target diagnostics: Bash diagnoses `declare -n ref='a b'` as an
  invalid variable name for a name reference; the engine emits no diagnostic.
  The recorded fixture keeps the Bash stderr bytes, but its strict frozen
  comparison scores stdout and status only. Reproduce all streams on current
  production Waffle before repair. Keep ordinary invalid targets distinct from
  unsupported empty/unbound, bracket-bearing and PIPESTATUS references. Route
  this with the inherited declaration invalid-operand diagnostic above, not
  through an IFS, array-writer or durable-state change.

Neither note is a fixed bug, an accepted Bash match or a frozen gain of this
integration. PR59 leaves the caller and target-scan cancellation logic unchanged.

## Completion negative-extglob follow-up, 2026-10-23

Status: Approved. Owner: BUILTINS completion family after PR #79.
The nine round-one review reproducers are repaired. The broader control below
still differs because `expand/pattern/extglob.rs::Compiler::open` rejects `!`.
Positive `@`, `?`, `*` and `+` operators now use the existing bounded matcher
for completion `-G`; ordinary argv globbing keeps its prior behavior.

```bash
shopt -s extglob
printf x >zz_one; printf x >zz_two; printf x >zz_other
compgen -G 'zz_!(other)'
```

GNU Bash 5.3.15 prints `zz_one\nzz_two\n` and exits 0. Production Waffle at
`3e52e60c655f4159312dad81fbdb797e422cbf35` prints nothing for that command and
returns 2. The complete failing control remains unchanged in
`scripts/fixtures/shell-completion-pending.json`. After the normal WASI build,
run `npm run test:shell:completion:pending`. It is a strict failing recipe,
not an ignored assertion or a relaxed expected result. Its two unrelated runtime
controls remain included. The ordinary recipe retains every earlier passing
completion control and records positive operators separately.

Evidence is in `/work/reports/wave-20261022/shell/builtins-completion-fix-r2-evidence`
and `/work/reports/machine-fleet/remote-gate/completion-r2-final-20261023T082914Z-tp5_5kgk`.
Implement bounded complement groups without recursive backtracking, preserve
work/storage admission and cancellation, and add nested and suffix controls.
That matcher change is larger than passing an option through completion's glob
lookup. No frozen case, oracle, exclusion or baseline change is authorized.
## Case-attribute review follow-ups, 2026-10-23

Status: Approved. Owner: VARIABLES declaration family. PR77's independent review
approved source `7d9f73ee295d47c0f360b7bbb63379963719f851`. These are newly added
feature corners, not demonstrated losses against main. Record failing-first
Bash 5.3.15 controls before the next bounded correction.

- Reapplying uppercase conversion rejects its own Unicode output. Run
  `declare -u x=µ; x+=a; echo ok:$?; declare -p x`. Bash prints `ok:0` and
  `declare -u x="ΜA"`; the engine prints `ok:2` and `declare -u x="Μ"`.
  `ÿ` converting to `Ÿ` has the same problem. Check the mapper's output range
  in `state/case_attributes.rs` and its append caller in `interpreter/indexed.rs`.
- Adding an attribute through an existing local nameref destroys the reference.
  Run `x=OUT; f(){ local -n r=x; local -l r=AB; r=CD; declare -p x r; }; f; declare -p x`.
  Bash prints local `declare -l x="cd"`, `declare -n r="x"`, then restores
  `declare -- x="OUT"`. The engine leaves x unchanged and prints scalar r.
  Preserve reference ownership and target/local restoration in `case_attributes.rs`.
- Combined `declare -nl r=x` loses the reference. Run
  `x=old; declare -nl r=x; r=ABC; declare -p x r`. Bash prints x as `ABC` and
  r as `declare -nl r="x"`; the engine prints x as `old` and scalar r as `ABC`.
  Handle the declaration flags together in the owning builtin path.
- Bare `+` is consumed as an empty option. Run
  `declare + x=ok; echo status:$?; declare -p x`. Bash diagnoses the invalid
  identifier and prints `status:1`, keeping x set. The engine prints `status:0`.
  Correct operand admission without losing the later valid assignment.

Exact Bash/native observations, file locations and the review reproducer are in
`/work/reports/wave-20261022/shell/review77-r1.md` and `review77-r1-evidence/`.
Keep frozen observations, exclusions and blocking gates unchanged.


## Read option review follow-ups, 2026-10-23

Status: Approved. Owner: BUILTINS read, with the shared byte-field and
runtime/state prerequisite owners. Independent PR72 review approved
`967fd177652ea12a974d63c6ab9862830fb04650`. These are explicit capability
boundaries, not newly lost main passes or claimed repairs in that PR.

- Multibyte delimiter suffix. Reproduce through production Waffle:
  `printf 'a\xc3\xa9:tail\n' | { read -d é a; IFS= read -r tail; printf '%s|<%s>\n' "$?" "$tail"; }`.
  Bash 5.3.15 leaves bytes `a9 3a 74 61 69 6c` in `tail` with read status 0.
  The engine prints `2|<>` because scalar assignment rejects the invalid UTF-8
  suffix left after the delimiter's first byte. Route this to the shared
  "word fields carry bytes, not UTF-8 String" item above. Preserve raw bytes,
  unread offsets, bounded storage and cancellation. Do not substitute Unicode
  replacement characters or change the delimiter or frozen expectations.
- Positive-count terminal silent reads. `read -s -n1 value` on a terminal
  remains unsupported with status 2. `read -s -n0 value` succeeds without
  consuming input or changing terminal echo. Use a real terminal input fixture,
  not a pipe, when implementing echo control. Restore echo on success, EOF,
  cancellation and output failure. PR72 does not change echo state and does not
  claim silent-terminal support.
- Timers and array destinations remain unsupported. Recorded reproducers are
  `printf 'x\n' | { REPLY=old; read -t0; printf '%s|<%s>\n' "$?" "$REPLY"; }`
  and `printf 'a:b\n' | { REPLY=old; read -d : -a arr; printf '%s|<%s>|<%s>\n' "$?" "$REPLY" "${arr[0]}"; }`.
  Bash returns read status 0 and keeps `REPLY=old` in each control, and stores
  `a` in `arr[0]` in the array control. Coordinate readiness/deadline support
  with the runtime and array writes with state. Preserve input offsets,
  nonmutation on rejected options, resource accounting and cancellation.

Reproduce on current native and production Waffle before repair. Record exact
Bash 5.3.15 streams/status locally. The original review, 309-case fixture and
eight classified boundary differences remain in
`/work/reports/wave-20261022/shell/review72-takeover-r2.md`, its sibling evidence
directory and `/work/reports/wave-20261022/shell/review72-r1/neighbors.json`.
The terminal controls are in `scripts/fixtures/shell-read-terminal.json` and
`shell/engine/tests/words/read_options.rs`. Do not relax their assertions or
claim a frozen gain without a qualified unchanged-ruler replay.

## Completion nonblocking review follow-ups, 2026-10-23

Status: Approved, deferred beyond PR #79's bounded integration after read #72.
Independent review `review79-takeover-r2.md` approves completion source
`f13a5c310bf082da56e00401b43d4a1c2b0dd28b` and records these three remaining
corners. These are not demonstrated regressions against main. Preserve the
reviewer's recordings and ordinary argv behavior when implementing them.
Evidence is in `/work/reports/wave-20261022/shell/review79-takeover-r2-evidence/`.

### Preserve word-list newlines when IFS excludes newline

Owner: completion word-list parsing, `builtins/completion/wordlist.rs`.

```bash
IFS=:; compgen -W $'a\nb:c'; echo status:$?
```

The generated word list contains a literal newline, not a backslash followed by
`n`. GNU Bash 5.3.15 prints `a\nb\nc\nstatus:0\n`. Reviewed source prints
`ab\nc\nstatus:0\n`. Preserve that newline instead of encoding it as a removed
line continuation. The review's retained recording uses this equivalent input:

```bash
IFS=:; compgen -W 'a
b:c'; echo status:$?
```

### Enable POSIX classes for completion pathname patterns

Owner: completion pathname matching, `expand/glob.rs`.

```bash
printf x >zz_a; compgen -G 'zz_[[:alpha:]]'; echo status:$?
```

GNU Bash 5.3.15 prints `zz_a\nstatus:0\n`. Reviewed source prints `status:2\n`.
The difference occurs both with extglob off and after `shopt -s extglob`.
Apply the supported named-class policy to `-G` without changing argv globbing.

### Recognize explicitly dotted positive-extglob alternatives

Owner: completion pathname matching, `expand/glob.rs`.

```bash
shopt -s extglob; printf x >.zz_a; printf x >zz_a
compgen -G '@(.zz_a|zz_a)'; echo status:$?
```

GNU Bash 5.3.15 prints `.zz_a\nzz_a\nstatus:0\n`. Reviewed source prints
`zz_a\nstatus:0\n`. Treat explicitly dotted alternatives as eligible when
excluding hidden entries. Keep implicit hidden-name exclusion and ordinary
argv matching unchanged. Add nested and suffix controls before the fix.
