//! The frozen compatibility instrument's fixture commands as separate guests.
//! They reuse the standalone harness's exact implementations rather than a copy.
#[path = "../../engine/src/compat.rs"]
pub mod compat;
use futures as _;
use serde as _;
use serde_json as _;

use futures::FutureExt;
use shell_engine::{
    executor::Cancel,
    io::{FdTable, FileSystem},
    process::{InProcessHost, SpawnRequest},
};
use std::rc::Rc;
use waffle_coreutils::{Context as CoreContext, Invocation as CoreInvocation};
use waffle_grep::{Context as GrepContext, Invocation as GrepInvocation};

/// Restore the request shape the standalone in-process host gave these fixtures.
pub fn request(
    name: &str,
    invocation: CoreInvocation,
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
    waffle_coreutils::guest_main(move |invocation| async move {
        let (request, cancel) = request(name, invocation);
        match name {
            "argv.py" => compat::argv(request, cancel).await,
            _ => compat::printenv(request, cancel).await,
        }
    });
}

#[derive(Clone, Copy)]
enum Utility {
    Cat,
    Grep,
    Mkdir,
    Seq,
    Tail,
}

pub const PROGRAM_NAMES: [&str; 5] = ["cat", "grep", "mkdir", "seq", "tail"];
const UTILITIES: [Utility; 5] = [
    Utility::Cat,
    Utility::Grep,
    Utility::Mkdir,
    Utility::Seq,
    Utility::Tail,
];

fn core_invocation(
    request: &SpawnRequest,
    cancel: Cancel,
    filesystem: Rc<dyn FileSystem>,
    line_bytes: usize,
) -> CoreInvocation {
    CoreInvocation {
        args: request.argv[1..].to_vec(),
        env: request.env.clone(),
        cwd: request.cwd.clone(),
        fds: request.fds.clone(),
        context: CoreContext {
            cancel,
            filesystem,
            line_bytes,
        },
    }
}

fn grep_invocation(
    request: &SpawnRequest,
    cancel: Cancel,
    filesystem: Rc<dyn FileSystem>,
    line_bytes: usize,
) -> GrepInvocation {
    let invocation = core_invocation(request, cancel, filesystem, line_bytes);
    GrepInvocation {
        args: invocation.args,
        env: invocation.env,
        cwd: invocation.cwd,
        fds: invocation.fds,
        context: GrepContext {
            cancel: invocation.context.cancel,
            filesystem: invocation.context.filesystem,
            line_bytes: invocation.context.line_bytes,
        },
    }
}

/// Register the moved families as external programs of the native test host.
pub fn register_in_process(
    host: &InProcessHost,
    directory: &str,
    filesystem: Rc<dyn FileSystem>,
    line_bytes: usize,
) {
    for (name, utility) in PROGRAM_NAMES.into_iter().zip(UTILITIES) {
        let filesystem = filesystem.clone();
        host.register(format!("{directory}/{name}"), move |request, cancel| {
            let filesystem = filesystem.clone();
            async move {
                match utility {
                    Utility::Cat => {
                        waffle_coreutils::cat(core_invocation(
                            &request, cancel, filesystem, line_bytes,
                        ))
                        .await
                    }
                    Utility::Grep => {
                        waffle_grep::grep(grep_invocation(&request, cancel, filesystem, line_bytes))
                            .await
                    }
                    Utility::Mkdir => {
                        waffle_coreutils::mkdir(core_invocation(
                            &request, cancel, filesystem, line_bytes,
                        ))
                        .await
                    }
                    Utility::Seq => {
                        waffle_coreutils::seq(core_invocation(
                            &request, cancel, filesystem, line_bytes,
                        ))
                        .await
                    }
                    Utility::Tail => {
                        waffle_coreutils::tail(core_invocation(
                            &request, cancel, filesystem, line_bytes,
                        ))
                        .await
                    }
                }
            }
            .boxed_local()
        });
    }
}
