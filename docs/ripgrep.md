# Ripgrep

`bash-web/utilities/rg` installs upstream ripgrep 15.2.0 as a separate `/bin/rg` WASI program. It does not add search code to the shell.

```ts
import { installRg } from "bash-web/utilities/rg";

const installation = await installRg(runtime);
// Stop its processes before removing the installation.
await installation.dispose();
```

Pass the page's existing Waffle runtime. Installation registers the executable without fetching or compiling the program. Its first use fetches `dist/rg.wasm`. A custom `wasmUrl` or a lazy `source` loader can supply the raw WASM bytes instead. Waffle compiles and instruments those bytes for cancellation.

The program uses upstream pattern matching, recursive traversal, ignore rules, output formats, and exit statuses. Search runs on one thread without memory mapping. Requests for multiple threads, `--mmap`, `--pre`, `--search-zip`, or `--hostname-bin` fail with status 2 and a WASI-specific error. PCRE2 is not built. File metadata, links, and filesystem permissions remain limited by the supplied Waffle filesystem.

`npm run build:rg` verifies the source archive at upstream commit `6892bc2b7efe5909cbbeec8f757ed2c4c76b1d30`, applies `patches/ripgrep-wasi.patch`, and builds with the shared patched WASI libc. The patch adds WASI stdin detection and rejects unavailable platform options. It does not replace the search or ignore implementations. Upstream is dual-licensed under MIT or the Unlicense.
