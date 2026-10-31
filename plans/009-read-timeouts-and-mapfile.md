# Plan: Bash-compatible `read -t`/`TMOUT` and streaming `mapfile`/`readarray`

Status: **Approved** (owner decision, 2026-10-31, `plans/007-agent-shell-compatibility.md#follow-up-read-timeouts-and-mapfile`).
Author: Opus design agent (big-plan rule: crosses the shell driver, canonical Waffle support APIs, cancellation and state publication).
Gate: independent Sol plan review runs **before** implementation. R0 requested the publication redesign; Opus supplied that redesign and the parent applied ordinary fixes. R1 accepted the revised architecture with three ordinary wording/order corrections, now applied by the parent. `R1-RESOLUTION.json` binds the accepted revision and the exact checks. No additional Opus redesign or third review round is needed before B1/W1 starts. Code PRs still require independent Sol review.

## 0. Sources this plan was traced against

- bash-web `origin/main` = `d2b16d6fab8628e21e91b562ff96830b745b13cd` (PR 204). `shell/engine/src/lib.rs` re-exports `waffle_program_support::{executor, io}`; there is no local `executor.rs` or `io.rs`.
- Rust support crate `waffle-program-support` at Waffle `a9af70fabd5ea2f0f7e7730a36ca00ff6697d9ee` (resolved by `cargo metadata --locked`; read from `~/.cargo/git/checkouts/waffle-613eddd4d92f89c0/a9af70f/packages/program-support/src/{executor,io,runtime}.rs`). Host poll: `packages/waffle/proc/abi.ts` `poll()` (finite `timeout`, `deadline = now() + timeout`, fully notified sets park until the deadline, zero subscriptions are fully notified).
- Docs: `AGENTS.md`, `docs/concepts/architecture.md`, `docs/reference/engine-ownership.md`, `docs/read.md`, `docs/indexed-arrays.md`, `docs/landing-infrastructure.md`.
- Floor: `scripts/shell-scoreboard-floor.ts` `falsePassCorrections` (the three owner-corrected IDs). `accumulateFloor` re-adds a corrected ID as soon as a main score passes it (`scoreFloor`), so no floor edit is needed or allowed.
- Prior sizing: `/work/reports/cross-repo-duplication/bash-web-null-builtin-assessment/assessment.md`. Its "executor timers in `shell/engine/src/executor.rs`" step is **stale**: that file no longer exists and the executor is Waffle's. Corrected ownership is in section 1.
- Authoritative observations: R0's `SOL-REVIEW.md` and the parent's `PARENT-RESOLUTION-PROBES.json`, both using the cached GNU Bash 5.3.15 package. Package SHA256 `2c14ce3c72790ec6b344267b39f04f921bbb34f0c1399460e71492547f6b6c65`; executable SHA256 `575e03ac834b739349a4484de481abcd06a6f7193cefc795260a32a1943f20a5`. Extraction, pipes and child process groups are scoped and torn down. The older 5.3.20 notes are exploratory only.
- R0 findings and their resolution: `SOL-REVIEW.md`, `PARENT-RESOLUTION.md`, and `MAPFILE-REVISION.md`. The last file is the separately authored redesign input; this PLAN is the integrated implementation contract.

## 1. Ownership decisions

| Concern | Owner | Why |
| --- | --- | --- |
| Deadline registry, `Sleep` future, firing, next-deadline query | **Waffle** `program-support::executor` | Scheduling is Waffle-owned (engine-ownership "Neutral program support"). A shell-local timer wheel would be neutral executor code outside Waffle. Waffle's own utilities (`coreutils` driver in `packages/coreutils/src/lib.rs:158`) can use it too. |
| Non-consuming read readiness of an open description | **Waffle** `program-support::io` (+ `runtime::RuntimeEndpoint`) | `Open::PipeRead`'s state, `Bytes`, `File`, `Null` and `RuntimeEndpoint` are private to Waffle. The shell cannot observe "bytes buffered or writer closed" without copying I/O internals. |
| Host-poll timeout from a deadline (ms rounding, `-1`, clamp) | **Waffle** `program-support::runtime` (one free function) | Neutral encoding of the existing finite-ms ABI; shared by every cooperative driver. |
| Driver loops (`runtime_main.rs`, native `compat.rs`), one reactor | **bash-web** | Shell-owned pumps and policy. Drivers only pass the computed timeout to the single existing `Runtime::poll`. No second reactor, no new readiness kind, no fake subscription. |
| `read -t` parsing, `TMOUT`, `-t 0` policy, 142 status, partial assignment | **bash-web** `builtins/read.rs` (+ `builtins/read/timeout.rs`) | Bash rules. |
| `mapfile`/`readarray` builtin and streaming record splitter | **bash-web** `builtins/mapfile.rs` (+ `builtins/mapfile/records.rs`) | Bash rules, original code (not Bashkit: its mapfile buffers the whole input, ADR 002). |
| Incremental indexed-array publication from a builtin | **bash-web** `state` (new `state/producer.rs`) | `docs/indexed-arrays.md` "Internal producers": a state-owned admitted producer adapter with its own typed outcome and special-hook policy, not ordinary assignment or prefix rollback. |

Unchanged and preserved: `Session::new(executor, process_host, filesystem, limits)` and every public TS session/prompt API; `shell_terminal.inherited_fd` → `support::WasiAbi::with_inherited_fds` in `shell/engine/src/runtime/wasi.rs`; readiness kinds 0 (fd read), 1 (fd write), 2, 4 (job, notified by the shell after reaping), 5, 6 with their exact IDs; `Budget`/`Cancel` semantics; input pumps in `shell/engine/src/runtime.rs`.

## 2. Waffle API request (parent sends after the Sol plan review)

Recipient: Waffle/Nuxt coordinator `mcp:34146d8a-caf9-4bc7-a0de-26cb66737136`. Request text, self-contained:

> **Waffle program-support: timers and non-consuming read readiness for bash-web `read -t`.** bash-web needs real `read -t`/`TMOUT` (status 142 on expiry, `-t 0` readiness without consuming input). Both need neutral facilities that belong to `packages/program-support`. No host/JS ABI change is needed: `proc_poll` already honours finite millisecond timeouts and zero-timeout scans. Please add, with tests, in one PR, and ship it in the next `waffle-v*` runtime release (bash-web's support pin follows the runtime release source revision via `.github/scripts/update-waffle-releases.sh`):
>
> 1. `executor.rs` timers, owned by `Executor` (no new public constructor or `Session` change downstream):
>    - `pub fn sleep_until(&self, deadline: std::time::Instant) -> Sleep`. `Sleep: Future<Output = ()>`; it registers on first poll (key `(deadline, sequence)`), updates its waker on re-poll, and unregisters on drop. A deadline already passed at first poll completes without registering. Once complete it stays complete (polling again returns `Ready`), and it is `Unpin`. `pub fn deadline(&self) -> Instant` and `pub fn is_elapsed(&self) -> bool` (true once fired or completed; no clock read).
>    - `pub fn next_deadline(&self) -> Option<Instant>`: earliest registered deadline.
>    - `pub fn fire_timers(&self, now: Instant) -> usize`: remove and wake every registration with `deadline <= now`, waking after the registry borrow is released, in deadline then registration order.
>    - `drive()` calls `fire_timers(Instant::now())` at its start **only when a timer is registered** (no clock read otherwise). `Drive` is unchanged.
>    - `park_if_idle()` returns `false` without parking while any timer is registered (`IdleWakeSource::park` has no timeout). Document it; no current caller exists.
>    - The registry lives in its own `Rc` shared by `Executor` and `Sleep`. `Sleep` must not hold an `Rc` to the task map (a task owning its `Sleep` would form a cycle).
> 2. `io.rs` readiness:
>    - `HostEndpoint::read_ready(&self) -> Result<bool, IoError>` defaults to `Err(IoError::Unsupported)`.
>    - `Endpoint::read_ready(&self) -> Result<bool, IoError>` is an observation, not permission to read. It does not consume, retain, clone or move an offset. Local dispatch: `File` is ready even if opened write-only; `Bytes`, `BytesSource` and `Null` are ready, including EOF; `PipeRead` is ready when buffered bytes exist or writers are gone; `PipeWrite` is ready only when readers are gone, not merely when its shared buffer has bytes; `Capture` is not read-ready. `Host` and exported `Bytes` delegate to the host; never inspect an exported Bytes object's original source. Missing/invalid descriptors remain errors. See section 3.5 for the cross-backend matrix.
> 3. `runtime.rs`:
>    - `RuntimeEndpoint::read_ready` → one `Abi::poll(&[Subscription { kind: 0, id: fd, userdata: 0 }], 0, &mut [PollEvent; 1])`. Accept only a count of 0 or 1; for one event verify kind 0 and echoed userdata 0, and handle its flags according to the existing poll contract. Propagate ABI failures or malformed counts/events as an I/O error; do not silently report readiness from unrelated output. Never dispatch/remove another runtime waiter. Document that a **zero-timeout, single-subscription `Abi::poll` is permitted inside a task**, unlike `Runtime::poll`, which still runs only between turns and remains the only waiter-dispatching call. Confirm the JS side: `poll(..., 0, ...)` never waits (`remaining <= 0`) and returns 0 while a signal is pending.
>    - `pub fn poll_timeout(runnable: bool, next_deadline: Option<Instant>, now: Instant) -> i32`: `0` if runnable; `-1` if no deadline; otherwise milliseconds until the deadline **rounded up**, `0` if passed, clamped to `i32::MAX`.
> 4. Tests in program-support: sleep registration/drop leaves no registration; `next_deadline` ordering with two timers; `fire_timers` wakes only expired ones; a self-yielding busy task cannot starve an expired timer (the timer task is polled within one `drive` rotation); `drive` fires automatically; `park_if_idle` does not park with a timer armed; `read_ready` for every row of section 3.5, including readable/write-only files, both pipe directions with peers open/closed, Capture, empty/nonempty/EOF Bytes, BytesSource, exported delegation and Host Unsupported; unchanged offsets/contents/lifetime/registrations; drop before/after fire, changed wakers, equal-deadline order and fused re-poll; `RuntimeEndpoint::read_ready` passes kind 0, the endpoint's own fd and timeout 0 to a fake `Abi`; `poll_timeout` rounding (1 µs → 1 ms, passed → 0, none → -1, far → `i32::MAX`).
> 5. Optional, same PR: the coreutils driver (`packages/coreutils/src/lib.rs:158`) may adopt the same lazy-clock driver rule as section 3.3 for future timer users; leave current no-timer utilities unchanged unless this adoption is useful. Do not add unconditional clock reads.
>
> Out of scope: a new host ABI, new readiness kinds or version-negotiation code. The existing finite poll is sufficient. If an existing host readiness implementation disagrees with the explicit observation matrix, repair and test that owning Waffle implementation rather than adding a Bash permission guess or another reactor. Please reply with the merged commit and the release tag that carries it.

Estimated Waffle size: about 250 lines of Rust including tests. If the coordinator rejects or reshapes the API, the bash-web timed-read PR waits; see section 9.

## 3. `read -t` and `TMOUT` design (bash-web PR B2)

### 3.1 Parsing (`builtins/read/timeout.rs`, new)

Use `enum Timeout { Ready, After(Duration) }` and cooperative `async fn parse(value: &str, cancel: &Cancel, work: &mut Work) -> Result<Option<Timeout>, exec::Error>`. `Ok(None)` means an invalid specification; cancellation/resource errors remain distinct and propagate. Charge/checkpoint the entire argument, including discarded fraction digits, as the current read-count parser does. Use the numbered authoritative 5.3.15 conversion algorithm below, with explicit wrapping widths and the specified signed checks. Do not use floating point or platform `usize`. Saturation and overflow-to-indefinite waiting are prohibited:

1. Accept one optional leading sign, decimal integer digits, at most one dot and decimal fraction digits. The components may be empty: `''`, `.`, `+`, `-`, `+.`, and `-.` all convert to zero. Reject whitespace, exponent/hex forms, another sign or dot, and other trailing bytes.
2. Accumulate integer digits in an explicitly wrapping 64-bit word, then interpret that word as signed 64 bits and apply the leading sign with wrapping negation. Keep the first six fraction digits, right-pad to microseconds, discard later digits, and apply the sign to that truncated component. Reject a negative signed seconds or microseconds component **before** narrowing seconds to its low 32 bits.
3. Narrow a non-negative seconds component modulo 2^32; microseconds remain 0 through 999999. Both components zero mean `Ready`; otherwise construct the exact `Duration`.

The Linux 5.3.15 oracle confirms these conversion-boundary results. `4294967296` and `18446744073709551616` are zero; the next integer is positive. `9223372036854775808` and `18446744073709551615` are invalid, while `-9223372036854775809` is accepted and `-18446744073709551616` is zero. `-4294967296` is invalid: reject negativity before the final 32-bit narrowing. `-0.0000001` truncates to zero; `-0.000001` is invalid. Fixtures must cover these boundaries and both signs, not only the common decimal values. See the retained parent probes for exact diagnostics.

An absent `-t` argument returns status 2. An explicitly present empty argument is the valid zero above. Invalid values diagnose and return 1 immediately in option order; `read -t bad -t 0` fails on `bad`. Repeated valid `-t` options use the last value. A positive scheduling value whose `Instant::checked_add` fails returns the existing range/resource error before input, never an indefinite wait.

`TMOUT` is considered only if explicit `-t` is absent. Read its scalar through the existing state/nameref adapter. Use a successfully converted positive duration; ignore unset, invalid, negative and converted-zero values without a diagnostic. It never selects the zero-time readiness path. Interactive prompt auto-logout remains outside this unit because it changes public session lifetime.

### 3.2 Control flow in `builtins/read.rs`

1. Parse options in order. Add `t` as a value-taking option.
2. Explicit `Ready` performs only `endpoint(fds, fd)` and neutral `read_ready`. True returns 0; false, unsupported observation, or an invalid fd returns 1 under the existing error rules. Do not validate names, prompt, assign, admit a record buffer, consume bytes or arm a timer on this path. In particular, `read -t 0 1bad` may succeed.
3. Positive timeouts do not apply to `DescriptorKind::Regular`. Use the existing canonical `Endpoint::descriptor_kind()` observation, not a destructive read or copied filesystem/endpoint internals. Local File and logical Bytes/BytesSource descriptions are Regular; a runtime regular file is classified by its host. Exported Bytes keep their existing logical Regular classification for positive timeout applicability, while zero-time readiness still delegates to their exported host. Pipes, terminals and Other descriptions can time out. Directory/read errors keep the normal read error behavior. Descriptor observation errors are not permission guesses.
4. Keep the normal validation/endpoint/terminal setup order for positive/default reads. `-n 0` returns normally without input. Initialize the reader and its admitted buffers as today, then create one deadline immediately before the record-reading loop. Regular descriptions create no Sleep at all.
5. Add `Context::sleep_until(&self, Instant) -> crate::executor::Sleep` as a narrow crate-visible accessor in `interpreter.rs`. It uses `self.core.executor`; no new executor, constructor parameter or Context field. All root/function/substitution/test contexts already share the Session's Core. Builtins never access private `context.core` directly.
6. **Arm the one pinned Sleep before the reader loop's first checkpoint or input poll.** Poll it once with the task's waker through a small `poll_fn` arm helper that returns immediately after registration; a completed Sleep returns Timeout. Do not depend on a read-first `select` to register it. The same Sleep lives for the entire read, not one timer per byte or chunk.
7. Each subsequent read uses one explicit poll-order helper. Check the existing cancellation probe first, then an already-fired timer, then poll the pending read. If the read returns bytes, process and retain those bytes immediately, even if expiry/cancellation became observable during that poll; never consume then discard them. If input is Pending, poll/update the Sleep and return Pending or Timeout. A timer already fired before polling queued data wins without consuming that data. Ctrl+C already pending with expiry uses the existing cancellation status, not 142. Do not re-poll a read after it returned Ready. A Pending read dropped when the timer wins must unregister its own Event/Ready waiter and consume nothing.
8. Timeout finishes and assigns the accumulated partial value using the normal EOF assignment path but status 142. Destination-assignment failures keep their existing precedence. Normal EOF returns 1. Existing UTF-8 completion rules and normal cancellation mapping remain unchanged. Zero-time readiness is separate from this logic.

Once armed, `Sleep::is_elapsed` is a flag check. A self-yielding always-ready non-regular stream cannot hide the timer: drive fires it at the next turn, and the next loop check sees it. An in-flight raw exact-count chunk that completes before expiry is observed is retained; do not throw its consumed bytes away. Deterministic tests establish the ordering rather than relying on a natural timing race.

### 3.3 Drivers and observation access

- Import `waffle_program_support::runtime::poll_timeout` directly in the WASI binary. In both `runtime_main.rs` loops, runnable means timeout 0; an idle turn with no deadline means -1; only an idle turn with an armed deadline calls `poll_timeout(false, Some(deadline), Instant::now())`. Do not add a clock syscall to turns without timers. `drive` itself fires due timers at its start only when armed.
- Keep the one existing `Runtime::poll` between turns. Production's service and wake owner are the same runtime process, so an empty subscription list can park for the requested remainder. Other embeddings may use the existing 10 ms fallback. Test both configurations instead of claiming every empty-list embedding parks identically.
- In native `compat.rs`, an idle turn with a deadline waits until it and continues; only the existing no-deadline path interrupts. Confirm this standalone embedding has no external readiness provider before using `thread::sleep`. Do not replace a wakeable embedding's wait with an uninterruptible sleep.
- Inventory: the two shell WASI loops change. The native standalone idle branch changes. `shell/compat-fixtures/src/lib.rs` and Waffle coreutils retain their current 0/-1 loops because argv/printenv/current utilities arm no timers; future timer consumers must adopt the canonical conversion. Existing bounded word-test drivers can stay unchanged when tests explicitly force due timers.
- Runtime cleanup tests live in crate-internal unit tests. Add a `#[cfg(test)] pub(crate) Runtime::waiter_count()` wrapper around support's read-only method in `runtime.rs`, or inspect through existing child-module access. Do not expect an external integration test to call a cfg(test)-only library method. This is test observation, not a new shipping public API.

### 3.4 Cleanup and race invariants

Timeout, Ctrl+C, dropping a command future and normal completion leave no registered timer, no extra runtime waiter and no admitted scratch buffer. A read that was Pending has consumed no bytes; trailing data remains readable exactly once. Already returned bytes are never discarded by a later deadline check. Test equal-time data/deadline ordering and cancellation/deadline ordering explicitly.

### 3.5 Non-consuming observation matrix

| Description | Zero-time observation | Positive timeout / actual read |
| --- | --- | --- |
| Missing fd | status 1 | normal bad-fd status |
| Local or runtime regular file, readable or write-only | ready, unchanged offset | ignore positive timeout; actual read still enforces READ permission |
| Null, including a write-only null descriptor | ready | normal EOF/read result; no manufactured payload |
| PipeRead empty with writer alive | not ready | may wait/timed read |
| PipeRead with data or with all writers closed | ready | data or EOF |
| PipeWrite with reader alive, even with buffered data | not ready | actual read fails |
| PipeWrite with no readers | ready error condition | actual read still fails |
| Capture output | not read-ready | actual read still fails |
| Unexported Bytes, empty/non-empty/EOF | ready, offset unchanged | canonical logical Regular classification, no positive deadline |
| BytesSource | ready, offset and source ownership unchanged | canonical logical Regular classification |
| Exported Bytes | delegate observation to host; never peek original buffer | keep logical descriptor-kind policy; read uses the export |
| Host | exact host observation, Unsupported is not guessed ready | exact host descriptor kind and read permission |

5.3.15 confirms that write-only regular and null fds can be ready even though reading fails. A write-only pipe with a live reader is not ready, but becomes ready on reader closure. Cover the same matrix in local Endpoint tests and real runtime tests. Assert unchanged offsets, buffer contents, registration counts and weak/last-close lifetimes. W1's single-subscription zero-time scan must not dispatch or delete other waiters, and must reject invalid ABI event counts/kinds/userdata.

## 4. `mapfile`/`readarray` design (bash-web PR B1)

### 4.1 Builtin surface (`builtins/mapfile.rs`, both names registered in `commands.rs` as `Builtin::Mapfile`)

`mapfile [-d delim] [-n count] [-O origin] [-s count] [-t] [-u fd] [-c quantum] [array]`, default array `MAPFILE`.
- Option parsing reuses the read-style loop. `--` ends options; unknown option → `invalid option` + usage, status 2; missing argument → status 2.
- `-n`, `-s`, `-O` and `-c` use the authoritative unsigned 32-bit range 0 through 4294967295, with ASCII leading/trailing whitespace and one optional sign as accepted by Bash legal-number parsing. The shared numeric lexer accepts `+1`, ` 1`, `1 ` and `-0`; a nonzero negative, empty value, fraction, overflow or trailing junk returns 1. `-n`, `-s` and `-O` accept converted zero. The `-c` semantic check rejects every zero spelling, including `0`, `+0` and `-0`, as an invalid callback quantum with status 1. `-n 0` means all.
- Numeric scans remain cooperative and resource-bounded, using the existing Work/Cancel pattern rather than an unchecked parse over an unbounded argument.
- `-O`: the same 32-bit value conversion, with `invalid array origin` on failure. Any explicit `-O`, including 0, selects Overlay. The producer cursor is i64; check progression rather than wrapping it. A later failing record never undoes earlier completed records.
- `-u`: non-numeric or negative → `<v>: invalid file descriptor specification`, 1; absent from the fd table → `<v>: invalid file descriptor: Bad file descriptor`, 1.
- `-d`: first byte of the value; empty → NUL.
- `-c`: validated after numeric conversion (`0` and `-0` → `invalid callback quantum`, 1). Without `-C` it has no effect, as in Bash.
- `-C callback`: **left out**. Honest rejection: diagnostic `mapfile: -C: callbacks are not supported`, status 2, before any input is consumed and with the array unchanged. Documented in `docs/mapfile.md`.
- Array name: the first operand; extra operands ignored (Bash). Invalid identifier (including `a[1]`) → `` `x': not a valid identifier``, 1.
- Validation order is options in order, then fd and operand name, then the resolved target. Missing option values return 2. Repeated valid value options use the last value; a bad earlier value stops immediately. Full nameref target validation and operation-phase mutation are specified in section 4.3. Validation failures consume no input.

### 4.2 Streaming records (`builtins/mapfile/records.rs`, ~120 lines; read.rs is not touched)

The read `Reader` is not reused: its escape bitmap, IFS trimming and character counting are read-only concerns, and sharing it would make both builtins edit `read.rs`. Shared helpers already in `builtins.rs` (`endpoint`, `diagnose`, `error_status`, `valid_name`, `scan_bytes`) are reused.
- One scratch record buffer admitted once at `context.limits().line_bytes` (work storage plus `context.admit_builtin_buffer`), plus a chunk buffer.
- Chunk size: 4096 when the effective count is unbounded, including `-n 0`; **1 byte with a positive `-n` limit**, so bytes after the last requested record stay unread for the next command (Bash reads unbuffered on pipes). Each chunk charges `scan_bytes(len)` cooperative work; reads use `read_cancelled(&context.cancel)`.
- Record = bytes up to and including the delimiter, or the EOF tail if non-empty. Value = record bytes up to the first NUL (C-string truncation, as observed); the delimiter is kept unless `-t` or truncated away. The ceiling counts raw record bytes, including the delimiter and bytes after a NUL. An overlong record returns 2 while retaining earlier published records. Validate UTF-8 only in the stored prefix before the first NUL: `x\0\xff\n` stores `x`. Invalid UTF-8 before that NUL returns 2 and retains the completed prefix. A trim removes a delimiter only when its actual byte remains in the stored prefix; do not remove an unrelated final character after C-string truncation.
- Skipped records (`-s`) are delimited and discarded without conversion. After `-n` records the loop stops reading.
- Pass a borrowed, UTF-8-validated prefix to the producer. It computes and admits the exact stored capacity before constructing a String, then publishes that record. No whole-input buffer, staged Vec of lines, or second retained payload copy. Failure behavior is the explicit table below.

### 4.3 State-owned incremental publication

New file: `shell/engine/src/state/producer.rs`, a child of `state` (`mod producer;` in `state.rs`). As a child module it may use `state.rs`'s private `reserve_local_value`, `held_local_value`, `snapshot_steps`, `snapshot_node_bytes` and `refresh_star_separator`. In `state/binding.rs`, only `Binding::indexed_header_bytes`, `Indexed::from_scalar` and `Indexed::tree_bytes` become `pub(super)`. Nothing else in `binding.rs` changes, and `BindingUpdate` is not extended.

```rust
pub(crate) enum IndexedMode { Replace, Overlay }   // Overlay iff -O was given (any value, including 0)

pub(crate) enum Rejection {
    InvalidTarget,   // resolved text is not an identifier (`a[1]`), or a nameref cycle/depth overflow: status 1
    Readonly,        // resolved target is readonly: status 1
    NoAssign,        // special_stack_array(target): FUNCNAME (while special), BASH_SOURCE,
                     // BASH_LINENO, BASH_ARGC, BASH_ARGV: status 1
    Unsupported,     // PIPESTATUS: status 2 (engine-owned producer, as expand/references.rs:167)
}
pub(crate) enum ProducerError { Rejected(Rejection), Exec(crate::exec::Error) } // Exec: resource or 130

/// No binding, no tickets, no staged values: dropping it at any await needs no finalization.
pub(crate) struct IndexedProducer {
    target: String,  // resolved key; its bytes admitted to Work in begin
    owner: super::references::Owner,    // reference_owner(target) at begin
    local: bool,     // a LocalVariable with a memory ticket owns the target
    next: i64,       // origin (Overlay) or 0, then +1 per stored record
}

impl State {
    /// Validation and Bash's operation-phase mutation. Runs after the builtin's option,
    /// fd and operand-identifier checks, and before any input (including -s skips).
    pub(crate) async fn begin_indexed_producer(
        state: &SharedState, operand: &str, mode: IndexedMode, origin: i64,
        cancel: &Cancel, work: &mut Work,
    ) -> Result<IndexedProducer, ProducerError>;
}

impl IndexedProducer {
    /// Publishes one completed record at `self.next`. `value` borrows the splitter's
    /// scratch and holds only the bytes before any NUL, already checked as UTF-8.
    /// `admit_live` is `|n| context.admit_builtin_buffer(n)` (returns exec::Allocation).
    pub(crate) async fn push(
        &mut self, state: &SharedState, value: &str,
        admit_live: impl Fn(usize) -> Result<crate::exec::Allocation, i32>,
        cancel: &Cancel, work: &mut Work,
    ) -> Result<(), ProducerError>;
}
```

### `begin_indexed_producer`

1. Charge validation lookup work without dynamic initialization: under a short immutable State borrow obtain `reference_work(operand)`, release the borrow, then call the existing `snapshot_steps(bytes, cancel, work).await`. This phase changes only Work/cancellation observations, not bindings, `ifs_members`, call-stack argument initialization or storage tickets. Do **not** call `admit_scalar_access` here: it can initialize IFS and BASH_ARGC/BASH_ARGV before rejecting the target.
2. Under a short `borrow()`, resolve with `resolve_scalar_target(operand)`:
   - `Cycle` or `DepthExceeded` → `InvalidTarget`. This keeps the engine's existing gap: Bash warns and returns 0.
   - Otherwise the target `t` must satisfy `Reference::parse(t)` with `subscript == None` and `name == t`. Otherwise → `InvalidTarget`, with the diagnostic naming `t`.
   - Then, in this order: `special_stack_array(t)` → `NoAssign`; `t == "PIPESTATUS"` → `Unsupported`; `is_readonly(t)` (the resolved target, never the alias) → `Readonly`.
   - None of these mutate state or consume input.
3. Only an accepted target may call `State::admit_scalar_access(state, operand, cancel, work).await`, after releasing the validation borrow. This retains the existing accepted-target initialization behavior without reordering that adapter for other scalar callers. The setup conservatively charges reference lookup again, once at command begin, never per record; it does not allocate a duplicate value or ticket. Revalidate the resolved key, owner and readonly state after this await before the operation-phase mutation. A semantic rejection discovered during step 2 must never enter this phase.
4. Decide the operation-phase image. `Replace` always becomes a fresh empty `Rc<Indexed>`: Bash's `array_flush`, even with zero records. `Overlay` depends on the current value:

   | Current value | New value |
   | --- | --- |
   | unset | fresh empty `Rc<Indexed>` |
   | `Scalar(v)` | `Indexed::from_scalar(v)`; the String moves, no copy |
   | `Indexed` | unchanged; no mutation and no copy-on-write here |

5. Admit before mutating:
   - **Work:** `t.len() * 2` for the key, plus `snapshot_node_bytes::<Binding>()` when `variables` lacks `t`, plus the new header `Binding::indexed_header_bytes()`, plus `Indexed::tree_bytes(1)` when converting a scalar. This is the arithmetic of `admit_binding_update`.
   - **Local ticket**, if `t` is local: `reserve_local_value(t, new_storage.max(held_local_value(t)))`. For Replace this usually shrinks. A failure leaves state unchanged.
6. Mutate synchronously, still before any input. Install the image. The previous `Rc` is dropped, so other holders keep their own copies. If `t == "IFS"`, call `refresh_star_separator()` (see "Hook policy").
7. `debug_assert!(self.assignment_undo.0.upgrade().is_none())`. The producer never touches a journal, never calls `prefixes.amend`, `reserve_effect` or `reserve_last_effect`, and never edits saved prefix values. A temporary prefix (`a=1 mapfile a`) therefore absorbs the writes, and the command's existing prefix restore discards them, as in 5.3.15.
8. Return the producer. `next` starts at `origin` for Overlay and 0 for Replace.

### `push`, one completed record

Every step before step 4 is fallible without mutating state. Step 4 cannot fail.

1. **Exact stored length.** Use the same predicate as `case_value`: a case mapping is applied only when it is not `Unchanged` and the target is not readonly.
   - No mapping, or ASCII input: `len = value.len()`.
   - Otherwise one pass over the characters sums `locale.map(ch)?.len_utf8()` (unmappable → `Exec(2)`). It charges `snapshot_steps(value.len())` because it is a second pass the splitter did not charge.

   No `String` exists yet.
2. **Work admission plus a one-time copy-on-write**, in a loop:
   - Under a `borrow()`: `copy = if let Some(Binding::Indexed(v)) = variables.get(t) && Rc::strong_count(v) > 1 { binding.storage_bytes() } else { 0 }`, and `node = v.insertion_bytes(self.next)`. Release the borrow.
   - `work.admit_storage(len + node + copy)?`, then `snapshot_steps(copy, cancel, work).await?` (the `write_element` pattern).
   - Re-borrow mutably. If the binding became shared after `copy == 0` was admitted, `work.release_storage(len + node)` and go back to the top of the loop.
   - With the merged code this happens only once per producer: the first Overlay write into an array also held by a subshell snapshot, a saved prefix or an enclosing scope. Replace targets are fresh and unique, so they never copy.
3. **Live and owner admission**, under the same `borrow_mut()` with no await from here to the end. Prechecks:
   - If `is_readonly(t)` → `Rejected(Readonly)`.
   - If `reference_owner(t) != self.owner` → `Exec(1)`. This is defensive: a builtin cannot change scope while it runs.

   Then compute `storage_after = binding.storage_bytes() + len + node - binding.slot(next).map_or(0, String::capacity)`. The old element's capacity is subtracted because Overlay may overwrite it.

   | Target | Admission | Exact allocation | On failure |
   | --- | --- | --- | --- |
   | Local | `reserve_local_value(t, storage_after.max(held))`; no live guard, the local's ticket covers the new bytes | `String::new().try_reserve_exact(len)` | shrink the ticket back with `reserve_local_value(t, previous)` (cannot fail), then `Exec(RESOURCE_STATUS)` |
   | Global | `let _live = admit_live(len)?`, the transient guard `read::assign_value` already uses; global durable bytes stay in Work storage only (current global accounting) | `try_reserve_exact(len)` | `Exec(RESOURCE_STATUS)` |
4. **Commit (cannot fail):**
   - Fill the String: `push_str(value)` and then ASCII case mapping in place, or `push(locale.map(ch))` per character.
   - `Rc::make_mut(values).insert(self.next, s)`. The binding is unique here, unless step 2 admitted the copy, in which case `make_mut` performs that admitted copy.
   - If `t == "IFS"`, refresh as in begin.
   - Advance `self.next` with checked arithmetic; reject an impossible next index before constructing the failing record, never after a published mutation. Drop `_live`.

`push` holds no borrow across an await and leaves nothing pending. Cancellation, an error or dropping the future at any point leaves every earlier record durable and the current one absent. Drop only releases scratch and guard allocations, synchronously and without allocating.

### Peak simultaneous allocations

- **Whole command:** the splitter's scratch record buffer (`line_bytes`) and chunk buffer, admitted once (Work plus a builtin `Allocation`).
- **Per record:** one exact-capacity `String`, and possibly one B-tree node growth. Case mapping writes straight into that String, so there is no second String (unlike `case_value`'s mapped copy).
- **Overlay over an existing element:** the old String is freed at insert, so for that one element old and new briefly coexist. Both are counted: the old in live storage, the new in admission.
- **Shared-tree Overlay:** one full tree copy at most once per command, admitted to Work with snapshot steps. A local's ticket is unchanged by the copy, because the other holder keeps accounting for its own tree.
- **Replace:** the target releases its old value at begin. An old value retained by a prefix frame, local shadow or subshell snapshot can still coexist with new records and remains charged to that owner. The new target tree is unique, so Replace adds no COW copy of the old payload. No staged tree, Vec of lines, or duplicate retained input is created.

### Hook and special-name policy

The producer bypasses compound assignment, so every hooked name is explicit. The engine's assignment hooks are exactly `IFS` (`refresh_star_separator`) and `OPTIND` (getopts cursor).

- **Readonly targets:** status 1, checked on the resolved target before input and re-checked per record.
- **Projected call-stack arrays** (`special_stack_array`): status 1 before input. FUNCNAME counts only while special; after `unset FUNCNAME` it is ordinary.
- **`PIPESTATUS`:** status 2 before input. This is the engine's element-write policy for its separately produced pipeline status. Bash returns 0, but the values are overwritten when the command ends; documented gap.
- **`OPTIND`:** published, with **no** getopts cursor update, matching 5.3.15 (`0 a 2` / `b 3`). If the engine's `getopts` reads the visible value rather than the hidden cursor and cannot match, record that as a documented gap. Do not add a hook.
- **`IFS`:** published. A direct `IFS` target calls `refresh_star_separator()` after begin and after each record, so the engine's IFS views stay coherent. Visible behaviour is then the engine's documented array-valued-IFS policy (`docs/indexed-arrays.md`: splitting disabled). 5.3.15 instead splits on element 0 at global scope while keeping `"$*"` space-joined. Test the engine result, label the Bash result, and document the gap. Do not invent a mapfile-only IFS mode.
- **Case attributes** (`-u`/`-l`): applied per element as above. `-i` does not exist in the engine.
- **Every other name** (`PATH`, `SECONDS`, exported names and so on) is an ordinary array target, with no environment effect.
- **Namerefs:** resolved once in begin. The key is held for the command, because no command can change scope while the builtin runs.

### 4.4 Record and failure policy

`-s` skipped records are delimited and discarded and never reach `push`. A skip-phase input error or end of input ends the command with status 0, after begin's Replace clear.

| Event | Record in progress | Earlier records | Status |
| --- | --- | --- | --- |
| End of input, empty tail | — | kept | 0 |
| End of input, non-empty tail | stored (no delimiter to strip) | kept | 0 |
| Input `IoError` other than `Cancelled` (write-only `File` → `BadDescriptor`, runtime errno, directory) | non-empty partial stored, like the end of input | kept | **0** |
| `Cancelled` (Ctrl+C, job cancel) | discarded | kept | 130 |
| `push` resource rejection (Work, live guard, local ticket, `try_reserve_exact`) | not stored; no state change for it | kept | existing builtin resource mapping (`error_status`) |
| Record longer than `line_bytes` (counting the delimiter and any bytes after a NUL) | discarded; its consumed bytes are lost | kept | 2 |
| Invalid UTF-8 in the stored prefix (before the first NUL) | not stored | kept | 2 |
| Unmappable character under a case mapping | not stored | kept | 2 |
| Rejection in begin | — | untouched, input unread | 1 or 2 as above |

The redirection layer still decides whether `< /` opens at all. If Waffle refuses to open a directory for reading, the command fails before mapfile runs, and that test uses the injected-error endpoint below instead.

## 5. PR units, sequencing and worker scopes

| Unit | Repo | Depends on | Scope (files) | Worker |
| --- | --- | --- | --- | --- |
| R0 | — | — | Independent Sol review of this plan; parent applies findings | Sol (review only) |
| W1 | Waffle | R0 | `packages/program-support/src/{executor,io,runtime}.rs` + tests (section 2); optional coreutils driver | Waffle coordinator's lane |
| B1 | bash-web | R0 | `state/producer.rs` (+ `state.rs` mod line), `state/binding.rs` narrow visibility changes, `builtins/mapfile.rs`, `builtins/mapfile/records.rs`, `builtins.rs` dispatch line, `commands.rs` (+ `commands/tests.rs` lists), `shell/engine/tests/words/mapfile.rs` + `tests/words.rs` mod line, `scripts/test-own-shell-mapfile.ts` + new recorded fixture, `docs/mapfile.md`, `docs/README.md`, `docs/status.md` row 72, `docs/indexed-arrays.md` producer paragraph, `docs/shell-engine.md:293` wording, new `sources.lock.json` classification entry `shellMapfile` (original code; no pin change). Also commits this plan as `plans/009-read-timeouts-and-mapfile.md`, adds it to `plans/README.md`, and points plan 007's follow-up section at it. | Sol |
| B-adopt | bash-web | W1 released | Standard Waffle runtime update (automation or parent) moves the runtime and the support `rev` together. Not part of this plan's workers; no pin activation here. | parent/automation |
| B2 | bash-web | B1 merged, B-adopt merged | `builtins/read.rs`, `builtins/read/timeout.rs`, `interpreter.rs` (Context timer accessor and crate-internal cleanup/race tests), `runtime.rs` (cfg(test) waiter observation if needed), `runtime_main.rs` (two lazy-clock poll sites and direct support import), `compat.rs` (idle branch), `shell/engine/tests/words/read_timeout.rs` + mod line, `scripts/test-own-shell-read-options.ts` (or a new `test-own-shell-read-timeout.ts`) + recorded fixture, `docs/read.md` (remove "timers" from the out-of-scope list, add timeout/TMOUT/readiness rules and omissions), `sources.lock.json` `shellReadCount` checks list if it enumerates tests | Sol |

B1 starts immediately after R0, in parallel with W1. B1 and B2 both edit `shell/engine/tests/words.rs` and `sources.lock.json`; B-adopt also changes the lock/pins. These shared write sets are sequential: B2 rebases after B1 and B-adopt. Other feature files remain disjoint. Neither edits the frozen cases, the floor, `docs/evidence/`, existing `scripts/fixtures/` files or pins.

Early B2 parser-only work, if useful, uses its own T3-provided tree and rebases the shared files after dependencies land. It must not change shared files concurrently or open a merge candidate with a stubbed timer. If W1 slips, B2 waits (section 9).

## 6. Tests

Fail-before means: run on `origin/main` before the change, record the failing output in the PR, then pass after.

B1 native and state tests:
- Keep the full record contents, delimiter, empty-line, tail, NUL, positive-count read-ahead and origin/skip matrix. Add the 32-bit numeric boundary/sign/whitespace/missing/repeated-option cases from section 4.1, including `-c 0`, `-c +0` and `-c -0`.
- Reject a resolved indexed nameref such as `a[1]` before input; test readonly alias versus readonly resolved target, all five projected stack names, de-specialized FUNCNAME, local shadows, IFS/OPTIND policies and ordinary exported targets. Document the explicitly bounded special-target gaps rather than claiming Bash parity for those rows.

The following tests complement the option, numeric and target matrices and prove incremental publication. Add each to `shell/engine/tests/words/mapfile.rs` or the state unit tests, fail-before where the feature is absent.

1. **Interruption leaves the completed prefix.** `a=(old keep)`. Feed an in-process pipe `first\nsecond\nunfinished` and keep the writer open. Drive until the builtin is pending, then:
   - (a) Inspect `state.borrow()`: `a` is exactly `(first second)` at the interruption point. This is what an INT trap would see.
   - (b) Cancel → 130. Then `declare -p a` in the same session prints `(first second)`.
   - (c) If the engine runs INT handlers on interruption, add `trap 'declare -p a' INT` and assert the trap's output. `docs/trap-registration.md` describes registration only. Running INT handlers is not part of this unit; if they don't run, (a) and (b) are the required proof and (c) is recorded as not applicable.
   - Repeat with `-O 1` on `(o0 o1 o2 o3)` → `(o0 first second o3)`.
2. **Injected input error after two complete records.** A test `HostEndpoint` yields `x\ny\npart`, then `Err(IoError::Runtime(5))`.
   - Replace → status 0, `(x y part)`.
   - Overlay `-O 1` on `(o0 o1 o2 o3 o4)` → status 0, `(o0 x y part o4)`.
   - Write-only `File` descriptor: Replace → 0 and `()`; Overlay → 0 and unchanged.
3. **Limits and UTF-8 keep the prefix.**
   - Records `a\n`, `b\n`, then a third whose `push` exceeds Work storage by one byte → `a` is `(a b)`, the third is absent, the status is the resource mapping, and both budgets are back at their pre-record level.
   - Same shape with an over-long third record → 2 and `(a b)`.
   - Same shape with invalid UTF-8 → 2 and `(a b)`.
   - `x\0\xff\n` stores `x`.
   - A local target whose ticket growth fails on record 3 → `(a b)`, and the ticket equals its size after record 2.
4. **Prefix, local, nameref:**
   - `a=(x y); a=1 mapfile -t a <<<z; declare -p a` → `(x y)`.
   - In a function, `local a=(L1 L2); a=1 mapfile -t -O 1 a <<<z` → `(L1 L2)`.
   - A local shadow leaves the global unchanged. A local scalar converted by Overlay works.
   - `declare -n r=t` writes `t`.
   - `declare -n r='a[1]'` → 1, `a` unchanged, and the next `read` sees the first input line.
   - A readonly target through a nameref → 1, input unread.
   - Rejected direct/aliased BASH_ARGC/BASH_ARGV and every rejected projected/readonly/invalid target leave argument initialization, pending IFS snapshot/members, binding/local-ticket memory observations and input unchanged. Install both pending IFS and uninitialized argument-state preconditions; force their initialization budget to be insufficient and verify the target rejection still wins without entering the initializer.
   - The five stack arrays → 1 in a function, and `unset FUNCNAME` → 0.
   - `PIPESTATUS` → 2.
   - `OPTIND` and `IFS` as in the policy above (engine result asserted, 5.3.15 result labeled).
   - `declare -u`/`-l` targets, including Overlay keeping the old elements.
5. **Operation phase:**
   - Replace with zero records → `()`.
   - Replace with `-s` past the end → `()`.
   - Overlay on an unset name → `()`.
   - Overlay on a scalar with no records → `([0]=one)`.
   - `-O 0` keeps the higher elements.
   - Repeated overwrites of the same indices across two commands.
6. **Copy-on-write and refunds:**
   - Overlay into an array also held by a live subshell snapshot copies once. Work is charged once; the snapshot is unchanged.
   - Overlay into a unique array never copies.
   - With `StorageBudget::observation()`, after completion, cancellation and dropping the future: execution memory is back to baseline; the local tickets after the function returns are back to baseline; the producer leaves no reservations.
   - A 10,000-record Replace and an Overlay succeed at default limits. Assert linear work: no per-record whole-tree copy. `write_element`'s `image()` clones the tree per element, which is why the producer does not use it.

B2 native (`shell/engine/tests/words/read_timeout.rs` + parser unit tests in `read/timeout.rs`):
- Parser table: every authoritative 5.3.15 numeric boundary in section 3.1 and PARENT-RESOLUTION-PROBES.json, plus malformed and repeated/missing arguments. Do not use only the older 5.3.20 table.
- `-t 0`: empty open pipe → 1, non-empty pipe → 0 with input still readable, closed pipe → 0, `/dev/null`/`Null` → 0, here-string → 0, `-u` write-only regular/null → 0, live write-only pipe/Capture → 1, pipe with no readers → ready error observation, missing fd → 1, `1bad` name not validated, old value kept.
- Timed: open empty pipe + forced `fire_timers` → 142 with `[]`; `ab` written then expiry → 142 `[ab]`; two names → field split of the partial input; `-N 5` partial; `-d ''` partial; readonly final name → 1; data before the deadline → normal 0; EOF before the deadline (`read -t 0.5 </dev/null`) → 1 (re-earns `oils:builtin-read:605`); `-t -0.5` → 1 before input (re-earns `oils:builtin-read:619`).
- `TMOUT=0.2` applies; invalid/zero/negative `TMOUT` ignored; `-t 0` overrides `TMOUT`.
- Applicability: a 65,536-byte counted read from a local Regular and a real runtime regular file ignores a positive microsecond timeout, even across cooperative turns and forced timer firing. Assert no read timer was registered. The matching pipe/terminal cases can expire. Cover logical Bytes/BytesSource and exported descriptions explicitly.
- Arming and order: an always-ready non-regular input has a registered timer before its first reader checkpoint. Force expiry across a drive turn and assert partial assignment plus unread trailing data. Queued data with a timer already fired is not consumed; data returned in the poll that first observes expiry is retained; cancellation already pending with expiry keeps its cancellation status. For pipe and runtime endpoints, dropping a Pending read removes its waiter and leaves queued data readable exactly once.
- Cleanup per section 3.4: after timeout, after Ctrl+C and after dropping the future, `next_deadline()` is `None` and the admitted buffer is refunded.
- Unchanged behaviour: all existing `read` tests and `scripts/test-own-shell-read-{scalar,exact,options}.ts` pass untouched.

Real runtime (production Waffle through the maintained harness):
- B1 replays ordinary contents/options/state against recorded 5.3.15 observations, including the real negative-origin case. Tests for documented engine-only special-name/UTF-8 limits remain explicitly separate from claimed Bash-parity fixtures. Model interrupted state in the same Session when INT trap execution is not implemented; never add traps as an undeclared prerequisite.
- B2 busy fairness uses a supported harness-owned pipeline: `{ printf ab; while :; do :; done; } | { IFS= read -r -t 0.3 x; status=$?; printf 'TIMEOUT:%s[%s]\n' "$status" "$x"; }`. Observe `TIMEOUT:142[ab]` while the producer is still runnable, then interrupt and drain that owned foreground group in `finally`. Do not wait for the deliberately infinite producer to exit naturally. No SECONDS variable or new sleep utility is needed.
- B2 timer-only idle coverage types `read -t 0.3 x; echo $?` into the maintained interactive harness with no other pending work and expects 142 within a generous correctness bound. Always clean up the job and prove the borrowed runtime remains usable. Test production matching service/wake ownership and the existing fallback embedding separately.
- `npm run compat:shell` must retain all current genuine floor passes. B1 re-earns `brush-suite:builtins/mapfile:10`; B2 re-earns `oils:builtin-read:605` and `:619`. They return through ordinary main accumulation, with no floor or frozen-case edit.

Oracle: new recorded fixtures must carry `GNU bash, version 5.3.15`. This host's `/usr/bin/bash` is 5.3.20. Record on a host with 5.3.15 or build GNU Bash 5.3 with official patches 001 to 015 in `/work/tmp/bash-web-oracle-5315-XXXXXX` (or on boat) and run the recording with that binary bound at `/usr/bin/bash` (bubblewrap). If 5.3.15 cannot be obtained in one bounded attempt, stop and report; do not record 5.3.20 into a 5.3.15 fixture. Any 5.3.15 result that differs from `bash-5.3.20-probes.txt` wins and is noted in the PR.

## 7. Commands and hosts

Per PR, use the worker's actual T3-provided isolated tree. Do not create an extra checkout or assume a fixed `/work/worktrees` path:
- `npm run test:rust`
- `LAYERS_BASE_REF=$(git rev-parse origin/main) npm run check:layers`
- `npm run sources:browser && npm run build:worker && npm run build:node-harness && npm run quality:js` (B1 and B2 add TypeScript tests)
- WASI: `WASI_SDK_PATH=<wasi-sdk 34.0> npm run build:shell`, then `node --test scripts/test-own-shell-mapfile.ts` (B1) / the read timeout replay (B2), and `npm run test:shell:wasi`
- `npm run compat:shell` (real frozen instrument; must not lose a passing case)
- B2 also: `npm run test:runtime:terminal` if the interactive harness is used.
- W1 (Waffle): `cargo test --locked -p waffle-program-support` plus the repo's own checks.

Correctness runs go to boat whenever the PC heavy queue has a wait: `bun ~/.agents/skills/machine-fleet/scripts/boat-job.ts bash-web <commit> -- <command>` (committed work only). No performance timing on boat; the timer tests assert behaviour with second-scale margins, never speed.

## 8. Checkpoints and stop rule

- R0 → one review round, parent fixes. Opus returns only for a redesign finding.
- W1: first checkpoint is the merged Waffle commit and release tag. If the coordinator has not accepted the request within one working day, report under owner decisions; B1 continues regardless.
- B1: checkpoint after the producer + basic `mapfile -t` (fail-before tests green) and again before PR review. Two rounds without progress (or about two hours stuck on one problem): stop, record state, report.
- B2: checkpoint after parsing + `-t 0` (needs W1's `read_ready`), then after timed reads + drivers.
- Done means merged PRs with the corrected cases passing on main's score, docs updated, and cleanup verified.

## 9. Unresolved or owner-level choices

1. **Interactive `TMOUT` auto-logout** (Bash exits an idle interactive shell): left out. It changes session lifetime under the public prompt API, and an idle browser terminal that closes itself is likely unwanted. Owner decides if it is ever wanted.
2. **`mapfile -C` callbacks** remain explicitly unsupported with a status-2 rejection before input or mutation. Incremental publication makes future callbacks possible, but evaluator re-entry is outside this unit.
3. **Per-record publication** is mandatory. The staged atomic alternative was rejected in R0 and withdrawn. Earlier completed records survive interruption and input errors without an async/allocating Drop commit.
4. **Waffle API shape**: if the coordinator prefers timers outside `Executor` (a separate `Timers` handle), bash-web still needs it reachable from builtins without changing `Session::new`; that would require threading it through `Context`, a redesign trigger for this plan.
5. **Numeric behavior** is no longer deferred as a 5.3.20 quirk. The authoritative 5.3.15 width/sign/fraction behavior is specified in section 3.1 and required in parser fixtures.
6. **Raw bytes** in `mapfile` values and records over `line_bytes` remain status 2 (engine UTF-8 scalars), consistent with `read`.

## 10. Cleanup

This design step created only this directory (`PLAN.md`, `bash-5.3.20-probes.txt`, a few KB). Probes ran `bash -c` with no files left, apart from one `/dev/shm/t0probe` file that the probe itself removed. Workers install teardown first: record pre-existing worktrees, `/work/tmp` scratch, boat jobs; remove their worktrees with `git worktree remove`, any owned Bash 5.3.15 extraction/build tree and bubblewrap roots, Node harness outputs under their worktree, and boat job artifacts; keep shared caches (`/work/cache/cargo*`, npm caches, wasi-sdk). Remove this report directory after B2 merges and the plan text lives in `plans/009-read-timeouts-and-mapfile.md`.
