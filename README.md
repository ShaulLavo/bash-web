# bash-web

A WASM-first bash-compatible shell with a Rust parser/engine and a browser adapter for a caller-owned [Waffle](https://github.com/ShaulLavo/waffle) runtime.

```sh
npm ci
npm run build:browser
npm run serve
```

Browser embedding (serve the bundled worker and shell assets with isolation headers):

```ts
import { createRuntime } from "waffle";
import { createShell } from "bash-web";

const runtime = createRuntime({
  filesystem: { workerURL: new URL("/fs-worker.js", location.href) },
});
const shell = await createShell({ runtime, script: "printf 'hello\\n'" });
await shell.done;
await shell.dispose();
await runtime.dispose();
```

- [Setup, builds and repository layout](docs/getting-started.md)
- [Browser integration](docs/browser-runtime.md) · [Guest libc and provenance](docs/wasi-libc.md)
- [Shell workspace](docs/shell-workspace.md) · [Compatibility](docs/bash-compatibility.md)
- [Test guests](docs/test-guests.md) · [Third-party notices](THIRD_PARTY_NOTICES.md)
