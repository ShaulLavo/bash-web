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

#[cfg(not(target_os = "wasi"))]
pub fn main(_utility: Utility) {
    eprintln!("utility requires wasm32-wasip1 and a runtime_proc host");
    std::process::exit(2);
}
#[cfg(target_os = "wasi")]
pub fn main(utility: Utility) {
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
    let context = Context {
        cancel: cancel.clone(),
        filesystem: Rc::new(runtime.clone()),
        line_bytes: shell_engine::Limits::default().line_bytes,
    };
    let args = std::env::args().skip(1).collect();
    let cwd = std::env::var("PWD").unwrap_or_else(|_| "/".into());
    let job = executor.spawn(async move { run(utility, args, &cwd, &fds, &context).await });
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
