# Staged changes and upstream counts

The prompt's `git_status` segment reads staged changes and ahead/behind counts from repository files. This code loads lazily during a background status run, after the index has been parsed. Branch discovery and first paint never wait for Git objects.

## Supported

- SHA-1 loose objects, inflated with the browser's `DecompressionStream`.
- Version 2 pack indexes, including their 64-bit offset table. Pack versions 2 and 3, offset deltas, reference deltas, and chained deltas are supported. Object IDs, pack contents, pack trailers, and pack-index checksums are verified.
- Staged additions, deletions, content changes, symlink changes, and index mode changes. The comparison uses index paths, modes, and object IDs against the complete `HEAD` tree. An unborn branch uses an empty tree. Intent-to-add entries are not staged, and unresolved paths stay in the conflict category.
- Linked worktrees use their own index and `HEAD`, with objects, configuration, and shared refs from the common Git directory.
- Upstreams from branch configuration and remote fetch refspecs, including wildcard refspecs, custom tracking namespaces, local `.` remotes, and loose or packed refs. Counts describe the last fetched refs, not the live remote.
- Equal tips return zero ahead and behind without walking commits. Unequal tips use the symmetric difference of both reachable commit sets. Merge commits include every parent.

The default staged marker is `+`. Ahead, behind, and diverged markers are `⇡`, `⇣`, and `⇕`. A staged rename remains staged without similarity detection. With counts enabled, it counts as a deletion plus an addition.

## Unknown results and limits

A walk admits at most 2,000 unique commits across both tips, including shared ancestors. Exactly 2,000 is allowed. The next commit makes the result unknown, not a partial count. A branch without an upstream has no ahead/behind marker. A configured upstream whose ref or history is unavailable shows unknown.

Object work shares the status run's cancellation signal and deadline. Parsing and delta work yield at the existing work checkpoints. Other bounds are 20,000 tree entries, 128 tree levels, 64 delta dependency levels, 32 pack files, 200,000 entries per pack index, 8 MiB per inflated object, 32 MiB per input file, 64 MiB of input files per run, and 32 MiB of decoded objects. Hitting a bound shows unknown.

Waffle's `readFile` returns a whole file. The input-file limit is checked when that admitted read completes; it cannot prevent the filesystem's initial allocation. Decompression checks its output limit while reading, before accepting the full inflated result.

Unsupported pack-index versions, SHA-256 repositories, reftables, invalid UTF-8 paths, configuration includes, worktree-specific upstream configuration, and negative fetch refspecs show unknown. Missing or corrupt objects never imply a clean or synchronized repository. Alternate object directories are not searched. Replacement refs and legacy grafts show unknown instead of reporting counts from the unreplaced graph.

## Verification

`npm run test:prompt` creates fixtures with native Git. It compares staged paths without rename detection and ahead/behind counts with `git diff --cached --no-renames` and `git rev-list --left-right --count`. Tests cover loose objects, a packed clone, both real delta encodings, unborn and diverged branches, custom and packed upstream refs, missing upstreams, linked worktrees, equal-tip reads, corruption, cancellation, and the 2,000-commit boundary. The size gate checks that objects stay outside the eager prompt graph and that their incremental download stays within 5,500 gzip bytes.
