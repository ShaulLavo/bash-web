# HOME-based tilde expansion in parameter operands

An unquoted leading `~` in a selected parameter operand reads the current shell
`HOME`. A following slash or colon separates the prefix from the rest of the
operand. HOME bytes stay protected from field splitting and pathname expansion.

```sh
HOME=/home/user
echo ${missing:-~} ${HOME:+~/subdir} "${missing:-~}"
# /home/user /home/user/subdir ~
```

Trim and replacement patterns have their own quote context. Their unquoted leading
`~` expands even when the containing parameter expansion is double-quoted.
Quoted or escaped tildes and expansion-provided tildes stay literal. Non-HOME
tildes in parameter patterns stay literal, including the tilde after the anchor
in `${value/#~/replacement}`. Other unquoted tilde spellings in nonpattern
operands, including username prefixes, retain the existing unsupported status.
Direct case patterns are unchanged. Prefix assignments, function locals, and subshell copies retain their
existing HOME visibility and restoration rules.

The operand scanner emits a typed HOME prefix. The tilde module uses the existing
admitted future frame and takes an owned HOME snapshot after admitting access and
storage. It releases the state borrow
before suspending and releases the snapshot charge after emission. Existing work,
output, cancellation, and pattern limits still apply.

Selected HOME prefixes with unset HOME retain status 2 rather than looking up an
account. Username lookup is not supported. The engine does not invent a user
database or a home directory. This feature does not change arithmetic
attributes, shell identity, the process broker, or Waffle.

The additive replay in `scripts/test-own-shell-home-tilde.ts` uses unchanged
GNU Bash 5.3.15 recordings copied from the frozen oracle. It includes the selected
parameter row, the basic HOME rows, and nearby passing quote and assignment rows.
