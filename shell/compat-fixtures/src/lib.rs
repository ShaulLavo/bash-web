//! The frozen compatibility instrument's fixture commands as separate guests.
//! They reuse the standalone harness's exact implementations rather than a copy.
#[path = "../../engine/src/compat.rs"]
pub mod compat;

use shell_engine::process::SpawnRequest;
use shell_utilities::Invocation;

/// Restore the request shape the standalone in-process host gave these fixtures.
pub fn request(name: &str, invocation: Invocation) -> (SpawnRequest, shell_engine::executor::Cancel) {
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
