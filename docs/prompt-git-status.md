# Background working-tree status

The `git_status` prompt segment reads the repository's files through the borrowed Waffle filesystem. It never starts Git or another program. The index parser, ignore matcher, walker and marker renderer load only when the layout enables `git_status` and repository discovery finds a repository.

## Supported status

Index versions 2, 3 and 4 are supported, including compressed paths, conflict stages, assume-valid and skip-worktree entries. Conflicts count paths once. Files and symlink targets are hashed as Git blobs when their inode and mtime do not match the provider's confirmed-clean cache. Git's imported native stat data is never treated as a Waffle cache hit. File mode is ignored, as with `core.fileMode=false`, and submodule contents are skipped.

The walk follows nested `.gitignore` rules, the common directory's `info/exclude` and `$HOME/.config/git/ignore`. Later rules override earlier ones. An ignored parent cannot be re-included by a child rule. Ignored directories are not listed unless they contain tracked paths. Untracked directories count once, as in Git's default status output. Empty directories and directories containing only ignored files are omitted; checking that requires inspecting their contents until a visible entry is found.

The default displays Starship's presence markers. Set `segments.git_status.counts` to `true` to request complete counts. Symbols, the unknown marker, prefix, suffix and style are typed configuration fields. Staged and ahead/behind values belong to the separate objects reader and are not guessed by this implementation.

## Work and caches

The initial paint uses the last completed value for the same repository, directory and status configuration, dimmed while work continues. A completed result replaces the prompt through `live.update`. Enter and Ctrl+C cancel at the next work boundary. Confirmed clean files survive cancellation, so later turns reuse completed hashes. Directory classification caches avoid repeating ignore matching when directory metadata and inherited ignore rules are unchanged. Nested directory metadata is still checked, because a descendant change does not update its ancestors' mtimes.

At most one run per repository is active in a provider. File hashes have at most eight admitted operations in flight; a confirmed hit stops new hashes for that kind when counts are disabled. All admitted hashes settle before another run starts. CPU loops yield after four milliseconds and check cancellation and the deadline between bounded units.

A run allows 20,000 index entries, 2,000 directory listings and 8 MiB of file content hashing, with the configured background deadline, normally two seconds. Index files are capped at 16 MiB; each ignore file is capped at 64 KiB and each pattern at 4,096 characters. A limit, unsupported split or sparse index, checksum failure, unreadable file or expired deadline produces the dimmed `…` marker, never a partial count or a clean claim. Two deadline failures for the same index stop retries until the index changes or a prompt leaves that repository.

Line-ending conversion and clean/smudge filters are not applied. A changed file that matches its indexed content only after filtering therefore appears modified. Repositories using unsupported formats remain unknown, as documented in [Git metadata](prompt-git.md).

## Verification

`npm run test:prompt` creates real Git repositories and compares supported working-tree counts with `git status --porcelain=v2 --ignore-submodules=all`. It covers ignore precedence, collapsed untracked directories, all index versions, symlinks, conflicts, submodules, skip-worktree entries and linked worktrees, plus cache reuse, cancellation, deadlines and unknown results.

`npm run test:prompt:browser -- /absolute/path/result.json` runs the Chromium timing and typing proof on the PC. It needs Bun, installed Playwright Chromium, `npm run build:worker`, and `npm run build:shell:browser`. It creates repositories with native Git, imports their actual index and files into a real Waffle memory filesystem, measures 50 warm turns, and traces main-thread tasks. Both bash and zsh editors must preserve typed text and the caret when late status updates the prompt. The browser, runtime workers, fixture repositories and temporary profiles are removed on success or failure.
