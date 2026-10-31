# Zsh line-editor mode

The shell always executes Bash. The optional zsh mode changes only interactive navigation. Bash editing remains the default, including in the playground.

## Select the mode

Pass the mode when creating a shell:

```ts
const shell = await createShell({
	runtime,
	lineEditor: { mode: "zsh" },
});
```

`lineEditor.mode` accepts `"bash"` or `"zsh"`. Omitting `lineEditor` selects `"bash"`. The setting belongs to each shell, not its shared runtime. It has no effect when `script` is supplied. A new shell is required to change modes.

The WASI interactive entry also accepts `shell-runtime -i --line-editor zsh` or `shell-runtime -i --line-editor bash`. An unknown mode is a usage error.

## Navigation

In zsh mode, Ctrl+A and Ctrl+E move to the beginning and end of the current hard line. Native macOS Ghostty sends these bytes for Cmd+Left and Cmd+Right. Home and End are also line-bound aliases here.

Up and Down move through hard lines, including empty lines and a trailing empty line. They retain the desired character column across shorter lines. A horizontal move or edit resets that column. Soft wraps never create navigation boundaries.

At the first hard line, Up recalls the previous history entry. At the last hard line, Down recalls the next entry. History recall places the cursor at the entry's end. Down past the newest entry restores the unsubmitted draft at its end. Ctrl+P, Ctrl+N, and application-cursor arrows use the same rules.

## Limits

This mode implements selected zsh 5.9 ZLE navigation with the Emacs keymap, not the zsh language or a complete ZLE implementation. Word movement, deletion, paste, submission, and display retain bash-web's existing behavior. Shift+Enter still inserts a hard newline as a product policy. User startup files, ZLE widgets, keymap configuration, vi mode, completion, undo, and history search are not added.

Vertical movement counts Unicode scalars, including tabs and combining marks, as the reference ZLE does. Display still uses the terminal's pinned cell widths. The editor handles UTF-8 scalars rather than grapheme clusters.

## Verification

`tests/terminal/zsh-navigation.json` records real `/bin/zsh` 5.9 in isolated macOS PTYs. It includes the binary hash, default Emacs bindings, Ghostty source revision, and the hash of the unchanged key-source reference. `scripts/zsh-reference.py` captures `BUFFER` and `CURSOR` from a redraw hook without binding a diagnostic key. Every event prefix is also replayed into a fresh PTY to detect observer interference. The harness never submits fixture text and reaps every child.

Regenerate on a Mac with zsh 5.9, using a writable scratch directory for the output:

```sh
python3 scripts/zsh-reference.py /path/to/scratch/zsh-navigation.json \
	--key-reference tests/terminal/readline-navigation.json
```

Native and WASI tests compare the captured buffers and UTF-8 byte cursors. `npm run test:terminal:display` also replays the editor's output into the pinned libghostty-vt and checks the rendered cursor after each event. Public adapter tests check mode arguments and the real WASI interactive shell. The existing Bash navigation reference and frozen execution evidence remain unchanged.
