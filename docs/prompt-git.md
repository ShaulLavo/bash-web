# Prompt git metadata

`bash-web/prompt` reads repository metadata directly from the Waffle filesystem. It never starts `git` and does not depend on `isomorphic-git`.

## Supported

- Repository discovery through `.git` directories and `gitdir:` files.
- Linked worktrees and their `commondir` file. `HEAD`, operation markers and the index location stay worktree-local; refs and stash metadata come from the common directory.
- `GIT_DIR` and `GIT_WORK_TREE` context variables.
- Attached branches, unborn branches and detached commits. Detached commits use a seven-character abbreviation.
- Rebase, merge, cherry-pick, revert and bisect state. Rebase progress comes from `msgnum`/`end` or `next`/`last`, and rebase wins when another marker is present.
- Stash presence from loose or packed refs, plus a bounded reflog count.

The `git_branch`, `git_commit` and `git_state` segments render this metadata. A repository format that the package cannot vouch for, including SHA-256 and reftable repositories, renders unknown metadata rather than claiming a clean or known state.

## Background status

`git_status` inspects the working tree and index in a separate background run. [Staged changes and upstream counts](prompt-git-objects.md) describe the lazy object reader and its bounds. These reads do not join repository discovery.

## Limits

Stash reflogs are counted only up to 64 KiB. A missing or oversized reflog still reports stash presence without a count. Repository discovery reads the working-directory ancestor batch and then only the selected Git metadata paths; a prompt outside a repository does not scan unrelated descendants.
