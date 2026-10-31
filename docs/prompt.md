# Prompt provider

`bash-web/prompt` builds a Starship-shaped shell prompt in the page without starting a process. It reads Waffle's filesystem, uses versions declared by the host, paints within a bounded budget, and sends slow results through `PromptLive.update`.

## Create a provider

```ts
import { createPrompt } from "bash-web/prompt";

const prompt = createPrompt({
  filesystem: runtime.filesystem,
  versions: { bun: "1.4.4", node: "26.12.1" },
  file: true,
});

await createShell({ runtime, prompt });
```

The provider does not own or dispose the runtime. A page may reuse one provider across shells.

## Configuration

Pass a `PromptConfig` object to `createPrompt`. Set `file: true` to merge `$HOME/.config/bash-web/prompt.json` on each prompt. The file uses the same typed shape as the object. Edits apply on the next prompt when its inode or modification time changes.

Invalid JSON or fields keep the last valid configuration. The provider reports each pathful error once through `logger`.

## Limits

The provider never runs `git`, Bun, Node, Python, or another external program. It only uses `lookup` and `readFile`. Host versions are shown only when the host declares them.

The provider paints within 15 ms by default. Background work uses generation checks and coalesced updates. Git segments are reserved for the later repository and status changes.

The native Starship captures in `src/prompt/fixtures/` record the 1.27.0 reference output. The package tests compare the non-git subset after removing Starship's leading erase-display control, which the prompt hook does not permit.
