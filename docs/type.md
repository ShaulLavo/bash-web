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
