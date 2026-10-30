# Interactive terminal editing

The interactive shell guest owns its prompt, echo, command buffer and history. The browser terminal forwards bytes and renders the guest's output.

## Newlines and paste

Shift+Enter inserts a newline in the current command without executing it. The editor accepts both `CSI 27;2;13~` and `CSI 13;2u`. Enter submits the entire buffer, including its newlines.

Each prompt enables bracketed paste with `CSI ?2004h`. The shell disables it with `CSI ?2004l` before executing commands and when the input loop exits. A foreground program therefore receives its normal input unless it enables bracketed paste itself.

Between `CSI 200~` and `CSI 201~`, pasted bytes become command text. CRLF and CR become LF. Newlines, including a trailing newline, never submit the command. Control bytes in a paste are stored as text and displayed with caret notation rather than interpreted as editing keys or terminal controls. The closing delimiter triggers one redraw.

A command holds at most 64 KiB. A paste drops its remaining text after reaching that limit and rings the bell once, while still consuming its closing delimiter. UTF-8 characters that do not fit are dropped whole, even when their bytes arrive in separate chunks. Typing also preserves the UTF-8 boundary at the cap.

## Navigation

Ctrl+A and Home move to the beginning of the whole command buffer. Ctrl+E and End move to its end. Native macOS Ghostty maps Cmd+Left and Cmd+Right to Ctrl+A and Ctrl+E. LF, blank lines and soft wraps do not add navigation boundaries.

Up and Down browse whole history entries from any position in the buffer. Down after the newest entry restores the unsubmitted draft with its cursor at the end. Ctrl+P and Ctrl+N share the arrow behavior. Option+Left and Option+Right move by word through the whole buffer.

The navigation fixture in `tests/terminal/readline-navigation.json` records real GNU Bash 5.3.20 and its runtime-linked Readline 8.3 library. `scripts/readline-reference.py` regenerates it through isolated PTYs with no inputrc and the Emacs keymap. It pins binary hashes, default key bindings, native Ghostty source bytes and each observed buffer and byte cursor. Its Unicode control proves that Bash's `bind -x` cursor uses character offsets before converting them to UTF-8 bytes. Regeneration is Linux-pinned and uses read-only memory from its own children, `nm` and `pacman`. It has no portable fallback. The separate frozen Bash 5.3.15 execution corpus is unchanged.

This is selected navigation parity, not a complete Readline implementation. Shift+Enter newline insertion remains an explicit product policy. Default Bash instead treats parts of that unbound sequence as text. Unsupported modified escape sequences are consumed safely here rather than inserting their tail, as default Bash does for Shift+arrows.

## Display

The editor keeps a model of where the prompt and command sit on the terminal. Rows of a command taller than the screen that scrolled into history are counted, so cursor movement never aims above the screen. An edit repaints from the first row that changed. Moving the caret only moves the cursor. Explicit newlines are written as CRLF because the runtime does not translate LF to CRLF.

Enter, Ctrl+C, Ctrl+D, a host interrupt and the end of input first recount the command at the current width, then move the cursor below its last row, so output and the next prompt never overwrite it. `^C` is echoed after the command text, as in GNU Readline. Ctrl+L clears the screen with `CSI H CSI 2J` and repaints the prompt and command at the top.

When the caret moves into rows that have scrolled into history, the editor repaints from the caret's row at the top of the screen. History keeps the earlier copy of those rows, because a terminal cannot edit its scrollback.

While the margin space follows a full last row, typing repaints instead of echoing, so a combining mark joins the last glyph rather than the padding. A repaint waits for a character's last UTF-8 byte.

Cell widths come from `shell/engine/src/terminal/width.rs`, generated from the pinned libghostty-vt by `npm run terminal:widths` with grapheme clustering (mode 2027) off, which is the terminal's default. A test fails when the table no longer matches the pinned terminal. The prompt is assumed to start at column 0. A resize recounts the reflowed command before the next edit, assuming the terminal keeps the command's end at the bottom of the screen.

## Limits

The editor handles UTF-8 scalars rather than grapheme clusters. Automatic continuation with PS2 for incomplete shell syntax, interactive completion, reverse history search, kill-ring yank, undo and vi mode are not implemented.

## Verification

Rust byte tests cover Enter sequences, paste framing, CRLF normalization, literal controls, overflow and split UTF-8. The discovered terminal display tests replay wrapping, multiline edits and resizing. Runtime tests execute the WASI shell against the pinned Waffle API and check prompt modes during command execution, interruption and EOF. Playwright tests paste through the actual browser terminal, check screen rows and cursor positions, and require explicit Enter before execution. `npm run test:terminal:display` drives the editor with a native replay example and feeds its exact bytes to the pinned libghostty-vt, comparing screen, history and cursor with the same text written directly: wrapped and wide text, combining marks, emoji, commands taller than the screen, Enter and interrupts from earlier rows, Ctrl+L, resize and multiline commands.

These tests check the shell's editing contract. The frozen GNU Bash 5.3.15 corpus checks command execution compatibility. Shift+Enter newline insertion is the product's explicit editing policy.
