//! WASI-first shell engine. It deliberately has no browser imports: the embedding
//! supplies readiness, terminal queues, filesystem endpoints and process hosting.
mod arithmetic;
mod ast_copy;
mod builtins;
mod commands;
mod exec;
mod expand;
pub mod interpreter;
mod parse;
pub mod process;
pub mod runtime;
pub mod state;
pub use interpreter::{Limits, Session};
pub use waffle_program_support::{executor, io};
