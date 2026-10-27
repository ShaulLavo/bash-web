# Local Git API

`bash-web/utilities/git` runs local repository commands through isomorphic-git 1.44.5 on the embedding page's Waffle filesystem. It creates no runtime, process service, worker or executable marker. The Git core and text-diff library load on the first command from `dist/git-command.js`. Package preparation builds that self-contained asset with the verified upstream patch, so tarball consumers also receive the corrected backend.

```ts
import { installGit } from "bash-web/utilities/git";

const git = await installGit(runtime);
await runtime.filesystem.mkdirp("/project");
const status = await git.run({
  argv: ["init", "-b", "main"],
  cwd: "/project",
  env: {
    GIT_AUTHOR_NAME: "Ada",
    GIT_AUTHOR_EMAIL: "ada@example.invalid",
    GIT_COMMITTER_NAME: "Ada",
    GIT_COMMITTER_EMAIL: "ada@example.invalid",
  },
  stdout: bytes => terminal.write(bytes),
  stderr: bytes => terminal.write(bytes),
});
await git.dispose();
```

Arguments exclude the executable name. Streams receive bytes and may return promises. `run` returns a numeric status. One installation per runtime serializes its commands; dispose closes admission, joins accepted commands and leaves the caller's filesystem and runtime alive. Edits through other filesystem users must finish before starting a Git command.

## Supported commands

| Command | Local slice |
| --- | --- |
| `init` | Optional directory, `-b`/`--initial-branch`, SHA-1; no templates |
| `add` | Literal files/directories, `.`, `-A`, `-u`, `-f`; stages deletions |
| `commit` | Required `-m`, optional `--allow-empty`; environment identity/date or repository user config |
| `status` | Porcelain v1 with all untracked files, also the default output |
| `log` | `%s`, `%H`, `%h %s`, `%H %s` formats, `--oneline`, `--first-parent`, `-n`/`--max-count` |
| `diff` | Index/worktree or `--cached`/`--staged`; unified UTF-8 text diff, binary notice, `--name-only`, `--no-prefix`, `--quiet`, `--exit-code` |
| `branch` | List/current, create, delete `-d`/`-D`; no patterns |
| `checkout` | Existing local revision, `-b`; refuses tracked edits that could be lost |
| `merge` | Clean fast-forward and divergent merges, text conflict markers and index stages, `--abort`, resolution commits, `--ff-only`, `--no-ff`, `-m` |
| `stash` | Push/list/apply/pop/drop/clear, `-u`/`--include-untracked`, `-m`, `--index` on apply/pop, `%gs` list format |
| `config` | Repository-local `user.name` and `user.email` only |

Waffle's high-level filesystem API exposes regular files and directories, without executable mode control. This adapter rejects symlinks. Remotes, network relay, submodules, hooks, editors, filters, arbitrary config and Git aliases are outside this slice. Unsupported commands/options return an error. Conflicting text merges return 1 and leave real conflict stages and markers for `add` and `commit`, or `merge --abort`. Checkout and stash push reject an unfinished merge. Stash saves native-shaped worktree, index, and optional untracked commits. `apply --index` and `pop --index` restore every saved index path while preserving the saved worktree, including staged additions deleted before stashing. Apply and pop require the saved original HEAD and a clean tracked worktree; applying across different commits is not supported. Untracked collisions fail before saved files are restored. Ignored files are excluded from `-u`. Executable bits, symlinks, rename detection, complex file/directory conflicts, and recursive multi-base merges are not supported.

## Shell registration blocker

The pinned Waffle 0.0.90 program registry accepts only WASM source or compiled cooperative modules. A JavaScript backend cannot register `/bin/git` through that public API. `installGit` therefore returns a directly callable command object; shell scripts still cannot invoke it through PATH. It is not a completed WASM utility installation. The required provider capability is a lazy JavaScript command/worker registration with argv/env/cwd, inherited descriptors, process-scoped filesystem authority, cancellation and retirement fences. No dummy WASM module or native Git fallback is used.

## Verification and source

`npm run test:git:local` replays all four committed native-Git scenarios and 96 steps, plus binary preservation, stash deletion, collision, and refusal checks. `npm run test:git:browser` repeats all 96 steps and tracked stash in Chromium on the actual Waffle filesystem. It checks first-use loading, zero process admission, command retirement, pending-output joins, reinstallation, and caller lifetime. Neither backend nor browser replay invokes native Git.

`npm run audit:git:fixture` runs the same complete local replay. No scenarios are excluded. The fixture source and exact oracle environment are owned by `scripts/record-git-local.ts`; `node scripts/record-git-local.ts --check` audits its native recording without changing owner HOME/global config.

`scripts/patch-git-source.ts` verifies the pristine ESM/CJS hashes, adds module-local browser Buffer imports for the core and exported filesystem/index helpers, and fixes upstream `compareStats` to compare subsecond timestamps and rehash files in the racy-index window. The patch also uses `HEAD` in local conflict markers, completes clean index changes alongside conflicts, and preserves binary bytes and removes merged additions in upstream `abortMerge`. It is idempotent and refuses changed upstream source. It prevents same-sized edits within a second from appearing clean. The package license files remain in the dependency; `npm run notices:git` emits the complete bundled dependency notices.
