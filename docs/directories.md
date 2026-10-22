# cd and the directory stack

`cd`, `pushd`, `popd` and `dirs` (`shell/engine/src/builtins/directories.rs`,
stack storage in `shell/engine/src/state/directory_stack.rs`) were written for
this engine in logical mode. Their behavior is checked against recorded GNU Bash
5.3.15 runs. Bash's `cd_builtin`, `change_to_directory`, `bindpwd` and
`pushd.def` are named as semantic references only; no Bash source revision or
archive was inspected for this change.

## What is checked

A directory change uses real host metadata, never an attempted open:

- The target is the current directory joined with the operand, canonicalized
  lexically. Before each `..`, the path so far must be a directory, and the
  result must be one. Exactly two leading slashes are kept.
- The result must report search permission. A host that cannot report it
  refuses the change ("directory search permission unavailable").
- If canonicalization fails, the error is the host's own answer for the raw
  path: missing, not a directory, or permission denied.

The working directory changes first, as a direct update of the shell's `cwd`.
`OLDPWD` then takes the old `PWD`, and `PWD` the new directory, through the
existing assignment path. A readonly
`OLDPWD` or `PWD` fails the command with status 1 but keeps the change, as in
Bash.

`cd` handles `-L`, `-e`, `--`, `-` (prints the operand as given), `HOME`,
`CDPATH` (an empty entry means `.`; a hit through a named entry prints the new
directory), "null directory", "too many arguments" (status 2) and invalid
options (status 2 with usage). If printing the directory fails with write status
1 (a closed stdout), `cd` reports the write error, still publishes the change
and returns 1. Other write failures and cancellation return before anything is
published.

## Directory stack

The stack is private shell state (`State::directories`, bottom entry first).
Each version of the stack is one immutable value that owns its entries and a
ticket on the shell's State memory budget for every byte they keep: the `Rc`
box, the vector slots and the string capacities. A change admits the next
version's requested bytes before allocating it and publishes it only on
success; a refusal leaves data and charge unchanged. Recorded vector capacity
beyond the request is reconciled into the ticket before publication. That is
bookkeeping of recorded capacity, not allocator-level accounting.
`State::snapshot` and `Clone` share the current version, charged once; whoever
changes it builds an admitted copy. Per-command Work admission covers only
transient copies such as listings.

`pushd dir` and `popd` prepare the next version before changing directory and
publish it only if the cd succeeds; a refusal, a failed cd or cancellation
drops it with its charge. No-argument `pushd` and `pushd +N`/`-N` change the
stack before the cd and keep that change when the cd fails, as in Bash. No variable exposes
it: `DIRSTACK` belongs to the variables family and is not implemented.

`pushd [-n] [+N | -N | dir]`, `popd [-n] [+N | -N]` and
`dirs [-clpv] [+N] [-N]` match Bash's option parsing, including its quirks:
`dirs -lv` and `pushd -z` are "invalid number" (status 2), and `pushd`'s
internal cd does not parse options. Other details:

- A rotation stays in place when the following cd fails.
- `popd` keeps its entry when its cd fails.
- Listings abbreviate a `HOME` prefix (longer than `/`) at a path boundary to
  `~` unless `-l` is given.

## Deferred

- `cd -P` and its `-e`. Bash's physical retry of the raw path after logical
  canonicalization fails also needs this. Both require symlink resolution
  (readlink), which the filesystem contract does not offer. Both fail with
  status 1 and say so.
- `~` inside `CDPATH` entries; the `DIRSTACK` array; `pwd -L`/`-P`.
- `PWD` reads come from the working directory, so a readonly or user-assigned
  `PWD` does not hold a different value as it can in Bash.
- `brush-suite:builtins/cd:1`: plain `cd` goes to `$HOME`, which the frozen
  Waffle environment does not create.

The pinned recording `scripts/fixtures/shell-directories.json` (GNU Bash
5.3.15, recorded in a sandbox shaped like the engine's test filesystem) is
replayed by `shell/engine/tests/directories.rs`, which compares status, stdout
and stderr exactly. Bash's `line N:` stderr prefix was removed when recording,
as the fixture's `stderrNormalization` field states; stdout and status are
unmodified.
