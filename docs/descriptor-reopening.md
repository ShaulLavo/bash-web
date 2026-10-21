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
The old parser also accepts a leading plus in `/dev/fd/+3`, unlike Linux and
Waffle, and `test` does not normalize `/dev//fd/3` before its descriptor lookup.
Those pre-existing behaviors remain outside this adoption.

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
| Descriptor path reopening | Redirects, file substitutions, cat and grep operands translate logical fd, then use real path_open. Test offsets, flags, permissions, missing fds, remapping and shared streams. |

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


## PR47 supporting measurement

The integrated production source `6d8fd8bea2321ad3072d7e618e237b48536fbd0c`
normally merges main `f3dbd5e13e9d4875c5efd79db98aeabc7c8838fb`, including getopts.
The full production replay preserves all 9,221 records. Oils stays 1,051/1,682
scored, Brush stays 1,057/1,888, and Bashkit stays 1,443/2,222. Every gained/lost
ID list is empty, with no other outcome changes. The baseline and its historical
failure payloads are unchanged. This is supporting host-backed adoption, not a
new scored gain. See [the exact receipt](evidence/waffle-descriptor-reopening.json).

The frozen inventory contains 16 descriptor-path cases: 10 pass, four are excluded
command-dependent cases, and two fail for unrelated behavior. All 10 passes remain.
The failures are `oils:redirect:543` for `{var}` redirects and
`brush-suite:builtins/dot:8` for the missing `.` builtin.

Independent review found that grep operands still bypassed logical translation.
Before repair, `printf 'secret-stdin\n' | grep secret /dev/fd/4` read a private
stdin duplicate and returned 0. Bash 5.3.15 returned 2 with no stdout. Grep now
uses the same typed opener as cat and redirects, returns 2 without leaking data,
and retains its existing generic I/O diagnostic. The operand loop still processes
later inputs, gives quiet success priority over earlier errors, and preserves
cancellation 130 and broken-pipe 141. Production controls cover fd 3 through 6,
remapping, both numbered namespaces, stdio aliases, normalized spellings,
independent regular offsets, real pipes, ordinary files and inode access denial.

The consumer audit found no other direct shell-semantic file-operand open.
Ordinary redirects and `interpreter/file_substitution.rs` use `open_path`.
The remaining direct opens implement the filesystem itself or are test fixtures;
mkdir creates namespace entries rather than reopening input operands. No program
or generic I/O contract was added.

Integrated native/WASI suites pass 1,342/1,322 tests. Production controls pass 154,
the exact scoreboard recipe passes 573, CI tests pass 105, and runtime unit tests
pass 145. Chromium/Firefox pass 234 browser cases with 16 unchanged skips,
including shared terminals, Waiting, Restart, SAFE rejection and foreign format
preservation. Source/artifact hashes and remote teardown are recorded. Engine
layers retain zero violations and 42 production/28 test-only edges. All local
gates pass for the PR47-integrated source above. This is diagnostic evidence,
not final acceptance against current main.

## Integration checkpoint

Root issued a new hold at 2026-10-21T21:51:10.286107Z for wrapper PR50, with a
two-hour ceiling of 2026-10-21T23:51:10.286107Z. PR50 remains open at this
checkpoint. Main has moved to `016b8be51f9be63543208ec009483b7bf0b99186`, with
Oils/Brush/Bashkit totals 1058/1062/1449. Those are main's results, not a new
measurement of this branch.

The implementation is integration-ready, not final review-ready. After PR50 lands,
normally merge main, rerun the relevant source/build gates and recompute the full
frozen membership against that immutable integrated main. Do not dispatch that
final replay before integration. Preserve the completed PR47 replay above as
supporting evidence. Parent alone owns independent review, hosted CI and merge;
this checkpoint claims neither current-main acceptance nor merged status.
