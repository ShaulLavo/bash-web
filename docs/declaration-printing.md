# Named scalar declaration printing

`declare -p name...` and `typeset -p name...` inspect existing named scalar
bindings. Both print `declare`, with existing `n`, `r`, and `x` attributes.
Inspection never creates a binding, changes an attribute, or makes a function
local. A nameref prints its immediate raw target, including chains and cycles.
Represented local unset values print without `=`, unlike an empty string.
Missing names report status 1 while valid later operands still print.

`unset -n name...` removes named references without following their targets.
Ordinary variables and functions remain unchanged; readonly operands report
status 1. Current locals stay unset
until return; removing a caller local restores its saved outer declaration.

`state/declarations.rs` owns a borrowed `DeclarationView`. The builtin snapshots
only the current scalar after storage admission, then scans and formats it with
cooperative fuel/cancellation checks. Writes use existing descriptors. Printable
values use double quotes; nonprinting values use Bash declaration ANSI quoting,
short control escapes, and three-digit octal bytes. This is not printf `%q`.
Locale selection reuses the existing locale decoder and character classifier.
U+2028/U+2029 are nonprinting declaration separators on all targets. Other native
libc/WASI classification differences remain as described in
[printf quoting](printf-quoting.md).

This implementation and its controls are original work observed against local
GNU Bash 5.3.15, not copied or adapted upstream code. The exact version, scripts,
stdout/stderr bytes, and statuses are recorded in
`scripts/fixtures/shell-declare-print.json`. Native Rust and production-Waffle
TypeScript regressions read that recording, not the CI host's Bash.

Global enumeration, new global declared-unset storage, indexed/associative
arrays, integer/case attributes, and new special-variable support are excluded.
The frozen 24-case scalar selection is targeted diagnostic evidence only.
Indexed bindings now reject with status 2 instead of printing element zero as a
scalar. Direct, empty, sparse, local and raw-nameref controls cover this boundary.
Full replay and baseline updates use the hosted frozen-ruler artifact during the
parent lane's serialized landing slot.

The integrated-source hosted replay gained 5 Oils, 45 Brush-suite and 7 Bashkit
suite passes with no losses or new abnormal outcomes on all 9,221 frozen cases.
The candidate baseline preserves every nongained historical row. Exact source,
artifact and review identities are in the declaration-printing evidence receipt;
final-head CI and merge are separate acceptance gates.
