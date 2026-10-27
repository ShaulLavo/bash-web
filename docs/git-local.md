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
| `merge` | Clean fast-forward and independent divergent merges, `--ff-only`, `--no-ff`, `-m` |
| `stash` | Tracked loose-object push/list/apply/pop/drop/clear, `-m`, `--index` on apply/pop, `%gs` list format |
| `config` | Repository-local `user.name` and `user.email` only |

Waffle's high-level filesystem API exposes regular files and directories, without executable mode control. This adapter rejects symlinks. Remotes, network relay, submodules, hooks, editors, filters, arbitrary config and Git aliases are outside this slice. Unsupported commands/options return an error. Conflicting merges leave the repository unchanged and return 1; conflict-marker editing, `merge --abort` and resolution commits are not implemented. Stash excludes `-u`, packed objects and merging into a dirty worktree; dirty apply/pop is rejected before upstream's overwrite operation. Upstream stash object layout is not claimed to match native Git's index restoration convention outside these tests.

## Shell registration blocker

The pinned Waffle 0.0.90 program registry accepts only WASM source or compiled cooperative modules. A JavaScript backend cannot register `/bin/git` through that public API. `installGit` therefore returns a directly callable command object; shell scripts still cannot invoke it through PATH. It is not a completed WASM utility installation. The required provider capability is a lazy JavaScript command/worker registration with argv/env/cwd, inherited descriptors, process-scoped filesystem authority, cancellation and retirement fences. No dummy WASM module or native Git fallback is used.

## Verification and source

`npm run test:git:local` replays all 47 steps in the committed index/worktree and branch/merge native-Git scenarios, plus tracked-stash and refusal checks. `npm run test:git:browser` repeats those scenarios and tracked stash in Chromium on the actual Waffle filesystem and checks lazy loading, zero process admission and caller lifetime. Neither backend nor browser replay invokes native Git.

`npm run audit:git:fixture` runs all four recorded scenarios and currently fails the conflict-recovery and untracked-stash cases. These failures are explicit acceptance gaps, not skipped tests. The fixture source and exact oracle environment are owned by `scripts/record-git-local.ts`; `node scripts/record-git-local.ts --check` audits its native recording without changing owner HOME/global config.

`scripts/patch-git-source.ts` verifies the pristine ESM/CJS hashes, adds a module-local browser Buffer import, and fixes upstream `compareStats` to compare subsecond timestamps and rehash files in the racy-index window. The patch is idempotent and refuses changed upstream source. It prevents same-sized edits within a second from appearing clean. The package license files remain in the dependency; `npm run notices:git` emits the complete bundled dependency notices.
