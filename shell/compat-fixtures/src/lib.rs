//! The frozen compatibility instrument's fixture commands as separate guests.
//! They reuse the standalone harness's exact implementations rather than a copy.
#[path = "../../engine/src/compat.rs"]
pub mod compat;
use futures as _;
use serde as _;
use serde_json as _;

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
pub fn fixture_main(name: &'static str) {
    shell_utilities::guest_main(move |invocation| async move {
        let (request, cancel) = request(name, invocation);
        match name {
            "argv.py" => compat::argv(request, cancel).await,
            _ => compat::printenv(request, cancel).await,
        }
    });
}
