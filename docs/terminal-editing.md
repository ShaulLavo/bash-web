# Interactive terminal editing

The interactive shell guest owns its prompt, echo, command buffer and history. The browser terminal forwards bytes and renders the guest's output.

## Newlines and paste

Shift+Enter inserts a newline in the current command without executing it. The editor accepts both `CSI 27;2;13~` and `CSI 13;2u`. Enter submits the entire buffer, including its newlines. Up and Down navigate whole history entries, including multiline commands.

Each prompt enables bracketed paste with `CSI ?2004h`. The shell disables it with `CSI ?2004l` before executing commands and when the input loop exits. A foreground program therefore receives its normal input unless it enables bracketed paste itself.

Between `CSI 200~` and `CSI 201~`, pasted bytes become command text. CRLF and CR become LF. Newlines, including a trailing newline, never submit the command. Control bytes in a paste are stored as text and displayed with caret notation rather than interpreted as editing keys or terminal controls. The closing delimiter triggers one redraw.

A command holds at most 64 KiB. A paste drops its remaining text after reaching that limit and rings the bell once, while still consuming its closing delimiter. UTF-8 characters that do not fit are dropped whole, even when their bytes arrive in separate chunks. Typing also preserves the UTF-8 boundary at the cap.

## Display

Redraw returns to the prompt origin, clears old rows, then paints the buffer. Explicit newlines erase the remainder of the current row and write CRLF because the runtime does not translate LF to CRLF. Cursor accounting includes both explicit newlines and wrapped rows. Width changes recount the existing caret before an edit.

## Limits

The editor handles UTF-8 scalars rather than grapheme clusters. Automatic continuation with PS2 for incomplete shell syntax, interactive completion, reverse history search, kill-ring yank, undo and vi mode are not implemented.

## Verification

Rust byte tests cover Enter sequences, paste framing, CRLF normalization, literal controls, overflow and split UTF-8. The discovered terminal display tests replay wrapping, multiline edits and resizing. Runtime tests execute the WASI shell against the pinned Waffle API and check prompt modes during command execution, interruption and EOF. Playwright tests paste through the actual browser terminal, check screen rows and cursor positions, and require explicit Enter before execution.

These tests check the shell's editing contract. The frozen GNU Bash 5.3.15 corpus checks command execution compatibility. Shift+Enter newline insertion is the product's explicit editing policy.
