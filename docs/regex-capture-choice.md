# Conditional ERE capture choice

The matcher first selects the leftmost-longest whole span. Capture reconstruction
then follows ordered paths through that span, not a longest-subgroup rule.
`(a|aa)(a?)` on `aa` remains `[aa,a,a]`.

## Nullable counted copies

Empty required copies overwrite captures for exact counts. Expandable counts
with a minimum of at least two mark the last required root group as optional,
as well as the first optional root. An empty optional close restores the last
completed nonempty register snapshot for completed groups. An enclosing group
that is still open keeps its current start. Earlier required
copies and later optional copies do not carry that marker. Copying an outer
expanded subtree also resets optional markers inside it.

On `a`, `(a*){2}` captures empty, `(a*){2,3}` and `(a*){2,}` capture `a`,
and `(a*){1,3}` captures empty. Preserving every nonempty capture would be wrong.
The compiler retains copy provenance instead. Both current registers and their
saved snapshot participate in epsilon-choice undo. Allocation admission and
cooperative work and cancellation apply to snapshots and restoration.

## Absent alternatives

A branch that emits no nodes follows a branch that emits nodes. This applies
to a truly empty alternative or a branch erased by a zero count. An explicit
empty group still emits capture nodes and keeps its original order.

On `a`, `(|a)a?` and `(a|)a?` capture `a`, while `(()|a)a?` captures empty.
On `aa`, `(|aa+){1,3}` captures empty, not `aa`. These choices do not reverse
all alternatives or rank all nullable branches after nonnullable branches.

## Assertions and accepting terminals

A trailing assertion constrains its epsilon suffix. At an equal whole span, the
original unconstrained accepting terminal precedes an assertion-derived terminal.
Reconstruction first tests reachability to that original terminal. If it cannot
reach the selected start, it reconstructs the constrained terminal instead.
Branch order otherwise stays unchanged; whole-span matching is unchanged.

Thus `((a$)|a)` on `a` leaves the inner capture empty, while `((a*)|a)` and
`((a*)$|a$)` retain their left branch. Assertions before a consuming transition do
not constrain the later accepting suffix. Neither all alternatives nor all
anchored alternatives are reversed.

## Evidence and provenance

`scripts/fixtures/shell-regex-capture-choice.json` records exact
`5.3.15(1)-release` output in `LC_ALL=C`. It preserves the independent review's
780 matcher probes in 33 complete batches, 14 smaller confirmations and 160
interval, nesting, repeated-group and assertion discriminators. The repair adds
660 counted-copy and terminal probes, 180 absent-branch discriminators, and 16
confirmations in 23 additional batches without changing those 207 tests. The production
runner includes these alongside the unchanged 244 ordinary capture controls.
Eight further recorded controls cover nullable counted groups nested inside a
star on `bb` and `bbb`. These preserve every prior recording and bring the
choice fixture to 238 records, alongside 244 ordinary capture controls.
CI reads recordings, never its host's Bash.

This is an original implementation using the existing local Thompson arena,
reverse-reachability bitset and undo stack. Behavioral algorithm research used
GNU libc `posix/regcomp.c` and `posix/regexec.c` at
`04e750e75b73957cf1c791535a3f4319534a52fc`: optional-group marking/reset during
copying, register snapshots, constraint propagation through epsilon closures and
accepting-node order. No upstream source was copied or translated. The local
terminal-provenance reachability algorithm avoids importing libc's DFA, node
cloning machinery or backtracking matcher.

This correction changes no publication/state API or supported input domain.
Direct/resolved IFS, compound-local restoration, array enumeration, declaration
printing and Oils611 operand quoting retain their separately owned prerequisites.
No full frozen-score gain, current-main integration or final publication
acceptance is implied by these focused controls.

## Known Bash differences

These focused controls do not establish full GNU libc regex parity. The r3
review found anchor anomalies when `$` precedes or `^` follows a consuming atom
inside repeats. For example, `(((^a){0,2}){1,3})` on `aa` does not match in
Bash 5.3.15, while this matcher finds `a`. The unchanged whole-span scan owns
that difference, not accepting-terminal capture reconstruction.

`((b?)+a)*` on `aa` captures `aa` in Bash's outer group and `a` here. GNU libc
restores a register snapshot that changes an open enclosing group's start.
That restoration behavior remains outside this repair. Both differences have
an Approved follow-up in plan 004. No fixture exclusion or scoring rule changes.
