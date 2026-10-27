//! The frozen compatibility instrument's fixture commands as separate guests.
//! They reuse the standalone harness's exact implementations rather than a copy.
#[path = "../../engine/src/compat.rs"]
pub mod compat;
mod family;
use serde as _;
use serde_json as _;

pub use family::{PROGRAM_NAMES, register_in_process};
#[cfg(target_os = "wasi")]
use shell_engine::process::SpawnRequest;

/// Restore the request shape the standalone in-process host gave these fixtures.
#[cfg(target_os = "wasi")]
fn request(
    name: &str,
    args: impl Iterator<Item = String>,
    fds: shell_engine::io::FdTable,
) -> SpawnRequest {
    SpawnRequest {
        executable: format!("/usr/bin/{name}"),
        argv: std::iter::once(name.to_owned()).chain(args).collect(),
        env: std::env::vars().collect(),
        cwd: std::env::var("PWD").unwrap_or_else(|_| "/".into()),
        fds,
        group: 0,
        parent: None,
    }
}

#[cfg(not(target_os = "wasi"))]
pub fn fixture_main(_name: &'static str) {
    eprintln!("this program requires wasm32-wasip1 and a runtime_proc host");
    std::process::exit(2);
}

/// Entry for the argv.py and printenv.py guests, driven over Waffle's runtime_proc
/// descriptors. Interrupts cancel the fixture; it exits with its status.
#[cfg(target_os = "wasi")]
pub fn fixture_main(name: &'static str) {
    use futures::FutureExt;
    use shell_engine::{
        executor::{Cancel, Executor},
        runtime::{Runtime, WasiAbi},
    };
    use std::rc::Rc;
    let abi = Rc::new(WasiAbi::new().expect("root preopen"));
    abi.handle_interrupts().expect("signal setup");
    let executor = Executor::new();
    let runtime = Runtime::new(abi, executor.clone());
    let fds = runtime.stdio().expect("inherited descriptors");
    let request = request(name, std::env::args().skip(1), fds);
    let cancel = Cancel::new();
    let job = match name {
        "argv.py" => executor.spawn(compat::argv(request, cancel.clone())),
        _ => executor.spawn(compat::printenv(request, cancel.clone())),
    };
    while !job.is_finished() {
        if runtime.take_interrupt() {
            cancel.cancel();
        }
        let turn = executor.drive(64);
        if !job.is_finished() {
            runtime
                .poll(if turn.runnable { 0 } else { -1 })
                .expect("poll");
        }
    }
    std::process::exit(job.now_or_never().unwrap());
}
