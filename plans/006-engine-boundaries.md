# 006: Engine boundaries and a Lite build

Status: Approved (owner, 2026-10-18)

## Goal

The shell engine stays separable as compatibility grows, so a product can ship only the shell features it needs. Behaviour of the full build doesn't change; this is ownership and dependency direction, plus a second build that keeps it honest.

## Problem (bash-web main 9bc9d40)

- **Shared machinery lives in feature modules.** `state.rs` takes `StorageAllocation`, `StorageBudget`, `RESOURCE_STATUS` and `RetainedStorage` from `interpreter/eval.rs` and `interpreter.rs`. It also imports `expand::{Error, Work}`, so layer 2 currently imports layer 5. `expand.rs` uses `arithmetic::ArithmeticFuture` and `arithmetic::fault`, while `expand/positional.rs` uses `arithmetic::fault` and `arithmetic::evaluate` for ordinary expansion. Budgets, resource status, async results and shared error/work types are owned by feature modules (`eval`, `arithmetic`, `expand`) and consumed throughout the engine.
- **Variable state has three restoration paths.** `interpreter.rs` `BuiltinPrefixFrame` (around line 2728) inserts into and restores `state.variables` directly, bypassing the scalar-target and readonly checks in `state::PrefixFrame::set`. `state.rs` has its own `PrefixFrame` and `FunctionFrame`, so temporary bindings restore through `state.prefixes`, `locals`, or the interpreter frame. `expand/case_pattern.rs` also writes `state.variables` directly.
- **Command knowledge is spread across string lists.** Declaration recognition (`builtins.rs:28`), the `is_builtin` list (`builtins.rs:84-90`) and dispatch (`builtins.rs:339`) each list declaration names separately. Here-document handling (`interpreter.rs:2940-2943`) and `command -v/-V` (`interpreter/command_builtin.rs:260-262`) add different exclusion lists, `cat | seq` versus `cat | grep | mkdir | seq`.
- **No build variants.** `shell/engine/Cargo.toml` has no features, so nothing shows when a feature quietly couples to another.

## The score

`npm run check:layers` counts unique top-level source-to-target dependency edges that break the allowed graph below, separately for production and test-only code. It scans rooted Rust paths, not comments or literals, and records source locations and an engine-source digest in `docs/evidence/engine-layers.json`. Both counts only go down; the target is 0. Committed HEAD and an immutable target ref prevent a candidate evidence update from hiding a regression. Exact evidence is refreshed explicitly when engine sources change.

Static edges cannot prove capability independence. Step 6 adds separate Full/Lite compile-and-test jobs; a capability violation fails that matrix rather than being guessed by the lexical script. Until then compile capability status and binary sizes remain explicitly unmeasured. The full build's compatibility score (`npm run compat`, an alias of the existing `compat:shell` command) must not lose a single frozen case. The Lite build's raw and gzip sizes are recorded beside the layer score for information.

Allowed direction, lower layers never importing higher ones:

1. `exec` (new): execution frames, storage budgets, retained allocations, source ownership, `RESOURCE_STATUS`, `Work`, `Frame`, `RetainedStorage`, shared async result and fault types.
2. `state`: variables, scopes, functions, options. Owns every write to binding storage and imports only lower-layer execution types.
3. `parse` (new facade): one internal entry point per parsing context, delegating to today's parser.
4. `commands` (new): typed command metadata (declaration utility, special builtin, regular builtin, keyword, availability per capability).
5. `expand`, `arithmetic`, `builtins`, `interpreter`: features, which may depend on 1-4 and on each other only where the graph lists it.

### Exact internal graph

Each row enumerates permitted imports. Self and child-module edges do not count.
External parser AST types remain usable; this first gate checks internal Rust module paths, not dependency-crate APIs.

| Owner | Permitted internal targets |
| --- | --- |
| `executor` | none |
| `io` | `executor` |
| `process` | `executor`, `io` |
| `runtime` | `executor`, `io`, `process` |
| `exec` | `executor` |
| `state` | `executor`, `exec` |
| `parse` | `executor`, `exec` |
| `commands` | `parse`, `exec` |
| `ast_copy` | `executor`, `exec`, `parse` |
| `arithmetic` | `executor`, `exec`, `state`, `expand`, `parse` |
| `expand` | `executor`, `exec`, `state`, `parse`, `arithmetic`, `ast_copy`, `io`, `interpreter` |
| `builtins` | `executor`, `exec`, `state`, `parse`, `commands`, `expand`, `interpreter`, `io` |
| `interpreter` | `executor`, `exec`, `state`, `parse`, `commands`, `arithmetic`, `expand`, `builtins`, `io`, `process`, `ast_copy` |

The feature cycles are deliberate. Arithmetic scalar values use expansion and expansion evaluates arithmetic; builtins consume interpreter context and the interpreter dispatches builtins; expansion invokes the interpreter's substitution runner. This plan moves shared data down without rewriting those execution protocols. It does not impose a false total order on cooperating features.

`lib`, `main`, `runtime_main`, `compat` and `terminal` are composition roots with explicit allowances in the checker, never a wildcard. Unknown owners and unknown rooted targets fail closed. Rooted `crate::` paths, grouped `use` trees and conventional relative `self`/`super` paths are checked; Rust alias resolution and macro expansion are outside this lexical contract. Literal paths inside macro bodies are scanned.

Test-only edges are recorded independently. Four explicit fixture allowances permit `builtins -> process`, `expand -> process`, `process -> interpreter` and `runtime -> interpreter` only in test scopes. These fixture dependencies do not make production imports legal. Instrumentation edges `executor -> interpreter` and `state -> interpreter` remain violations until their shared measurement types move with step 2.

## Steps

Each step is a behaviour-preserving PR with zero compatibility losses, independent review and merged green before the next starts.

1. **Layer check.** Add `check:layers` (TypeScript script over `use crate::`/`crate::` paths in `shell/engine/src`), the allowed graph, and the baseline count. CI fails on any increase.
2. **Shared execution types.** Move budget, allocation, frame, scope, `Work`, `Error`, `RESOURCE_STATUS`, retained-storage and async-result/fault types out of `interpreter/eval.rs`, `arithmetic.rs` and `expand.rs` into `exec`. `state` and `expand` stop importing `eval`, `arithmetic` and `expand` for these shared types.
3. **One owner for bindings.** `state` owns every privileged mutation and restoration guard. Callers ask for operations: read or assign a parameter, enter a temporary-binding scope, enter a function scope, snapshot a subshell environment, restore. `BuiltinPrefixFrame` and `state::PrefixFrame` become one mechanism. Distinct bash behaviours stay distinct operations; nothing collapses into a generic setter.
4. **Parsing facade.** Script, `eval`, generated words, lazy operands and command substitution enter through `parse` with their source, options, budgets and capability policy. Day one it calls exactly today's code.
5. **Command metadata.** One typed table in `commands` drives declaration recognition, dispatch, `command -v/-V` and here-document errors. A `type` builtin is not present in the current engine, so adding it is separate compatibility work. Literal declaration syntax and expanded command names stay separate phases.
6. **Lite build.** Additive Cargo features, one per optional capability, and two presets: `full` (all features, the compatibility target) and `lite` (the product's set). CI builds and tests both, as separate builds, never both feature sets in one. Compiled capabilities stay separate from `set`/`shopt` options. Lite starts equal to Full except one measured optional capability, so the mechanism is real from the start. Pick it by measuring which feature costs the most WASM bytes; the `regex` dependency behind `[[ =~ ]]` is the first candidate. An omitted capability fails clearly: an omitted builtin behaves like a missing command (127), and omitted syntax is a syntax error (2) whose message names the capability and the build.

## Rule for new compatibility work

From step 6 on, every new compatibility family's PR states: the owning subsystem, the capabilities it depends on, whether it's core or optional, that the build without it still compiles and passes its contract, and what an omitted operation does. Reviewers check the layer count didn't rise.

## Sequencing

Structural moves conflict with feature lanes. Before the PATH search PR (#10) merges, work is restricted to a worktree from `origin/main`, source verification and plan corrections, precise graph design, and new layer-check/baseline files. Package/CI wiring and step 2 onward wait for #10 to merge. Merge main normally before continuing. No new compatibility climb lane starts while a structural step is open. Steps after 2 run back to back. The startup-diagnostics lane owns PR #11 and its waffle pin; do not edit either lane's worktree.

## Not in scope

Changing bash behaviour, rewriting the parser, or deciding the final Lite contents. Lite grows into the product's set when the product defines it.
