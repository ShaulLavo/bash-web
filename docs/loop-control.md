# Break and continue

`break` leaves the requested number of enclosing loops. `continue` starts the
next iteration of the requested loop. Both accept an optional signed decimal
count, including surrounding ASCII whitespace, and an optional `--` before it.
Counts larger than the active loop depth target the outermost loop.

A nonpositive count leaves every enclosing loop with status 1. A nonnumeric or
out-of-range integer exits the reader with status 2. Extra operands exit with
status 1. In an interactive shell, these errors abort the submitted command
without closing the session. Outside a loop, both commands return success before
checking operands.
Function and subshell boundaries retain their existing loop-target rules.

Inside a loop, `--help` prints a brief usage message and returns status 2 without
leaving the loop. After `--`, the same word is a numeric operand, not an option.

The frozen operand case and nearby loop controls run through production Waffle
in `scripts/test-own-shell-loop-control.ts`. Their observations are copied from
the immutable Bash 5.3.15 oracle, not captured from the machine running the tests.
This change does not cover enclosing-loop control in substitutions or `continue`
in an `until` condition.
