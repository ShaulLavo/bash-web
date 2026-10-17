# bash-web packaging direction

Status: Approved (owner, 2026-10-17).

`bash-web` is the shell package. The shell is a WASM program that a runtime
runs; it is never the runtime itself. Browser process, filesystem, pipe,
network, and page lifecycle services belong to the separate `waffle` package.

Applications pass one shared waffle instance per page to the shell, for
example `createShell({ runtime })`. `bash-web` will take `waffle` as a peer
dependency pinned to a commit once bun-wasm switches to waffle. This
extraction deliberately does not add that dependency yet.

A later standalone entry point will wire one waffle instance, bash-web, and a
terminal for applications that do not provide their own host. Terminal and
browser UI remain host/product concerns until that entry point is built.
