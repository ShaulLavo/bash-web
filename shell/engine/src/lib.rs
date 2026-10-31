//! WASI-first shell engine. It deliberately has no browser imports: the embedding
//! supplies readiness, terminal queues, filesystem endpoints and process hosting.
mod arithmetic;
mod ast_copy;
mod builtins;
mod commands;
mod exec;
pub mod executor;
mod expand;
pub mod interpreter;
pub mod io;
mod parse;
pub mod process;
pub mod runtime;
pub mod state;
pub use interpreter::{Limits, Session};

#[cfg(test)]
mod support_contract;
