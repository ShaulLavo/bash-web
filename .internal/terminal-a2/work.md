# Terminal A2 execution

Status: Approved.

Author checkout is `/work/worktrees/bash-web/terminal-a2-multiline`, based exactly on A1 `3bd992b9778f0c1f267ce269cd21c983c09b7d69`. Draft PR is #174 and depends on #173. No guest release or deployment belongs to this task.

## Ownership and teardown

Before setup this checkout had no dependency, build, browser profile, server, or test processes. Shared services and caches are not owned by this task. New resources are this checkout, its node_modules/.sources/.build/public/dist outputs, runner job processes, and temporary Playwright profiles. Test wrappers use traps before execution. Playwright owns and closes its server, browser and context. Runtime fixtures dispose their supervisor, descriptors and input pipes in finally. Keep the clean author checkout until the coordinator releases it. Audit its live cwd processes before handoff.

## Throughput checkpoint

- Blocking first steps. Read the design, exact A1 source and existing discovered tests, then add failing regressions before implementation.
- Independent workstreams. No fan-out is allowed. Rust/editor/runtime/browser behavior has one author.
- Shared mutable state. Only the exclusive checkout is writable. Package-manager and Cargo source caches remain shared; build outputs stay checkout-local.
- Smallest safe decomposition. Byte tests precede display/runtime and browser checks. One owner keeps prompt state, paint positions and submitted bytes consistent.

## Data shape and trace

Browser Terminal.paste encodes the paste according to DECSET 2004 and forwards bytes through BrowserSession and SharedBridge. Waffle's shell input endpoint supplies those bytes to runtime_main's interactive read loop. Editor owns the command buffer, cursor, escape state and painted position. The runtime owns prompt and command phase transitions.

Paste is a separate bounded state with a short possible closing-delimiter prefix. It owns normalized bytes until the closing delimiter, so no pasted byte reaches command dispatch. Overflow drops text while continuing to recognize the delimiter. The line and paste together stay within 64 KiB. The runtime enables paste with its prompt and disables it before releasing input for commands or exit.

## Decisions

- Model the Domain and Foundational Thinking keep paste framing separate from A1's key parser. A1 remains the owner of CSI/SS3/Meta parsing.
- Laziness Protocol keeps redraw and row accounting in Editor, and prompt mode changes in the existing runtime loop.
- Build the Lever and Prove It Works use discovered Rust, runtime and browser tests as rerunnable evidence.
- Sequence Verifiable Units retains a failing-first test commit before the fix.
- Architect parallel exploration is skipped because the design is approved and this task forbids agents. Independent review belongs to the coordinator.

## Scope coordination

The coordinator assigned Enter/interrupt from an earlier wrapped row, lines taller than the viewport, and the incomplete scalar width table to Opus. A2 does not implement those fixes. Its browser case submits from the buffer end and verifies multiline hard breaks, wraps, width resize, shortening, and the caret within the viewport. A2 extracts the byte-reading loop into `PromptRead` and centralizes mode cleanup in `finish_prompt`, which is the runtime integration point for a later display finish operation. Editor adds `Action::Bell` and a third CSI parameter for the two approved Shift+Enter encodings. These are the only changed internal contracts.

The UTF-8 cap regression reproduces on A1 with `valid_up_to: 65535, error_len: None`. Both ordinary insertion and paste now reserve a full scalar's bytes when seeing its leading byte. A scalar that cannot fit is dropped, including later continuation bytes. Paste overflow remains latched until its end delimiter and rings once.

The first WASI build failed because cmake and ninja were not on PATH. They are supplied through `uv run --no-project --with cmake --with ninja`, using the shared `/work/cache/uv`, without changing system configuration. The actual build still uses the pinned Waffle builder and WASI SDK 34.0. The Mac was checked twice and was reserved by another agent before A2 could acquire its lock. No Mac files or processes were created.

## Integration checkpoint

A1 #173 merged as `b8d7d16b600968523ac6165275852c2a552014db`. A2 merged `origin/main` without force-push in `eb6907d6`. The merge conflicted because #173 was squashed. `git diff 3bd992b9778f0c1f267ce269cd21c983c09b7d69 origin/main -- shell/engine/src/terminal.rs` was empty, so the A2 terminal file was kept intact. `git diff 9357c7cd eb6907d6 --stat` was empty. There was no source change from this history alignment and no wait for main CI.

## Real-display correction

The first Chromium run passed paste submission and Shift+Enter, then caught a multiline edge the ASCII model missed. With a hard newline immediately after the right margin, `EL0` erased the last printed cell because the native cursor still addressed that cell while wrap was pending. A2 now emits CRLF directly at the margin and uses `EL0` before CRLF only when a row has an unpainted tail. The existing margin/multiline display case now models EL0's native cursor clamp. This is within L3's hard-newline redraw, not A3's earlier-row submission or viewport-height work.
