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
controls happen to match Bash's pipes; that does not make Bytes a pipe. Plan 004's
Approved follow-up records the reproducer and removal condition. Descriptor metadata
predicates and lexical path normalization also retain their existing limitations;
this change does not claim virtual symlink/stat or path traversal parity.

## Consumer audit

The previous actual pin was Waffle 0.0.58, `fc58a532`, not 0.0.50. The adopted pin is
0.0.63, `c4111d15f28bd1db9e5c2ef5d08c6ff1e6477289`.

| Upstream change since 0.0.50 | Consumer action |
| --- | --- |
| FAST/SAFE/memory selector and format validation | Standalone explicitly selects FAST. SAFE preserves typed UNSUPPORTED_VFS with no fallback. Foreign IndexedDB preserves INVALID_VFS_FORMAT through the visible startup error and Restart, without deleting data. OPFS remains an internal test selector. |
| Inode modes, supported access masks and guest permission query | Already adopted at 0.0.58. Keep the four-word mode/modeSupported/access/accessSupported adapter. Waffle, not shell inference, enforces inode access. |
| Retained metadata, queued admission/rejection ownership, dispatcher and supervisor fixes | Internal upstream fixes. Keep readiness, Waiting, Restart, cancellation and disposal contracts and their tests. |
| Localhost networking and shared-worker additions | Additive, not enabled by this adoption. |
| Opt-in local publication and cross-page guard/private transport after 0.0.58 | Not enabled. Preserve one application-created Runtime and borrowed-runtime ownership. |
| Reject save completion after disposal | Adopt through the exact pin; existing physical teardown tests remain blocking. |
| Descriptor path reopening | Translate logical fd, then use real path_open. Test offsets, flags, permissions, missing fds, remapping and shared streams. |

## Provenance and verification

The Rust translation, native MemoryFs extraction, WASI rights selection and browser
error display are original bash-web adapters, not copied upstream implementations.
Their external contract is Waffle's `docs/host-abi.md`, `docs/vfs.md` and
`docs/permissions.md` at the exact pin above. No runtime source is vendored.

Run `npm run build:shell`, `npm run build:node-harness`, then
`node --test scripts/test-own-shell-descriptors.ts scripts/test-own-shell-permissions.ts`.
The descriptor test is part of the unchanged blocking scoreboard recipe, with its
exact complete selection asserted in `scripts/test-ci-workflow.ts`. Storage tests
cover the actual standalone entry in both configured browsers.


## Measured result

The full integrated production replay at `7283f602` preserves all 9,221 records
against PR44/main `2f0bf117`. Oils stays 1,023/1,682 scored, Brush stays 1,014/1,888,
and Bashkit stays 1,420/2,222. Every gained/lost ID list is empty, with no other
outcome changes. No baseline update is needed. The host-backed descriptor controls
are the new behavior; the frozen inventory contains no descriptor-path cases.
See [the exact receipt](evidence/waffle-descriptor-reopening.json).

Native/WASI tests pass 1,317/1,297 cases, the complete scoreboard test recipe passes
557, and runtime unit tests pass 145. Chromium/Firefox pass 232 browser cases with
16 unchanged skips, plus the two added real shared-terminal controls. Browser
runs use source/artifact hashes and verified remote teardown. Final review and
hosted CI belong to the parent. The root hold also requires normal PR47/main
integration and a complete frozen recomputation before landing.
