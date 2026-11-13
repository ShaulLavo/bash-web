# Process image replacement

Command-bearing `exec` replaces the shell image through Waffle's
`runtime_proc.exec` operation. The process keeps its PID, parent, job,
descriptors and cancellation ownership. Its parent observes completion only
when the final image exits.

`exec` accepts `--`, `-a name`, `-c` and `-l`. Prefix assignments contribute to
PATH lookup and the effective environment. `-c` clears the entire replacement
environment, including prefix assignments, after lookup. Invalid options return
2 and leave the reader running. Redirections persist when replacement
fails. A failed command lookup returns 127; other replacement failures return
126. Noninteractive shells exit after failure, while interactive shells continue.
`exec` without a command retains its existing persistent-redirection behavior.

In `-c` mode, a parser-approved final external command can replace the shell
automatically. Eligibility requires the complete source to have been consumed
without a deferred parse error. Traps, live or unreaped jobs, pending cleanup,
redirections, buffered input, pipelines, background work, timing, negation and
nested interpreter constructs prevent this optimization. Interactive shells and
script files keep their ordinary execution path. Unsupported automatic
replacement falls back to spawning a child.

The replacement receives a complete descriptor list and the original root
preopen capability. A user descriptor at 3 takes priority; the root occupies
the lowest available descriptor at least 3. Shell-pumped input cannot be
transferred and prevents replacement.

Command-bearing exec inside a synthetic pipeline stage, subshell, background
task or command substitution returns 126. Those tasks share the shell image
and cannot replace it independently. Functions and unredirected brace groups
can use explicit exec in the calling shell.

Rust tests cover options, lookup failures, persistent redirects and eligibility.
The Node scoreboard discovers `scripts/test-own-shell-exec.ts`; the browser
suite discovers `tests/exec.spec.ts`. Both exercise real Worker replacement
with source bytes and prepared modules, including cancellation and final-only
completion.
