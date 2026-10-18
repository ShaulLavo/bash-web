//! Separately linked external utilities. No utility is linked into the shell.
mod acceptance;
mod grep;
pub use shell_engine::io::device_endpoint;
use shell_engine::{
    executor::Cancel,
    io::{Endpoint, FdTable, FileSystem},
};
use std::rc::Rc;

#[derive(Clone, Copy)]
pub enum Utility {
    Cat,
    Grep,
    Mkdir,
    Seq,
}

pub struct Context {
    pub cancel: Cancel,
    pub filesystem: Rc<dyn FileSystem>,
    pub line_bytes: usize,
}
impl Context {
    fn fs(&self) -> &dyn FileSystem {
        self.filesystem.as_ref()
    }
}
fn endpoint(fds: &FdTable, fd: u32) -> Result<Endpoint, i32> {
    fds.get(fd).ok_or(1)
}
async fn write(fds: &FdTable, bytes: &[u8], context: &Context) -> Result<(), i32> {
    endpoint(fds, 1)?
        .write_all(bytes, &context.cancel)
        .await
        .map_err(|e| e.status())
}
pub async fn run(
    utility: Utility,
    args: Vec<String>,
    cwd: &str,
    fds: &FdTable,
    context: &Context,
) -> i32 {
    acceptance::run(utility, args, cwd, fds, context)
        .await
        .unwrap_or_else(|status| status)
}

/// One external program invocation, as delivered by the host process boundary.
pub struct Invocation {
    pub args: Vec<String>,
    pub env: std::collections::BTreeMap<String, String>,
    pub cwd: String,
    pub fds: FdTable,
    pub context: Context,
}

#[cfg(not(target_os = "wasi"))]
pub fn main(_utility: Utility) {
    eprintln!("utility requires wasm32-wasip1 and a runtime_proc host");
    std::process::exit(2);
}
#[cfg(target_os = "wasi")]
pub fn main(utility: Utility) {
    guest_main(move |invocation| async move {
        run(
            utility,
            invocation.args,
            &invocation.cwd,
            &invocation.fds,
            &invocation.context,
        )
        .await
    });
}

/// Drive one guest program over Waffle's runtime_proc descriptors and patched libc
/// root preopen. Interrupts cancel the program's future; it exits with its status.
#[cfg(target_os = "wasi")]
pub fn guest_main<F, Fut>(program: F) -> !
where
    F: FnOnce(Invocation) -> Fut + 'static,
    Fut: std::future::Future<Output = i32> + 'static,
{
    use futures::FutureExt;
    use shell_engine::{
        executor::Executor,
        runtime::{Runtime, WasiAbi},
    };
    let abi = Rc::new(WasiAbi::new().expect("root preopen"));
    abi.handle_interrupts().expect("signal setup");
    let executor = Executor::new();
    let runtime = Runtime::new(abi, executor.clone());
    let fds = runtime.stdio().expect("inherited descriptors");
    let cancel = Cancel::new();
    let invocation = Invocation {
        args: std::env::args().skip(1).collect(),
        env: std::env::vars().collect(),
        cwd: std::env::var("PWD").unwrap_or_else(|_| "/".into()),
        fds,
        context: Context {
            cancel: cancel.clone(),
            filesystem: Rc::new(runtime.clone()),
            // The shell's production limits are its defaults; a separate program
            // keeps the same record bound the former in-shell stand-in used.
            line_bytes: shell_engine::Limits::default().line_bytes,
        },
    };
    let job = executor.spawn(program(invocation));
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
