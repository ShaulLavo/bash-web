# Descriptor reopening

The shell translates its logical descriptor number through `Endpoint::runtime_fd`
before Waffle opens `/dev/fd/N` or `/proc/self/fd/N`. Its private physical descriptor
numbers are not shell fd numbers. Closed logical descriptors fail before host lookup.
Regular host files reopen the same inode at offset zero with independent flags and
current inode permission checks. Pipes and terminals keep their shared description.
`<&` and `>&` remain ordinary duplication, not independent reopening.

Descriptor opens omit CREATE. Stream opens request read/write, stat and poll rights,
not the seek/tell rights that regular files receive. Ordinary filesystem opens keep
those existing rights. The production tests exercise real Waffle, not a fake ABI.

## Retained local boundary

`io::DescriptorOpen` distinguishes host paths from local descriptions. Native
MemoryFs files use the owning filesystem's same-node/new-description operation,
with independent offset and options. They are not cloned or copied into snapshots.
Native pipes duplicate the actual local pipe. Capture/null fixtures and unexported
here-document/here-string byte buffers keep their existing local behavior. An opaque
host endpoint without a runtime fd returns Unsupported rather than pretending to
reopen a file. No FileSystem or HostEndpoint contract changed.

An unexported byte buffer still shares its cursor. After child export, the existing
buffer machinery exposes a real host pipe, and reopening shares that pipe. Neither
state provides Bash's large here-input regular-file reopening behavior. Short input
controls happen to match Bash's pipes; that does not make Bytes a pipe. A separate
known gap remains with a reproducer and a removal condition. Descriptor metadata
predicates and lexical path normalization also retain their existing limitations;
virtual symlink/stat and path traversal parity are not claimed.
The old parser also accepts a leading plus in `/dev/fd/+3`, unlike Linux and
Waffle, and `test` does not normalize `/dev//fd/3` before its descriptor lookup.
Both behaviors differ from Bash and are not fixed.

## Runtime pin and storage behavior

The shell pins Waffle 0.0.63, `c4111d15f28bd1db9e5c2ef5d08c6ff1e6477289`.

- The standalone page selects FAST storage explicitly. SAFE storage preserves the typed `UNSUPPORTED_VFS` error with no fallback. A foreign IndexedDB format preserves `INVALID_VFS_FORMAT` through the visible startup error and Restart, without deleting data. OPFS stays an internal test selector.
- The shell reads inode modes, supported access masks and the guest permission query through a four-word adapter (mode, modeSupported, access, accessSupported). Waffle, not shell inference, enforces inode access.
- Readiness, Waiting, Restart, cancellation and disposal contracts are unchanged. Disposal rejects a save that completes afterwards.
- Localhost networking, shared workers, opt-in local publication and cross-page guards exist in Waffle but are not enabled. The page keeps one application-created runtime and borrows it.
- Redirects, file substitutions, `cat` and `grep` operands translate the logical fd, then use the real `path_open`. Tests cover offsets, flags, permissions, missing fds, remapping and shared streams.

`grep` returns 2 without leaking data for an fd it cannot reopen, as Bash 5.3.15 does: `printf 'secret-stdin\n' | grep secret /dev/fd/4` prints nothing and exits 2. It reuses the typed opener of `cat` and redirects, keeps its generic I/O diagnostic, still processes later operands, gives quiet success priority over earlier errors, and preserves cancellation 130 and broken-pipe 141. No other shell-semantic file-operand open bypasses the translation. The remaining direct opens implement the filesystem or are test fixtures, and `mkdir` creates namespace entries.

## Provenance and verification

The Rust translation, native MemoryFs extraction, WASI rights selection and browser error display are original bash-web adapters, not copied upstream implementations. Their external contract is Waffle's `docs/host-abi.md`, `docs/vfs.md` and `docs/permissions.md` at the exact pin above. No runtime source is vendored.

Run `npm run build:shell`, `npm run build:node-harness`, then `node --test scripts/test-own-shell-descriptors.ts scripts/test-own-shell-permissions.ts`. The descriptor test is part of the blocking scoreboard recipe, and `scripts/test-ci-workflow.ts` asserts its exact selection. Storage tests cover the standalone entry in Chromium and Firefox.

## Measured effect

Measured at source `d7009e1afbdc06cd29ebb52dc78c97a2326154e3`: the full replay covers all 9,221 records and changes no score. Oils stays at 1,154/1,682 scored, Brush at 1,120/1,888, Bashkit at 1,554/2,222. The gained, lost and newly failing lists are empty. See [the receipt](evidence/waffle-descriptor-reopening.json) and [Bash compatibility](bash-compatibility.md) for the replay command.

The frozen inventory has 16 descriptor-path cases: 10 pass, four are excluded command-dependent cases, and two fail for unrelated reasons: `oils:redirect:543` (`{var}` redirects) and `brush-suite:builtins/dot:8` (no `.` builtin).

Integrated suites at that source: native/WASI 1,438/1,418 tests, production controls 154, scoreboard recipe 710, CI tests 105, runtime unit tests 145. Chromium and Firefox pass 234 browser cases with 16 skipped, including shared terminals, Waiting, Restart, SAFE rejection and foreign-format preservation. The eight short and large here-input observations are unchanged. Engine layers keep zero violations and 42 production and 30 test-only edges.

Full alias removal and large here-input parity are not claimed until the local-buffer gap above is closed.
