//! Native/WASI embedding smoke and size harness, NOT the browser process adapter.
//! This core-only entry installs no external commands; `shell-cli` composes the core
//! with the separately linked utilities for the native fuzzers.
mod compat;
fn main() {
    compat::standalone(|_, _, _| {});
}
