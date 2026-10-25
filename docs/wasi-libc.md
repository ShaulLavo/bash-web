# Guest libc and build provenance

Every WASI build here selects the patched sysroot supplied by the pinned Waffle
checkout for compilation and final linking. Not every artifact retains libc's
filesystem scanner: the standalone shell CLI uses its in-memory fixture
filesystem, while the browser shell uses an original Rust WASI adapter. The
`test-guest`/`test-spin` fixtures use Rust std filesystem operations and require
the real patched libc scanner. Native builds are unaffected. External Bun
payloads are not built here and remain
[separate pending coverage](browser-runtime.md#pending-external-program-coverage).

## Classified overview

**Port** adapts upstream code to the guest/host boundary. **Original adapter**
means code written here to call that boundary, not a copied upstream implementation.
**External dependency** identifies code maintained in Waffle, not vendored here.

| Source or component                                                 | Class                     | Change and owner                                                                                                         |
| ------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| [wasi-libc preopen scanner](#wasi-libc-preopen-scanner)             | Port, external dependency | Waffle's single `patches/wasi-libc/preopen-scan.patch` lets discovery skip open non-preopens; no local patch copy.       |
| [Waffle placement and libc builder](#waffle-placement-and-builder)  | External dependency       | Waffle reserves inherited targets, places preopens, and builds the shared patched sysroot.                               |
| [Shell guest adapters and probes](#shell-guest-adapters-and-probes) | Original adapter          | Original direct-WASI shell imports and libc-backed Rust fixture probes; no descriptor renumbering.                       |
| [Build and artifact verification](#build-and-artifact-verification) | Original adapter          | All Rust WASI build routes select the same final-link sysroot; verify scanner calls or original shell import identities. |

## wasi-libc preopen scanner

Upstream: [`WebAssembly/wasi-libc`, `libc-bottom-half/sources/preopens.c`](https://github.com/WebAssembly/wasi-libc/blob/2e6fb9d8ee0cdf9e431fbcabe8af3115de000a13/libc-bottom-half/sources/preopens.c),
revision `2e6fb9d8ee0cdf9e431fbcabe8af3115de000a13`, shipped by wasi-sdk **34.0**.
The change lives only in Waffle's
[`patches/wasi-libc/preopen-scan.patch`](https://github.com/ShaulLavo/waffle/blob/250967060c0268950266fc5afb85be2170fb8ed3/patches/wasi-libc/preopen-scan.patch).

Unmodified libc stops on the first `fd_prestat_get` `BADF`. WASI truthfully
returns `BADF` for an open inherited descriptor that is not a preopen, so an
inherited fd 3 would hide root at fd 4. The patch probes `fd_fdstat_get` after
that `BADF`: success skips the open non-preopen, `BADF` stops at the first empty
slot, and any other error follows libc's existing fatal error path. Other
prestat errors remain fatal. This adds no imports beyond ordinary Preview1 WASI
and does not invent successful prestat metadata or a `NOTSUP` workaround.

## Waffle placement and builder

Waffle is pinned to the commit in `peerDependencies.waffle` (`package.json`),
currently `250967060c0268950266fc5afb85be2170fb8ed3`, for both the required peer
and the development dependency. Its [`docs/wasi-libc.md`](https://github.com/ShaulLavo/waffle/blob/250967060c0268950266fc5afb85be2170fb8ed3/docs/wasi-libc.md)
is the shared contract; bash-web does not fork it.

Before guest instantiation, Waffle reserves every inherited target and places
preopens at the lowest free descriptors starting at 3. All preopens therefore
precede the first empty slot. Root is normally fd 3, fd 4 with inherited fd 3,
and fd 10 with inherited fds 3–9; a sparse high binding does not push it higher.
Guest-visible inherited numbers and shared open descriptions are preserved.
No shell adapter relocates preopens after instantiation.

The installed `node_modules/waffle/scripts/build-wasi-libc.sh` verifies the SDK
revision and source archive checksum and applies the one shared patch. It needs
wasi-sdk **34.0**, CMake **3.26+**, Ninja, curl, tar, patch, sha256sum, Linux
setsid and GNU timeout; bash-web's cache serialization also needs flock. See
[setup](development.md#prerequisites) for tool paths and commands.

## Shell guest adapters and probes

`src/runtime/guest-imports.ts` and `src/runtime/worker.ts` remain original shell
adapters over Waffle's public worker/WASI APIs. Descriptor placement belongs to
Waffle. The original `shell/engine/src/runtime/wasi.rs` adapter discovers root
through its direct Preview1 imports, bounded by the inherited-binding count
rather than a sparse high descriptor. libc discovers preopens for guests using
libc-backed path I/O. Neither path translates literal fd 3 or fabricates a root
preopen; the shell adapter is not a copied or replacement libc scanner.

`tests/guest/src/{main.rs,bin/test-spin.rs}` contain original libc-backed
filesystem and descriptor probes. The shell guest uses its existing `read`,
`test` and `printf` commands. The
[browser regression matrix](test-guests.md#inherited-descriptor-browser-regression-gate)
checks all three guests with occupied fd 3, sparse bindings, occupied fds 3–9,
nested shells, and `3<&0`. Source-admitted `test-spin` keeps its ordinary
no-checkpoint CPU-loop behavior outside the explicit finite probe commands.

## Build and artifact verification

`scripts/wasi-build.ts` is original build tooling. It invokes the installed
Waffle builder and caches a sysroot under `.build/wasi-libc/<recipe-hash>/`.
The identity includes the SDK path/version and Waffle's builder/patch bytes;
a success receipt plus `libc.a` is required before reuse. An unverified output
is rejected, not silently accepted or deleted. A flock serializes independent
callers. `.build` is consumer-owned build output, not vendored source.

Use `npm run build:shell`, `npm run build:shell:browser`,
`npm run build:test-guest`, and `npm run test:shell:wasi` rather than a bare Cargo
WASI build. Scoreboard and migration builders use the same helper. It sets
Rust's `link-self-contained=no`, selects wasi-sdk clang as the final linker,
and supplies `--target=wasm32-wasip1` and `--sysroot=<patched-sysroot>` to the
**final link**, as well as C compilation. Merely compiling against patched
headers while linking stock SDK or Rust-bundled libc is not sufficient.

The original `scripts/verify-wasi-guests.ts` inspects final Wasm artifacts.
When `__wasilibc_populate_preopens` is retained, it must call both
`__wasi_fd_prestat_get` and `__wasi_fd_fdstat_get`; checking imports alone cannot
distinguish the stock scanner. This is the real scanner proof for both Rust std
test guests. Scanner-free artifacts are accepted only when filesystem imports
are absent (the fixture CLI) or each retained `fd_prestat_*`/`path_*` function
import has the exact index named `shell_engine::runtime::wasi::<import>` (the
original browser-shell adapter). Missing scanner names alone are not proof of
safe dead-stripping: unexplained filesystem imports fail verification.

The verifier also checks the unshared 256 MiB memory maximum. Guest builds keep
the function-name section for these proofs; fixture builds strip debug info,
not names. Release build and archived scoreboard-migration paths run the
artifact verifier; browser/test helpers verify before publishing their assets.

## Output and cleanup ownership

Before a heavy build, verify the data mount/free space and record pre-existing
resources. Admit work through the host's shared build queue. Waffle owns its
unique temporary download/source/build tree under `WASI_LIBC_SCRATCH_ROOT`
 and removes it after descendants stop on success,
failure or interruption. If cleanup cannot be verified it prints and retains
the path for its caller to resolve. Compiler temporaries use that owned tree.

bash-web owns the resulting `.build/wasi-libc` cache, `.build/shell`,
`.build/test-guest`, and generated browser assets under `public/programs` and
`dist`. Retain caches only while they have a current build consumer. After
all consumers stop, remove only task-created outputs; preserve pre-existing
shared caches and owner artifacts. Disposable test/preview runs must install
teardown before setup and verify it on the execution host, including failures
and interruptions. The libc helper never deletes an existing output directory.
