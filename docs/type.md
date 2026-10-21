# Type command queries

`type` classifies shell keywords, functions, builtins and files. `-t` prints the
classification, `-p` prints only file paths, `-P` forces file lookup, `-f` skips
functions and `-a` reports every matching classification and PATH entry. The last
mode option wins; once supplied, `-P` keeps file lookup forced. A name found as a
function or builtin still succeeds silently under `-p`. Every operand must be
found for status zero. No operands succeeds; an invalid option returns two.

Functions use the existing canonical AST printer, including its storage and
print-work limits, not reparsed source text. Queries share the authoritative
executable resolver with ordinary dispatch and `command`. A resumable entry
offset supports `-a` without a second PATH search. Duplicate entries are retained.
One-shot lookup retains Bash's nonexecutable regular-file fallback; `-a` requires
executable candidates. Explicit slash operands do not consult PATH. Queries do
not spawn processes. PATH spelling is preserved in type output.

This is a core shell feature, not a command add-on. The core still builds without
utility add-ons; querying an absent utility fails and executing it returns 127.
Aliases, command hashes, declaration output, array grammar and generic scope
changes are outside this unit. `bashkit-suite:type:125` is hash-owned and remains
a prerequisite failure. Diagnostics use existing descriptors and cancellation;
Bash execution-coordinate prefixes and exact help prose are not implemented.
The shared printer's resource diagnostic retains its existing `command:` label.

## Provenance and verification

Options and classification order adapt pinned Bashkit `introspect.rs::Type` at
`491c3281f668b76d64b15210b8f5d7bf97244be0`, MIT. Catalogue, bounded lookup,
streaming output and AST printer integration are original local adapters. Source
hashes, adapted examples and destinations are in `sources.lock.json::shellType`.

Six focused native/WASI controls failed first on launch main, returning 127.
The complete 78-case red inventory matched no frozen cases; fresh GNU Bash
stdout/status matched all 78 frozen observations. Report files under
`/work/reports/bash-web/hill-climb/builtins/type/` retain both raw streams.
This preparation evidence is not a whole-score or accepted-gain claim.

## Frozen launch proof

Source `730c5dcee747a54ac02c121f9e2d06291ba5c43b` ran the unchanged 9,221-case
production-Waffle ruler once against launch main
`34c21edc7bef1aacc7883b3ce22f66af886154f0`, with recording disabled. Oils gained
23 passes, Brush gained 12 and Bashkit gained 35. No accepted case was lost and
no new crash or timeout appeared. Four Bashkit gains outside the named type
inventory also exercise type. These are launch comparisons, not acceptance on
current main. The complete recomputed baseline stays in the report directory
until the parent's serialized integration slot.

That source passed 1,384 native and 1,364 WASI tests, native/WASI Clippy, Rust
formatting and dependency checks, JavaScript quality, capability and layer checks,
533 scoreboard tests, all 12 committed native fuzz families, 246 generator and
CI-helper tests, and 492 production-Waffle echo controls. The new type tests use
fixed observations, not the CI host's Bash. Browser end-to-end and hosted CI are
still parent-owned gates. That immutable checkpoint is superseded by a bounded review repair for empty
PATH elements and unset PATH in all-match queries. Its raw proof remains intact.

Exact gained IDs, frozen identities, both raw probe streams, the full replay and
strict offline comparison are retained under the report directory above. Alias,
hash and declaration prerequisites remain deferred. Actual-main integration,
full baseline replacement and independent review are required before acceptance.

## PATH review repair

All-match enumeration follows the recorded Bash element extraction, not general
PATH deduplication. `PATH=:` visits cwd once, while `PATH=.:.` and `PATH=a:a`
retain both matches. Unset PATH disables all-match file search, but ordinary
one-shot queries retain their cwd fallback; empty PATH and slash operands keep
their existing behavior. Failure classification is extracted from the shared
resolver without changing host access, metadata fallback or admission owners.

`scripts/fixtures/shell-type-path.json` retains 28 cwd-independent observations
from Bash 5.3.15, including the reviewer's discriminators and six longer colon-run controls. Native/WASI regressions replay these fixed
bytes and status, never the CI host's Bash. Original one-shot and slash controls
also remain. The two findings reproduced before repair on actual native and
production-Waffle artifacts, including the duplicate-entry discriminators.
