# bash-web

`bash-web` is a WASM-first bash-compatible shell with a Rust engine and a browser embedding adapter.

Follow the [tool setup](docs/development.md#build-and-test), then build the browser assets:

```sh
npm ci
npm run build:browser
```

Pass the page’s existing Waffle runtime to each browser shell:

```ts
import { createRuntime } from "waffle";
import { createShell } from "bash-web";

const runtime = createRuntime({ filesystem: { workerURL: new URL("/fs-worker.js", location.href) } });
try {
  const shell = await createShell({ runtime, script: "printf 'hello\\n'" });
  try { await shell.done; } finally { await shell.dispose(); }
} finally {
  await runtime.dispose();
}
```

See [browser integration](docs/browser-runtime.md), [development and tests](docs/development.md),
[the shell plan](plans/004-own-shell.md), and [third-party notices](THIRD_PARTY_NOTICES.md).
