# Negative extglob matching

The shell's core pattern matcher supports `!(pattern|alternative)` in `[[ ]]`,
`case`, and completion `-G`. It accepts a substring only when none of the group's
alternatives matches that whole substring. Prefixes, suffixes, nested groups,
empty matches, quoting, and positive repetition use the same character-boundary
rules as other full patterns.
Completion patterns with slashes inside an active group remain a separate
pathname-component follow-up; ordinary component splitting is unchanged.

The compiler adds a complement instruction to its existing epsilon-NFA. Each
negative group has a detached body. The matcher computes body acceptance at input
character boundaries, from inner groups to outer groups, then follows the
complemented edges. A visited bitmap deduplicates instruction-position pairs,
including nullable cycles. Matching uses neither recursive calls nor backtracking.
Positive-only patterns retain the original two-state-set matcher.

For `m` instructions, `k` negative groups, and `n` input characters, admitted
storage is `O(mn + kn²)`. Worst-case work is `O(kmn² + k²n³)`, plus character-class
comparisons. Every allocation is admitted before reservation. State scans, table
initialization, and complement edges consume the existing work budget and check
cancellation. Large patterns or inputs can exhaust those existing limits and
return an error, never a false match result.

This is original local code. It adds no command, dependency, utility guest, or
runtime contract. Ordinary argv pathname expansion and scalar trim/replacement
still use their separate basic-pattern compiler and do not gain extglob support.
The committed `shell-negative-extglob.json` controls record GNU Bash 5.3.15.
Run them with the ordinary `scripts/test-own-shell-extglob.ts` production-Waffle
recipe after building the shell and Node harness. The frozen oracle stays unchanged.
