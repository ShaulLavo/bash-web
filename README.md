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

const runtime = createRuntime({
  filesystem: { workerURL: new URL("/fs-worker.js", location.href) },
});
try {
  const shell = await createShell({ runtime, script: "printf 'hello\\n'" });
  try {
    await shell.done;
  } finally {
    await shell.dispose();
  }
} finally {
  await runtime.dispose();
}
```

- [Setup, builds and repository layout](docs/getting-started.md)
- [Browser integration](docs/browser-runtime.md) · [Guest libc and provenance](docs/wasi-libc.md)
- [Shell workspace](docs/shell-workspace.md) · [Compatibility](docs/bash-compatibility.md)
- [Test guests](docs/test-guests.md) · [Third-party notices](THIRD_PARTY_NOTICES.md)

See also [development and architecture](docs/development.md) and [the shell plan](plans/004-own-shell.md).
