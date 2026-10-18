# bash-web

`bash-web` is a WASM-first bash-compatible shell with a Rust engine and a browser embedding adapter.

Build from a checkout with Node 26.7.0 and Rust 1.98.1:

```sh
npm ci
npm run build:shell
```

Pass the page’s existing Waffle runtime to each browser shell:

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

See [browser integration](docs/browser-runtime.md), [development and tests](docs/development.md),
[the shell plan](plans/004-own-shell.md), and [third-party notices](THIRD_PARTY_NOTICES.md).
