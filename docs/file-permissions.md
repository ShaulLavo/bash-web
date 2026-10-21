# File permission predicates

The shell reads permissions from the application-supplied Waffle runtime. It does
not try opening a file to guess whether it is readable or writable. Both `test`
and `[` use the same evaluator as `[[ ]]`.

## Contract and unknown answers

At Waffle `fc58a532f0d7a617e631ea4b7580a190915d4ed6`, the guest import is
`runtime_fs.path_permissions_get(dirfd, path, length, flags, output) -> errno`.
Flags must be zero. Success writes exactly four little-endian `u32` words:
mode, supported mode bits, effective access, supported access bits. Preview1's
64-byte filestat remains separate and unchanged. Errors leave the output alone.

`FileMetadata.mode` stores both the bits and their support mask. Existing optional
read/write/execute answers represent effective access. A supported clear bit is
false; an unsupported bit is unknown. Unknown predicates return status 2 rather
than a fabricated false answer. A missing or inaccessible path returns false
through the existing stat-error handling. Other metadata, ownership and timestamp
behavior stays unchanged.

Waffle's single virtual principal supports file modes `0600` and directory modes
`01700`. Files support read/write access. Directories also support search, which
`-x` tests. `-k` can answer for directories. File execution, file sticky bits,
setuid/setgid and group/other permissions are unknown. Native MemoryFs keeps its
previous modes and access answers with a full mode-support mask. An explicit
ENOTSUP permission-query result leaves permissions unknown without discarding
otherwise valid filestat metadata.

## Original local adapters and controls

The Rust permission decoder, WASI call and shared predicate adaptation are original
local code written from the selected Waffle contract. No Waffle implementation or
Unix access algorithm is copied. The owning files are `shell/engine/src/io.rs`,
`runtime.rs`, `runtime/wasi.rs` and `builtins/test.rs` beneath that engine directory.
The dependency revision and classification are recorded in `sources.lock.json`.

`npm run test:shell:scoreboard` includes `scripts/test-own-shell-permissions.ts`.
It runs the production shell guest through the real runtime, filesystem worker,
forked connection and process worker. It tests denied actual I/O alongside
metadata-only queries, directory search, supported false/true answers and unknown
bits in both conditional forms. A tiny original WASM probe calls the actual import
to check masks, bounds, flags, rights, invalid paths and unchanged error buffers.
Native decoder/predicate fixtures are explicitly labelled as fixtures, not runtime
evidence. Disposal checks require zero live Node workers.

## Storage selector migration

The selected dependency replaces `persistence: false` with public `mode: "memory"`.
The frozen runner still creates a fresh nonpersistent memory filesystem for each
case. Its fixture provisioning and disposal are unchanged.

Public default FAST uses IndexedDB. Existing OPFS conformance tests must not silently
switch to that backend. Only `src/browser/storage.test.ts` and `tests/browser-main.ts`
import the exact pinned source's `fs/vfs-internal.ts` helper. The latter selects OPFS
only under the existing `test=1` query. The helper and runtime share the same module
and Symbol identity; descriptor and worker-field assertions require `opfs-memory`.
Non-test composition stays on public default FAST. The existing ownership, waiting,
disposal, restart, recovery and negative takeover cases retain their purposes and
timeouts. The separate R3 browser control also inspects real OPFS payload/snapshot
files, reopens the saved value, and verifies no IndexedDB database was substituted.
