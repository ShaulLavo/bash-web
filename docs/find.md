# Find utility

`bash-web/utilities/find` installs `findutils` 0.11.0 as a separate ordinary WASI guest. Import `installFind` and pass the same Waffle runtime used by `createShell`.

```ts
import { installFind } from "bash-web/utilities/find";

const installation = await installFind(runtime);
// After its processes stop:
await installation.dispose();
```

## Supported behavior

The initial scope is traversal-only: starting paths, recursive descent, `-name`/`-path` glob matching, `-type`, `-mindepth`, `-maxdepth`, `-prune`, `-print`, `-print0`, and depth-first traversal. The wrapper sets WASI's working directory from the shell's `PWD`, so relative starting paths follow `cd`.

The guest is lazy. Installation creates `/bin/find` and registers the source loader without fetching, compiling, or starting a process. The first spawn supplies raw bytes to Waffle so it can instrument the ordinary WASI guest for interruption; later spawns reuse the admitted source.

This is not full GNU find parity. `-exec`, `-execdir`, `-ok`, and `-okdir` are excluded because they need child-process launch. `-xdev`, `-readable`, `-writable`, `-executable`, and Unix ownership, group, mount, and permission predicates are excluded because the aligned WASI/runtime metadata does not provide their authoritative behavior. `-delete`, links, time predicates, and other upstream options have no new compatibility claim in this change.

## Needs from other tracks

Traversal needs only Waffle's existing filesystem operations: directory reads (`fd_readdir`) and file metadata (`filestat`). No new runtime adapter or process-spawning path is added here.

To qualify `-exec*` or `-ok*` later, Waffle must expose the existing runtime process ABI (`runtime_proc.spawn`, completion/wait, inherited descriptors, and exit status) to an ordinary WASI guest or provide the agreed adapter. This utility does not add a cooperative bypass, a duplicate runtime, or a file-mode substitute.

## Source and checks

The guest uses `findutils` 0.11.0 from `uutils/findutils` revision `505421d4e03586efeb7b9c55adf057599e192e0a`. `shell/utilities/find.source.json` records the source archive, license digest, wrapper change, and bounded scope. The upstream MIT license is collected by `npm run notices:shell` from Cargo metadata.

Run `npm run build:shell`, `npm run build:utilities`, `npm run build:node-harness`, and `npm run test:find` for the focused real-Waffle cases. The cases use fixed trees and expected bytes; they do not invoke a host `find` or another live oracle.
