//! Test-only bridge from the shell's native process host to Waffle's program
//! families. It converts descriptor, filesystem and cancellation types; every
//! program byte and status comes from the family crates themselves.
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
use waffle_program_support::{executor::Cancel as FamilyCancel, io as family};

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
        waffle_grep::Invocation {
            args: self.args,
            env: self.env,
            cwd: self.cwd,
            fds: self.fds,
            context: waffle_grep::Context {
                cancel: self.cancel,
                filesystem: self.filesystem,
                line_bytes: self.line_bytes,
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
        self.inner.descriptor_kind().map(kind).map_err(error)
    }
    fn read<'a>(
        &'a self,
        output: &'a mut [u8],
    ) -> LocalBoxFuture<'a, Result<usize, family::IoError>> {
        Box::pin(async move { self.inner.read(output).await.map_err(error) })
    }
    fn write<'a>(&'a self, input: &'a [u8]) -> LocalBoxFuture<'a, Result<usize, family::IoError>> {
        Box::pin(async move { self.inner.write(input).await.map_err(error) })
    }
}

/// The shared shell filesystem plus the request's descriptor table for /dev/fd.
struct Files {
    inner: Rc<dyn shell::FileSystem>,
    fds: shell::FdTable,
}

impl family::FileSystem for Files {
    fn pipe(&self) -> Result<(family::Endpoint, family::Endpoint), family::IoError> {
        let (reader, writer) = self.inner.pipe().map_err(error)?;
        Ok((descriptor(reader, None), descriptor(writer, None)))
    }
    fn mkdir<'a>(
        &'a self,
        path: &'a str,
        parents: bool,
    ) -> LocalBoxFuture<'a, Result<(), family::IoError>> {
        Box::pin(async move { self.inner.mkdir(path, parents).await.map_err(error) })
    }
    fn stat<'a>(
        &'a self,
        path: &'a str,
        follow_symlinks: bool,
    ) -> LocalBoxFuture<'a, Result<family::FileMetadata, family::IoError>> {
        Box::pin(async move {
            let metadata = self.inner.stat(path, follow_symlinks).await;
            metadata.map(file_metadata).map_err(error)
        })
    }
    fn open_dir<'a>(
        &'a self,
        path: &'a str,
    ) -> LocalBoxFuture<'a, Result<Rc<dyn family::Directory>, family::IoError>> {
        Box::pin(async move {
            let inner = self.inner.open_dir(path).await.map_err(error)?;
            Ok(Rc::new(Entries(inner)) as Rc<dyn family::Directory>)
        })
    }
    fn open<'a>(
        &'a self,
        path: &'a str,
        options: &'a family::OpenOptions,
    ) -> LocalBoxFuture<'a, Result<family::Endpoint, family::IoError>> {
        Box::pin(async move {
            let options = open_options(options);
            let opening = shell::open_path(path, &self.fds, &options).map_err(error)?;
            let endpoint = opening.open(self.inner.as_ref(), &options).await;
            endpoint
                .map(|endpoint| descriptor(endpoint, None))
                .map_err(error)
        })
    }
}

struct Entries(Rc<dyn shell::Directory>);

impl family::Directory for Entries {
    fn read_entry<'a>(
        &'a self,
        cookie: u64,
        output: &'a mut [u8],
    ) -> LocalBoxFuture<'a, Result<Option<family::DirectoryEntry>, family::IoError>> {
        Box::pin(async move {
            let entry = self.0.read_entry(cookie, output).await.map_err(error)?;
            Ok(entry.map(|entry| family::DirectoryEntry {
                next_cookie: entry.next_cookie,
                name: entry.name,
            }))
        })
    }
}

fn open_options(options: &family::OpenOptions) -> shell::OpenOptions {
    shell::OpenOptions {
        read: options.read,
        write: options.write,
        create: options.create,
        truncate: options.truncate,
        append: options.append,
    }
}

fn error(error: shell::IoError) -> family::IoError {
    match error {
        shell::IoError::BadDescriptor => family::IoError::BadDescriptor,
        shell::IoError::BrokenPipe => family::IoError::BrokenPipe,
        shell::IoError::Cancelled => family::IoError::Cancelled,
        shell::IoError::LimitExceeded => family::IoError::LimitExceeded,
        shell::IoError::NotFound => family::IoError::NotFound,
        shell::IoError::AlreadyExists => family::IoError::AlreadyExists,
        shell::IoError::NotDirectory => family::IoError::NotDirectory,
        shell::IoError::Unsupported => family::IoError::Unsupported,
        shell::IoError::InvalidPath => family::IoError::InvalidPath,
        shell::IoError::WriteZero => family::IoError::WriteZero,
        shell::IoError::Runtime(errno) => family::IoError::Runtime(errno),
    }
}

fn kind(kind: shell::DescriptorKind) -> family::DescriptorKind {
    match kind {
        shell::DescriptorKind::Other => family::DescriptorKind::Other,
        shell::DescriptorKind::Pipe => family::DescriptorKind::Pipe,
        shell::DescriptorKind::Terminal => family::DescriptorKind::Terminal,
        shell::DescriptorKind::Regular => family::DescriptorKind::Regular,
        shell::DescriptorKind::Directory => family::DescriptorKind::Directory,
    }
}

fn file_kind(kind: shell::FileKind) -> family::FileKind {
    match kind {
        shell::FileKind::Regular => family::FileKind::Regular,
        shell::FileKind::Directory => family::FileKind::Directory,
        shell::FileKind::Symlink => family::FileKind::Symlink,
        shell::FileKind::BlockDevice => family::FileKind::BlockDevice,
        shell::FileKind::CharacterDevice => family::FileKind::CharacterDevice,
        shell::FileKind::Fifo => family::FileKind::Fifo,
        shell::FileKind::Socket => family::FileKind::Socket,
        shell::FileKind::Unknown => family::FileKind::Unknown,
    }
}

fn file_metadata(metadata: shell::FileMetadata) -> family::FileMetadata {
    family::FileMetadata {
        kind: file_kind(metadata.kind),
        size: metadata.size,
        mode: metadata.mode.map(|mode| family::FileMode {
            bits: mode.bits,
            supported: mode.supported,
        }),
        device: metadata.device,
        inode: metadata.inode,
        uid: metadata.uid,
        gid: metadata.gid,
        accessed_ns: metadata.accessed_ns,
        modified_ns: metadata.modified_ns,
        readable: metadata.readable,
        writable: metadata.writable,
        executable: metadata.executable,
        owned_by_effective_uid: metadata.owned_by_effective_uid,
        owned_by_effective_gid: metadata.owned_by_effective_gid,
    }
}
