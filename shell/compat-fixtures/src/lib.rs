//! The frozen compatibility instrument's fixture commands as separate guests.
//! They reuse the standalone harness's exact implementations rather than a copy.
#[path = "../../engine/src/compat.rs"]
pub mod compat;

use shell_engine::process::SpawnRequest;
use shell_utilities::Invocation;

/// Restore the request shape the standalone in-process host gave these fixtures.
pub fn request(
    name: &str,
    invocation: Invocation,
) -> (SpawnRequest, shell_engine::executor::Cancel) {
    let mut argv = vec![name.to_owned()];
    argv.extend(invocation.args);
    let request = SpawnRequest {
        executable: format!("/usr/bin/{name}"),
        argv,
        env: invocation.env,
        cwd: invocation.cwd,
        fds: invocation.fds,
        group: 0,
        parent: None,
    };
    (request, invocation.context.cancel)
}

/// Entry for the argv.py and printenv.py guests.
#[cfg(not(target_os = "wasi"))]
pub fn fixture_main(name: &'static str) {
    eprintln!("{name} fixture requires wasm32-wasip1 and a runtime_proc host");
    std::process::exit(2);
}
#[cfg(target_os = "wasi")]
pub fn fixture_main(name: &'static str) {
    shell_utilities::guest_main(move |invocation| async move {
        let (request, cancel) = request(name, invocation);
        match name {
            "argv.py" => compat::argv(request, cancel).await,
            _ => compat::printenv(request, cancel).await,
        }
    });
}
