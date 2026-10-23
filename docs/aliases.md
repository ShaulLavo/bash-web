# Aliases and source reading

`alias` and `unalias` are core shell builtins. Noninteractive shells keep
`expand_aliases` off until `shopt -s expand_aliases` enables lexical expansion.
Alias listings are sorted and quote values for reuse as shell input.

The parser owns replacement text, trailing-blank chaining, quote suppression,
and recursive-alias protection. The engine never substitutes strings in a
command name. Alias text can introduce shell syntax, including pipelines,
compound commands, substitutions, and function definitions.

State owns immutable alias-table versions and their storage admissions.
Subshell snapshots and active source readers share a version. A mutation admits
a new version before publishing it, so a refused update leaves the table intact.
The last owner releases the old version's charge.

A script reader retains the parser's original command offsets and read-unit
end lines. After an alias-table or `expand_aliases` change, it re-reads only
unexecuted source beyond the current read unit. This also replaces a deferred
syntax error when an earlier alias definition supplies the missing grammar.
The re-read shares the input's parser budget and preserves original source spans.
Commands already parsed on the same line do not see the change. Functions keep
the aliases expanded when their definitions were read. `eval` starts a new reader
with current aliases and follows the same read-unit rules.

`scripts/test-own-shell-aliases.mjs` replays recorded Bash 5.3.15 results through
the real Waffle runtime. Native tests cover token recursion, source offsets,
atomic admission, and retained-version release.
