//! Test-only bridge from the shell's native process host to Waffle's program
//! families. It maps logical descriptor numbers and cancellation; every program
//! byte and status comes from the family crates themselves.
use futures::{
    FutureExt,
    future::{self, LocalBoxFuture},
};
use shell_engine::{
    executor::Cancel,
    io as shell,
    process::{InProcessHost, SpawnRequest},
};
use std::rc::Rc;
use waffle_native_family_support::{executor::Cancel as FamilyCancel, io as family};

#[derive(Clone, Copy)]
enum Utility {
    Cat,
    Grep,
    Mkdir,
    Seq,
    Tail,
}

const PROGRAMS: [(&str, Utility); 5] = [
    ("cat", Utility::Cat),
    ("grep", Utility::Grep),
    ("mkdir", Utility::Mkdir),
    ("seq", Utility::Seq),
    ("tail", Utility::Tail),
];
pub const PROGRAM_NAMES: [&str; 5] = ["cat", "grep", "mkdir", "seq", "tail"];

/// Register the moved families as external programs of the native test host.
pub fn register_in_process(
    host: &InProcessHost,
    directory: &str,
    filesystem: Rc<dyn shell::FileSystem>,
    line_bytes: usize,
) {
    for (name, utility) in PROGRAMS {
        let filesystem = filesystem.clone();
        host.register(format!("{directory}/{name}"), move |request, cancel| {
            launch(utility, request, cancel, filesystem.clone(), line_bytes)
        });
    }
}

struct Parts {
    args: Vec<String>,
    env: std::collections::BTreeMap<String, String>,
    cwd: String,
    fds: family::FdTable,
    cancel: FamilyCancel,
    filesystem: Rc<dyn family::FileSystem>,
    line_bytes: usize,
}

impl Parts {
    fn core(self) -> waffle_coreutils::Invocation {
        waffle_coreutils::Invocation {
            args: self.args,
            env: self.env,
            cwd: self.cwd,
            fds: self.fds,
            context: waffle_coreutils::Context {
                cancel: self.cancel,
                filesystem: self.filesystem,
                line_bytes: self.line_bytes,
            },
        }
    }
    fn grep(self) -> waffle_grep::Invocation {
        let invocation = self.core();
        waffle_grep::Invocation {
            args: invocation.args,
            env: invocation.env,
            cwd: invocation.cwd,
            fds: invocation.fds,
            context: waffle_grep::Context {
                cancel: invocation.context.cancel,
                filesystem: invocation.context.filesystem,
                line_bytes: invocation.context.line_bytes,
            },
        }
    }
}

fn start(utility: Utility, parts: Parts) -> LocalBoxFuture<'static, i32> {
    match utility {
        Utility::Cat => waffle_coreutils::cat(parts.core()).boxed_local(),
        Utility::Grep => waffle_grep::grep(parts.grep()).boxed_local(),
        Utility::Mkdir => waffle_coreutils::mkdir(parts.core()).boxed_local(),
        Utility::Seq => waffle_coreutils::seq(parts.core()).boxed_local(),
        Utility::Tail => waffle_coreutils::tail(parts.core()).boxed_local(),
    }
}

fn launch(
    utility: Utility,
    request: SpawnRequest,
    cancel: Cancel,
    filesystem: Rc<dyn shell::FileSystem>,
    line_bytes: usize,
) -> LocalBoxFuture<'static, i32> {
    let probe = cancel.clone();
    let family_cancel = FamilyCancel::with_probe(Rc::new(move || probe.is_cancelled()));
    let mut fds = family::FdTable::default();
    for (fd, endpoint) in request.fds.iter() {
        fds.insert(*fd, descriptor(endpoint.clone(), Some(*fd)));
    }
    let parts = Parts {
        args: request.argv[1..].to_vec(),
        env: request.env,
        cwd: request.cwd,
        fds,
        cancel: family_cancel.clone(),
        filesystem: Rc::new(Files {
            inner: filesystem,
            fds: request.fds,
        }),
        line_bytes,
    };
    let program = start(utility, parts);
    // Parked family waits listen on their own token; relay the shell's wake.
    let relay = async move {
        cancel.cancelled().await;
        family_cancel.cancel();
        future::pending::<i32>().await
    };
    async move {
        future::select(program, relay.boxed_local())
            .await
            .factor_first()
            .0
    }
    .boxed_local()
}

/// A shell open description seen through the family's host-endpoint seam. Table
/// entries carry their logical number so /dev/fd paths reopen through `Files`,
/// as runtime descriptors do in a real guest.
struct Descriptor {
    inner: shell::Endpoint,
    logical: Option<u32>,
}

fn descriptor(inner: shell::Endpoint, logical: Option<u32>) -> family::Endpoint {
    family::Endpoint::host(Rc::new(Descriptor { inner, logical }))
}

impl family::HostEndpoint for Descriptor {
    fn runtime_fd(&self) -> Option<u32> {
        self.logical
    }
    fn descriptor_kind(&self) -> Result<family::DescriptorKind, family::IoError> {
        self.inner.descriptor_kind()
    }
    fn read<'a>(
        &'a self,
        output: &'a mut [u8],
    ) -> LocalBoxFuture<'a, Result<usize, family::IoError>> {
        self.inner.read(output).boxed_local()
    }
    fn write<'a>(&'a self, input: &'a [u8]) -> LocalBoxFuture<'a, Result<usize, family::IoError>> {
        self.inner.write(input).boxed_local()
    }
}

/// The shared shell filesystem plus the request's descriptor table for /dev/fd.
struct Files {
    inner: Rc<dyn shell::FileSystem>,
    fds: shell::FdTable,
}

impl family::FileSystem for Files {
    fn pipe(&self) -> Result<(family::Endpoint, family::Endpoint), family::IoError> {
        let (reader, writer) = self.inner.pipe()?;
        Ok((descriptor(reader, None), descriptor(writer, None)))
    }
    fn mkdir<'a>(
        &'a self,
        path: &'a str,
        parents: bool,
    ) -> LocalBoxFuture<'a, Result<(), family::IoError>> {
        self.inner.mkdir(path, parents)
    }
    fn stat<'a>(
        &'a self,
        path: &'a str,
        follow_symlinks: bool,
    ) -> LocalBoxFuture<'a, Result<family::FileMetadata, family::IoError>> {
        self.inner.stat(path, follow_symlinks)
    }
    fn open_dir<'a>(
        &'a self,
        path: &'a str,
    ) -> LocalBoxFuture<'a, Result<Rc<dyn family::Directory>, family::IoError>> {
        self.inner.open_dir(path)
    }
    fn open<'a>(
        &'a self,
        path: &'a str,
        options: &'a family::OpenOptions,
    ) -> LocalBoxFuture<'a, Result<family::Endpoint, family::IoError>> {
        Box::pin(async move {
            let opening = shell::open_path(path, &self.fds, options)?;
            let endpoint = opening.open(self.inner.as_ref(), options).await?;
            Ok(descriptor(endpoint, None))
        })
    }
}
