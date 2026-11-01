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

Unsupported pack-index versions, SHA-256 repositories, reftables, invalid UTF-8 paths, configuration includes, worktree-specific upstream configuration, and negative fetch refspecs show unknown. Missing or corrupt objects never imply a clean or synchronized repository. Alternate object directories are not searched. Loose or packed replacement refs and legacy grafts show unknown instead of reporting counts from the unreplaced graph.

## Verification

`npm run test:prompt` creates fixtures with native Git. It compares staged paths without rename detection and ahead/behind counts with `git diff --cached --no-renames` and `git rev-list --left-right --count`. Tests cover loose objects, a packed clone, both real delta encodings, unborn and diverged branches, custom and packed upstream refs, missing upstreams, linked worktrees, equal-tip reads, corruption, cancellation, and the 2,000-commit boundary. The size gate checks that objects stay outside the eager prompt graph and that their incremental download stays within 5,500 gzip bytes.

`npm run test:prompt:browser -- /absolute/path/result.json` runs a bounded Chromium baseline on real Waffle. The production-provider pair uses complete loose and packed copies of a native Git fixture with 1,001 indexed paths and four commits. Native Git verifies one staged addition and alternating upstream divergence of 1/1 and 1/2. Each turn awaits ref mutation and readback before timing, then requires the exact current nonempty marker. Successful object, pack, pack-index, and Git-index reads and bytes are recorded per sample. Packed samples must read both a pack and its index.

The report separates first paint from completed status, with the production 15 ms paint and 2,000 ms background defaults and a separate 10-second completion watchdog. It records one first-provider cold sample and ten warm samples with median and p95. Untimed validation runs first, so the cold sample does not measure cold modules or filesystem caches. CDP task durations, fixture identities, module order, and actual host and browser details accompany the samples. These are experimental baselines, not speedup claims or a new timing budget.

The existing 1,000-path and 10,000-path loops remain worktree-only measurements with unchanged thresholds. Blocked worktree and positively observed object-read controls verify independent first paint and live redraw without losing text or caret position in Bash and zsh.
