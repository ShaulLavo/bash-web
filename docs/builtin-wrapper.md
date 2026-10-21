# Builtin wrapper

`builtin echo text` selects the existing shell builtin instead of an `echo`
function. The wrapper runs in its caller, so `cd`, `read`, scalar `printf -v`,
`shift`, `return`, loop control and `exit` keep their existing state and flow.
The wrapper does not parse another script or create a shell or function frame.

`builtin` and `builtin --` with no target return zero. Unknown names, keywords
and external commands return one without asking the process host to find or
spawn them. Invalid options return two. Target options pass through unchanged.
Wrapper operands use ordinary word expansion, including assignment-looking
words. This does not add declaration syntax through a wrapper.

Functions can shadow `builtin` itself. Each executed wrapper selects the next
lookup policy: `builtin command cat` permits external lookup, while
`command builtin cat` does not. Nested queries retain `command`'s existing query
rules. Iteration shares the command's work budget, yields for cancellation,
and consumes owned arguments without repeatedly moving the remaining vector.

Diagnostics use redirected stderr and the current lexical expansion line.
An absent hint omits the numeric label rather than inventing line 1. The hint is
not a resolved Bash execution coordinate. Closed stderr is silent.
Invalid options retain status two when stderr is read-only or closed; diagnostic
cancellation returns 130 and a broken pipe returns 141.

## Boundaries

This is ordinary builtin-wrapper dispatch, not complete Bash builtin coverage.
The existing direct `exec` phase is not made callable through wrappers.
`command exec` keeps its historical external route; a builtin-only target with
no executable interpreter handler is rejected without host access. Existing
`eval`, `let` and declaration limitations are unchanged. Bash's `--help` text is
not implemented by this wrapper.

Execution-diagnostic provenance is deferred to a separate Approved family in
[plan004](../plans/004-own-shell.md#builtin-diagnostic-coordinates-later-family).
This extraction selects dispatch and the local R2 status policy from
`c97110ea..9064cab`, excluding the later parser, printer, function and substitution
coordinate changes. Existing command diagnostic writers stay unchanged, including
their known gaps. R1 coordinate parity is not cleared.

This PR does not provide `Context::diagnostic_line`. Exact getopts binding-error
prefixes remain blocked on an independently owned resolved-coordinate contract.
Ordinary getopts option diagnostics are untouched.

## Provenance and controls

| Area | Classification | Source and changes |
| --- | --- | --- |
| Catalogue, wrapper dispatch and diagnostics | Original local adapters, no copied upstream implementation | Extends bash-web `c97110ea689cd055137ff8ffef215b6cf20853f6`, `shell/engine/src/commands.rs` and `interpreter.rs`; adds `interpreter/builtin_wrapper.rs` for options and line-labelled descriptor writes. Existing target bodies are reused unchanged. |

Native and WASI controls live in `tests/words/builtin_wrapper.rs` and the existing
command adapter unit tests. They cover shadowing, nested policy, caller flow,
assignment-looking operands, prefix restoration, diagnostics, iterative chains,
work exhaustion, cancellation and zero external access for rejected targets.
The bounded production-Waffle observations are preparation evidence, not a full
compatibility measurement or an accepted score change.

The later wrapper controls retain their status, output bytes, named message order,
redirected destination, lazy skipped-operand and cancellation/refund assertions.
Only the explicitly named new `builtin` message slots ignore decimal coordinates
in those semantic controls. Their original coordinate assertions remain at
`0253be6:shell/engine/tests/words/builtin_wrapper.rs` and in the deferred report
inputs. This is not whole-output parity. The complete 207-script probe compares
stdout, stderr and status without projection. The frozen 9,221-case replay keeps
its unchanged stdout/status scoring and records stderr separately.
