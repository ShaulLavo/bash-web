# HOME tilde expansion

Unquoted `~`, `~/suffix` and `~:suffix` read the current scalar HOME binding.
An empty HOME produces an empty protected prefix. Quotes or escapes in the
prefix prevent expansion. Quoting a suffix after an unquoted slash does not.
Values produced by parameter expansion are never tilde-expanded again.

Assignments recognize a new prefix after each unquoted literal colon. Ordinary
words do this only after an unquoted valid scalar name and `=` or `+=`, as in
`echo path=~:~/bin`. This does not make the rest of that ordinary word scalar:
unquoted parameter results still split normally. Redirect filenames recognize
leading prefixes and assignment-looking words, like declaration arguments. Brace variants are expanded
before tilde recognition. Parameter operands keep their distinct existing path.

HOME is snapshotted at each eligible literal segment. Earlier parameter
expressions in the same word can change the binding seen by a later segment.
The snapshot is storage-admitted before copying. Each emitted copy spends the
existing byte budget. Words without an unquoted literal `~` spend no tilde
work. Otherwise the assignment-name scan and each `~` candidate check work and
cancellation, and emission checks them per character.
The home bytes retain full splitting and pathname protection; suffix bytes keep
the parser's existing quote flags.

There is no runtime account lookup. Named-user prefixes and bare tilde with HOME
unset remain literal rather than inventing an account home. PWD/OLDPWD and
directory-stack forms, lazy parameter operands, arrays and non-UTF-8 fields are
not implemented here.

`node --test scripts/test-own-shell-tilde.ts` runs the production guest on real
Waffle against recorded GNU Bash `5.3.15(1)-release` controls. The final three cases
name the unset-HOME/account, parameter-operand and append-assignment (`+=`)
boundaries instead of claiming Bash matches. CI never invokes live Bash as this test's oracle. To explicitly
refresh the recording on the pinned local Bash:

```sh
BASH_TILDE_SCRATCH=/work/tmp \
BASH_TILDE_RECORD=scripts/fixtures/shell-tilde.json \
node scripts/test-own-shell-tilde.ts
```

The frozen scoreboard oracle and its environment are independent of these new
controls and remain unchanged. The gain receipt is
[own-shell-tilde.json](evidence/own-shell-tilde.json).
