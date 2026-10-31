# Prompt hook

A page can draw each interactive prompt itself. Before every prompt the shell asks a provider for the text, and while the prompt is on screen the provider can push newer text. The shell redraws the prompt in place and keeps what the user is typing. Without a provider the shell draws `PS1` exactly as before.

## Use it

```ts
const shell = await createShell({
	runtime,
	prompt: {
		variables: ["VIRTUAL_ENV"],
		render(context, live) {
			void slowPart(context).then((part) => live.update(`${context.cwd} ${part} $ `));
			return `${context.cwd} $ `;
		},
	},
});
```

`PromptProvider`, `PromptContext`, `PromptLive` and `PromptStart` are exported as types from `bash-web`. The provider is borrowed: one provider can serve several shells, and disposing a shell does not dispose it. `prepare(start)` runs once before the shell starts, with its `cwd` and `env`, and is never awaited. `render` is called once per prompt. The option is ignored with `script`.

## The context

| Field | Meaning |
| --- | --- |
| `turn` | Counts prompts in this shell, starting at 1. |
| `cwd` | The shell's `$PWD`. |
| `status`, `pipestatus` | `$?` and `${PIPESTATUS[@]}` after the last command. The first prompt has an empty `pipestatus`. |
| `durationMs` | Wall time of the last command, or `undefined` when none ran since the previous prompt: the first prompt, an empty line, a parse error or Ctrl+C at the prompt. |
| `jobs` | Live background jobs owned by this shell. |
| `columns`, `rows` | The terminal size when the prompt was requested. |
| `lineEditor` | `"bash"` or `"zsh"`. |
| `ps1` | The text the shell draws when the provider answers `null`, fails or is late. |
| `variables` | Current values of the shell variables named in `provider.variables`, including unexported ones. Unset variables are absent. The list is read again after every render, so it can grow. Names must be shell identifiers and fit in 1 KiB together. |
| `signal` | Aborted when the shell stops waiting for the first answer. |

## Text

Prompt text may contain printable UTF-8, `\n`, SGR color sequences (`ESC [ … m`), OSC 8 hyperlinks and OSC 133 marks. The page removes every other control byte and sequence before the text reaches the shell, because cursor movement would break the editor's model of the screen. Do not use `\[` and `\]`: they belong to `PS1`, and the editor already measures escape sequences as zero width. Text over 8 KiB after cleaning is refused.

## When the shell draws PS1

| Provider | Result |
| --- | --- |
| `render` returns `null` | `PS1` |
| `render` throws or rejects | `PS1`. The error is logged once per distinct message. |
| No answer within 100 ms | `PS1`. The late answer is dropped. `live.update` for the same prompt still redraws it. |
| Text over 8 KiB | `PS1`, logged once. |

## Updates in place

`live.update(text)` replaces the prompt on screen. Calls made in the same task are coalesced and only the latest text is sent. Text equal to what was last sent is not sent again. `live.signal` aborts when the prompt ends: Enter, Ctrl+C, end of input or shell disposal. Later calls are ignored.

The editor keeps the typed command, the cursor, history position, the draft and the zsh desired column. It repaints from the first row that changed, so a longer or shorter prompt rewraps the command under it. A resize is recounted first. The shell declines an update in these cases and keeps the newest text, which Ctrl+L shows:

- Something else wrote to the terminal after the prompt was drawn, such as a background job.
- The prompt's first changed row has scrolled into history.

An update that arrives in the middle of an escape sequence, an incomplete UTF-8 character or a bracketed paste is drawn as soon as that input completes. After Enter the submitted prompt stays in scrollback as it was drawn.

## How it works

`createShell` loads the page side with a dynamic `import()` only when `prompt` is set, and starts the shell as `shell-runtime -i [--line-editor MODE] --prompt-host`. A shared buffer of about 34 KiB carries one request per prompt (a JSON context), one reply, the latest update and the variable names.

The shell waits for the first answer for at most 100 ms. To push an update, the page writes it and sends SIGWINCH (signal 28) to the shell's own process through Waffle's process service, never to a job. Only a `--prompt-host` shell handles SIGWINCH. It wakes the prompt reader, which applies the update between keys. Without a provider the shell registers no SIGWINCH handler, so a stray signal 28 is ignored.

The guest imports four functions from `shell_terminal`: `prompt_names`, `prompt`, `prompt_update` and `output_position`. A shell without `--prompt-host` never calls them. Hosts that run the guest without a provider can pass `noPromptHost` from `src/runtime/guest-imports.ts`.

## Cost without a provider

A page that passes no provider gets no prompt channel, no prompt import calls, no SIGWINCH handler, and does not load the prompt host module. A few small fixed costs remain:

- Shell startup checks for a provider and awaits one already-resolved promise.
- The shell worker bundle includes and builds the four prompt import functions, about 0.7 KB gzipped.
- The guest checks for an absent prompt host on each editor write, checks for a pending prompt on each key, and reads the clock once for every submitted command.
- The shell WebAssembly is about 8 KB larger, 2.5 KB with brotli.

## Not supported

- Continuation prompts: bash-web has no `PS2` yet.
- A right-aligned prompt, fill and transient prompts.
- New text on resize. A width-dependent prompt gets the new width at the next prompt.
- `PROMPT_COMMAND` and decoded `PS1` escapes. When they land, `PROMPT_COMMAND` runs before the hook and `ps1` carries the decoded text.

## Verification

- `npm run test:terminal:display` replays redraws into the pinned libghostty-vt: buffer and cursor kept in both editor modes, one line to two and back, a soft-wrapping prompt, a command rewrapping under a wider prompt, after a resize, scrolling at the bottom of the screen, background output, a scrolled-away prompt with Ctrl+L, and updates mid-escape and mid-paste.
- `npm run test:rust` covers the editor rules, SIGWINCH registration and dequeue, and that cancelling the input read never loses a byte.
- `scripts/test-own-shell-prompt-host.ts` runs the real WASI guest with `--prompt-host`: an update deferred during a paste, an escape sequence or a split UTF-8 character is drawn when the input completes, and is not drawn over a background job's output until Ctrl+L.
- `src/runtime/prompt-host.test.ts` covers text cleaning, the context, fallbacks, coalescing, turn tracking, variable names that overflow 1 KiB, and a thenable whose `then` is read once.
- `tests/prompt-hook.spec.ts` runs the real guest on Waffle in Chromium and Firefox: the context, every fallback, an update after a late answer, in-place redraw with typing kept, no redraw after Enter, Ctrl+C or background output, Ctrl+L, and a stray SIGWINCH to a shell without a provider.
- `BASH_WEB_MEASURE=1 npx playwright test tests/prompt-hook.spec.ts -g costs --project chromium` measures the hook round trip, push to redraw and a filesystem lookup.
