# tr

`bash-web/utilities/tr` installs `/bin/tr` as a separate, lazy ordinary WASI program on the caller's Waffle runtime.

```ts
import { installTr } from "bash-web/utilities/tr";

const tr = await installTr(runtime, { source: () => loadTrBytes() });
await tr.dispose();
```

The entry exports `WasiUtilityOptions`, `UtilitySource`, and `UtilityInstallation`. `source` accepts raw bytes or a lazy byte loader. `wasmUrl` selects a URL instead. The default URL is `dist/tr.wasm`. Neither precompiled modules nor cooperative execution are used. Dispose leaves the caller's runtime and other programs alone.

## Source and current blocker

The implementation is unmodified upstream `uu_tr` and `uucore` at uutils/coreutils revision `07763857f6b9a547742a994b58aef0ccd036198b`, version `0.13.0`. `shell/tr/src/main.rs` calls upstream's entry. Cargo locks the exact revision and transitive dependencies. There is no multicall executable or replacement translation algorithm.

**The program compiles but cannot start on Waffle `c1cb67c300439af24335d0b2ec481bfb52f79a01`.** Ordinary source admission fails before `--version` with `ENOEXEC`, shell status 126, and `Cannot instrument WebAssembly: unsupported value type (SIMD, GC or typed reference)`. Upstream's `bytecount` dependency emits WebAssembly SIMD. Waffle owns the generic source-admission fix. This draft adds no runtime adapter, cooperative bypass, or dependency-source patch.

Reproduce after `npm run build:utilities && npm run build:node-harness`:

```sh
node --test --test-name-pattern='tr enters' scripts/test-own-shell-cut-tr.ts
```

Registry `uu_tr =0.0.30` was the one bounded unmodified alternative. It avoids `bytecount` but fails to compile for WASI because `uucore =0.0.30` enables filesystem code with Unix-only metadata APIs. That trial is not the shipped source. The exact `07763857` pin remains restored.

## Acceptance cases awaiting admission

The shared frozen GNU matrix described in [cut](cut.md#verification-checkpoint) covers translation, classes, deletion, squeezing, combined operations, complements, short and repeated destination sets, truncation, empty and unterminated input, NUL and binary bytes, errors, pipelines, status, and interruption. These `tr` cases are not claimed passing until ordinary admission works. The tests remain executable and fail at the actual runtime boundary.

GNU comparisons use `LC_ALL=C`; they do not establish full locale or multibyte parity. Error wording may differ. The upstream [MIT license](licenses/uutils-coreutils-MIT.txt) is retained and included in generated distribution notices. [cut](cut.md) has independent passing admission and byte-comparison evidence.
