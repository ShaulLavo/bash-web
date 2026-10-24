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
utility add-ons. Without an explicit hash entry, querying an absent utility fails;
executing an absent utility returns 127. Alias, declaration, array grammar and
generic scope changes are outside this classification unit. Diagnostics use
existing descriptors and cancellation; Bash execution-coordinate prefixes and
exact help prose are not implemented. The shared printer's resource diagnostic
retains its existing `command:` label.

## Explicit command hashes

`hash -p pathname name` stores a literal path. `hash -t name` queries it,
`hash -d name` deletes it, and `hash -r` clears the table. `hash name` records a
successful lookup through the runtime's executable registrations. With no
operands, `hash` lists entries; `hash -l` prints commands that restore them.
Reusable listings do not yet quote names containing shell-special characters.

Single-match `type` and `command` queries can report these entries. Keywords,
functions and builtins retain their precedence; all-match queries still inspect
real PATH candidates. Subshell changes do not alter the parent's table.
Remembering a path neither grants executable permission nor changes execution
resolution. Executing a command does not automatically fill the table, and PATH
assignments do not automatically clear it. Focused frozen observations cover
hash queries; they do not establish a new accepted compatibility score.

## Provenance and verification

Options and classification order adapt pinned Bashkit `introspect.rs::Type` at
`491c3281f668b76d64b15210b8f5d7bf97244be0`, MIT. Catalogue, bounded lookup,
streaming output and AST printer integration are original local adapters. Source
hashes, adapted examples and destinations are in `sources.lock.json::shellType`.

Focused native and WASI controls check the classification, and GNU Bash 5.3.15 stdout and status matched all 78 frozen observations of the type inventory.

## PATH review repair

All-match enumeration follows the recorded Bash element extraction, not general
PATH deduplication. `PATH=:` visits cwd once, while `PATH=.:.` and `PATH=a:a`
retain both matches. Unset PATH disables all-match file search, but ordinary
one-shot queries retain their cwd fallback; empty PATH and slash operands keep
their existing behavior. Failure classification is extracted from the shared
resolver without changing host access, metadata fallback or admission owners.

`scripts/fixtures/shell-type-path.json` retains 28 cwd-independent observations
from Bash 5.3.15, including six longer colon-run controls. Native/WASI regressions replay these fixed bytes and status, never the CI host's Bash. Original one-shot and slash controls also remain.

## Measured effect

Against the launch baseline, the unchanged 9,221-case production-Waffle replay gains 70 passes: Oils 23, Brush 12 and Bashkit 35. Nothing that passed is lost, and no new crash or timeout appears. Four of the Bashkit gains outside the type inventory also exercise `type`. The hosted Shell replay at integrated source `183ce1c740cb47514cb667d5f08369c129290b16` gives the same counts, with 5,792 scored cases and 3,429 skips unchanged and the same three inherited timeouts. `docs/evidence/type-current.json` records the gained IDs, source identities and artifact digest. Replay with the command in [Bash compatibility](bash-compatibility.md).

Tests: 1,386 native and 1,366 WASI tests, 533 scoreboard tests, all 12 committed native fuzz families, 246 generator and CI-helper tests, and 492 production-Waffle echo controls. The type tests use fixed observations, never the CI host's Bash. Nine focused type tests pass natively and under WASI.
