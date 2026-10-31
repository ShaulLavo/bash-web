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

The provider paints within 15 ms by default. Background work uses generation checks and coalesced updates. Repository metadata powers `git_branch`, `git_commit` and `git_state`; working-tree status, staged changes and ahead/behind counts remain separate tracks.

The native Starship captures in `src/prompt/fixtures/` record the 1.27.0 reference output. The package tests compare the non-git subset after removing Starship's leading erase-display control, which the prompt hook does not permit.

## Lifetimes and configuration dependencies

Each render owns its work budget and uses the hook's live signal. Finishing the first-answer wait does not cancel live updates. Aborting the live signal or reaching the background deadline prevents new reads and discards results from reads already admitted.

Providers can serve several shells at once. They use each context's variables, not a retained startup environment. File configuration caches are keyed by the config path. The negotiated variable list grows when a file introduces a new `env_var` name, so the following shell context can supply it without removing another shell's dependencies.

`npm run test:prompt` bundles and runs the prompt regressions. `npm run quality:js` runs that command and the dependency-graph size gate. The size report includes the eager graph, the full config graph, and the incremental config download. Shared chunks count in each full graph but only once in the total download.
