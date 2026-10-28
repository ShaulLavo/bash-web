# Install program families

Everyday external commands come from Waffle's `waffle-base` package: coreutils, findutils, grep, sed, and ripgrep. The shell core and its real builtins stay in bash-web. A command with no installed program on `PATH` fails with status 127.

Install base on the same caller-owned `Runtime` used for the shell, with Waffle's generic preview1 launcher:

```ts
import { installBase } from "waffle-base";

const programs = await installBase(runtime, { launcher });
try {
  const shell = await createShell({ runtime, script: "printf hello | cat" });
  try {
    await shell.done;
  } finally {
    await shell.dispose();
  }
} finally {
  await programs.dispose();
}
```

`launcher` is the application's `GuestLauncher` for Waffle's generic preview1 worker. It is not bash-web's shell worker or a second runtime. Base installation registers the programs but does not fetch, compile, or start them; each guest loads on first use. Families install at `/usr/bin/<name>` and declare their `/bin/<name>` aliases. The returned `path` lists the installed directories.

Base includes `cat`, `cut`, `env`, `find`, `grep`, `head`, `ls`, `mkdir`, `rg`, `sed`, `seq`, `sort`, `tail`, `uniq`, `wc`, `xargs`, and the other everyday coreutils. Each family package owns its behavior, assets, notices, and limitations.

## Dispose and conflicts

Call `dispose()` after program processes stop. It releases registrations and removes only unchanged markers created by that installation, then allows a later reinstall. `runtime.dispose()` releases the whole runtime instead.

A duplicate or foreign path fails with `ProgramConflictError`. A failed multi-package install rolls back every path it created. Existing matching markers can be reused without becoming installation-owned files.

## Related

- [Embed a shell in a page](embed-in-a-page.md)
- [API reference](../reference/api.md)
