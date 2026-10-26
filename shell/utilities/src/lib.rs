//! Separately linked external utilities. No utility is linked into the shell.
mod acceptance;
mod grep;
mod tail;
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
    Tail,
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
async fn write(fds: &FdTable, bytes: &[u8], context: &Context) -> Result<(), i32> {
    let output = endpoint(fds, 1)?;
    let written = output.write_all(bytes, &context.cancel).await;
    written.map_err(|error| error.status())
}
async fn diagnostic(
    fds: &FdTable,
    context: &Context,
    name: &str,
    message: &str,
) -> Result<(), i32> {
    let Some(stderr) = fds.get(2) else {
        return Ok(());
    };
    stderr
        .write_all(format!("{name}: {message}\n").as_bytes(), &context.cancel)
        .await
        .map_err(|error| error.status())
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

pub const UTILITIES: [(&str, Utility); 5] = [
    ("cat", Utility::Cat),
    ("grep", Utility::Grep),
    ("mkdir", Utility::Mkdir),
    ("seq", Utility::Seq),
    ("tail", Utility::Tail),
];

/// Register each utility as an external program of a native in-process host, at
/// `<directory>/<name>`. Native harnesses and tests only: production starts the
/// same code as separate WASM guests through Waffle instead.
pub fn register_in_process(
    host: &shell_engine::process::InProcessHost,
    directory: &str,
    filesystem: Rc<dyn FileSystem>,
    line_bytes: usize,
) {
    use futures::FutureExt;
    for (name, utility) in UTILITIES {
        let filesystem = filesystem.clone();
        host.register(format!("{directory}/{name}"), move |request, cancel| {
            let context = Context {
                cancel,
                filesystem: filesystem.clone(),
                line_bytes,
            };
            async move {
                run(
                    utility,
                    request.argv[1..].to_vec(),
                    &request.cwd,
                    &request.fds,
                    &context,
                )
                .await
            }
            .boxed_local()
        });
    }
}

fn endpoint(fds: &FdTable, fd: u32) -> Result<Endpoint, i32> {
    fds.get(fd).ok_or(1)
}

pub struct Invocation {
    pub args: Vec<String>,
    pub env: std::collections::BTreeMap<String, String>,
    pub cwd: String,
    pub fds: FdTable,
    pub context: Context,
}

pub async fn cat(invocation: Invocation) -> i32 {
    let Invocation {
        args,
        cwd,
        fds,
        context,
        ..
    } = invocation;
    acceptance::cat(args, &cwd, &fds, &context)
        .await
        .map(|()| 0)
        .unwrap_or_else(|status| status)
}
pub async fn grep(invocation: Invocation) -> i32 {
    let Invocation {
        args,
        cwd,
        fds,
        context,
        ..
    } = invocation;
    grep::run(args, &cwd, &fds, &context)
        .await
        .unwrap_or_else(|status| status)
}
pub async fn mkdir(invocation: Invocation) -> i32 {
    let Invocation {
        args,
        cwd,
        fds,
        context,
        ..
    } = invocation;
    acceptance::mkdir(args, &cwd, &fds, &context)
        .await
        .unwrap_or_else(|status| status)
}
pub async fn seq(invocation: Invocation) -> i32 {
    let Invocation {
        args, fds, context, ..
    } = invocation;
    acceptance::seq(&args, &fds, &context)
        .await
        .map(|()| 0)
        .unwrap_or_else(|status| status)
}

pub async fn tail(invocation: Invocation) -> i32 {
    let Invocation {
        args,
        cwd,
        fds,
        context,
        ..
    } = invocation;
    tail::run(args, &cwd, &fds, &context)
        .await
        .unwrap_or_else(|status| status)
}

#[cfg(not(target_os = "wasi"))]
pub fn guest_main<F, Fut>(_program: F) -> !
where
    F: FnOnce(Invocation) -> Fut + 'static,
    Fut: std::future::Future<Output = i32> + 'static,
{
    eprintln!("this program requires wasm32-wasip1 and a runtime_proc host");
    std::process::exit(2);
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
