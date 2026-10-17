# bash-web packaging direction

Status: Approved (owner, 2026-10-17).

`bash-web` is the shell package. The shell is a WASM program that a runtime
runs; it is never the runtime itself. Browser process, filesystem, pipe,
network, and page lifecycle services belong to the separate `waffle` package.

Applications pass one shared waffle instance per page to the shell, for
example `createShell({ runtime })`. The package now declares `waffle` as an
optional peer dependency pinned to commit
`b88b6ac1500c61c16411b479531f18df820e81e5` from
`git+https://github.com/ShaulLavo/waffle.git`. This is peer-only: it is not a
regular or development dependency and npm does not install it for this package.

The extracted package has no JavaScript entry that imports waffle yet; its
current entry is the standalone WASM shell program and verification harness.
Keep the peer optional until a JavaScript host entry lands, then make it
required in the same change that imports it.

A later standalone entry point will wire one waffle instance, bash-web, and a
terminal for applications that do not provide their own host. Terminal and
browser UI remain host/product concerns until that entry point is built.
