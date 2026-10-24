//! Original fixture commands matching the compatibility harness's Python helpers.
//! Output goes through bounded descriptors, including for a long argument list.
use futures::{FutureExt, future::LocalBoxFuture};
use serde::Deserialize;
use shell_engine::{
    Limits, Session,
    executor::{Budget, Cancel, Executor},
    io::{
        Directory, Endpoint, FdTable, FileKind, FileMetadata, FileSystem, IoError, MemoryFs,
        OpenOptions, pipe,
    },
    process::{InProcessHost, SpawnRequest},
};
use std::{io::Write, rc::Rc};

/// Standalone-only mount policy matching the oracle's read-only system tree.
/// Provision helper files before mounting; writable cwd/tmp stay ordinary MemoryFs.
/// FileSystem callers supply absolute paths resolved against the shell's cwd.
pub struct ReadOnlyMount {
    inner: MemoryFs,
    root: &'static str,
    denied_directories: Vec<String>,
}
impl ReadOnlyMount {
    pub fn new(inner: MemoryFs, root: &'static str) -> Self {
        assert!(root.starts_with('/') && !root.ends_with('/'));
        Self {
            inner,
            root,
            denied_directories: Vec::new(),
        }
    }
    pub fn with_denied_directories(mut self, paths: Vec<String>) -> Self {
        self.denied_directories = paths;
        self
    }
    // MemoryFs has no symlinks. Resolve the same components as stat, retaining
    // fixture traversal denial before simplifying `.` or `..`. The bounded
    // manifest supplies this policy to both metadata and executable access.
    fn resolve(&self, path: &str) -> Result<String, IoError> {
        if !path.starts_with('/') || path.len() > 4096 || path.contains('\0') {
            return Err(IoError::InvalidPath);
        }
        let mut resolved = String::with_capacity(path.len());
        resolved.push('/');
        for component in path.split('/').skip(1) {
            if component.is_empty() {
                continue;
            }
            if self.denied_directories.contains(&resolved) {
                return Err(IoError::Runtime(2)); // WASI EACCES
            }
            match component {
                "." => {}
                ".." => {
                    let index = resolved.rfind('/').unwrap();
                    resolved.truncate(index.max(1));
                }
                _ => {
                    if resolved.len() > 1 {
                        resolved.push('/');
                    }
                    resolved.push_str(component);
                }
            }
        }
        Ok(resolved)
    }
    fn contains(&self, path: &str) -> bool {
        path == self.root
            || path
                .strip_prefix(self.root)
                .is_some_and(|rest| rest.starts_with('/'))
    }
}
impl FileSystem for ReadOnlyMount {
    fn mkdir<'a>(
        &'a self,
        path: &'a str,
        parents: bool,
    ) -> LocalBoxFuture<'a, Result<(), IoError>> {
        async move {
            let resolved = self.resolve(path)?;
            if self.contains(&resolved) {
                match self.inner.stat(path, true) {
                    Ok(metadata) if metadata.kind == FileKind::Directory && parents => Ok(()),
                    Ok(_) => Err(IoError::AlreadyExists),
                    Err(_) => Err(IoError::Runtime(69)), // WASI EROFS
                }
            } else {
                self.inner.mkdir(path, parents)
            }
        }
        .boxed_local()
    }
    fn stat<'a>(
        &'a self,
        path: &'a str,
        follow_symlinks: bool,
    ) -> LocalBoxFuture<'a, Result<FileMetadata, IoError>> {
        async move {
            // Validate every original component first: a missing/file ancestor
            // followed by `..` must not become a successful lexical lookup.
            let mut metadata = self.inner.stat(path, follow_symlinks)?;
            let resolved = self.resolve(path)?;
            if self.contains(&resolved) {
                metadata.writable = Some(false);
            }
            Ok(metadata)
        }
        .boxed_local()
    }
    fn open_dir<'a>(
        &'a self,
        path: &'a str,
    ) -> LocalBoxFuture<'a, Result<std::rc::Rc<dyn Directory>, IoError>> {
        async move {
            self.resolve(path)?;
            FileSystem::open_dir(&self.inner, path).await
        }
        .boxed_local()
    }
    fn open<'a>(
        &'a self,
        path: &'a str,
        options: &'a OpenOptions,
    ) -> LocalBoxFuture<'a, Result<Endpoint, IoError>> {
        async move {
            let resolved = self.resolve(path)?;
            if self.contains(&resolved)
                && (options.write || options.create || options.truncate || options.append)
            {
                return Err(IoError::Runtime(69)); // WASI EROFS
            }
            self.inner.open(path, options)
        }
        .boxed_local()
    }
}

pub fn register(host: &InProcessHost, fs: &MemoryFs) {
    fs.mkdir("/usr/local/bin", true)
        .expect("fixture system directory");
    fs.mkdir("/usr/bin", true)
        .expect("fixture helper directory");
    for path in ["/usr/bin/argv.py", "/usr/bin/printenv.py"] {
        fs.write_file(path, &[]).expect("fixture helper file");
        fs.set_executable(path, true)
            .expect("fixture helper metadata");
        host.register_access(path, "/", Ok(()));
        host.register_traversal_error(path, "/", 54);
    }
    host.register("/usr/bin/argv.py", |request, cancel| {
        argv(request, cancel).boxed_local()
    });
    host.register("/usr/bin/printenv.py", |request, cancel| {
        printenv(request, cancel).boxed_local()
    });
}

// These are wire-contract limits, not a second fixture tree. The sole tree is
// supplied by scripts/fuzz-shell-path.ts through BASH_WEB_PATH_FIXTURE.
const MAX_MANIFEST_BYTES: usize = 32768;
const MAX_NODES: usize = 128;
const MAX_PATH_BYTES: usize = 256;
const MAX_MARKER_BYTES: usize = 64;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct FixtureManifest {
    schema: u32,
    #[serde(deserialize_with = "bounded_nodes")]
    nodes: Vec<FixtureNode>,
}
#[derive(Debug, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum FixtureKind {
    Directory,
    File,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct FixtureNode {
    #[serde(deserialize_with = "fixture_path")]
    path: String,
    kind: FixtureKind,
    mode: u32,
    #[serde(default, deserialize_with = "fixture_marker")]
    marker: Option<String>,
    #[serde(default, deserialize_with = "fixture_status")]
    status: Option<i32>,
}

fn bounded_string<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
    limit: usize,
) -> Result<String, D::Error> {
    struct Bounded(usize);
    impl<'de> serde::de::Visitor<'de> for Bounded {
        type Value = String;
        fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(f, "a string of at most {} bytes", self.0)
        }
        fn visit_str<E: serde::de::Error>(self, value: &str) -> Result<String, E> {
            if value.len() > self.0 {
                return Err(E::custom("oversized fixture string"));
            }
            Ok(value.to_owned())
        }
    }
    deserializer.deserialize_str(Bounded(limit))
}
fn fixture_path<'de, D: serde::Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    bounded_string(d, MAX_PATH_BYTES)
}
fn fixture_marker<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    bounded_string(d, MAX_MARKER_BYTES).map(Some)
}
fn fixture_status<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<i32>, D::Error> {
    i32::deserialize(d).map(Some)
}
fn bounded_nodes<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<FixtureNode>, D::Error> {
    struct Nodes;
    impl<'de> serde::de::Visitor<'de> for Nodes {
        type Value = Vec<FixtureNode>;
        fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(f, "at most {MAX_NODES} fixture nodes")
        }
        fn visit_seq<A: serde::de::SeqAccess<'de>>(
            self,
            mut seq: A,
        ) -> Result<Self::Value, A::Error> {
            use serde::de::Error;
            if seq.size_hint().is_some_and(|size| size > MAX_NODES) {
                return Err(A::Error::custom("too many fixture nodes"));
            }
            // Never reserve from the deserializer's untrusted size hint.
            let mut nodes = Vec::new();
            while nodes.len() < MAX_NODES {
                let Some(node) = seq.next_element()? else {
                    return Ok(nodes);
                };
                nodes.push(node);
            }
            // Detect overflow without allocating the extra node or its strings.
            if seq.next_element::<serde::de::IgnoredAny>()?.is_some() {
                return Err(A::Error::custom("too many fixture nodes"));
            }
            Ok(nodes)
        }
    }
    d.deserialize_seq(Nodes)
}

fn parse_manifest(raw: &str) -> Result<FixtureManifest, String> {
    if raw.len() > MAX_MANIFEST_BYTES {
        return Err("oversized fixture JSON".to_owned());
    }
    let manifest: FixtureManifest =
        serde_json::from_str(raw).map_err(|error| format!("invalid fixture JSON: {error}"))?;
    if manifest.schema != 1 {
        return Err("unsupported fixture schema".to_owned());
    }
    for (index, node) in manifest.nodes.iter().enumerate() {
        if node.path.is_empty()
            || node.path.bytes().any(|byte| byte < 0x20 || byte == 0x7f)
            || node
                .path
                .split('/')
                .any(|part| matches!(part, "" | "." | ".."))
            || manifest.nodes[..index]
                .iter()
                .any(|prior| prior.path == node.path)
        {
            return Err("invalid or duplicate fixture path".to_owned());
        }
        if let Some((parent, _)) = node.path.rsplit_once('/')
            && !manifest.nodes[..index]
                .iter()
                .any(|prior| prior.kind == FixtureKind::Directory && prior.path == parent)
        {
            return Err("fixture parent must be an earlier directory".to_owned());
        }
        if node.mode > 0o777 {
            return Err("invalid fixture mode".to_owned());
        }
        match (&node.marker, node.status) {
            (None, None) => {}
            (Some(marker), Some(1..=255))
                if node.kind == FixtureKind::File
                    && !marker.is_empty()
                    && marker.bytes().all(|byte| {
                        byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')
                    }) => {}
            _ => return Err("invalid fixture program".to_owned()),
        }
    }
    Ok(manifest)
}

/// Validate the complete bounded manifest before filesystem/process mutation.
/// Access outcomes and exact programs come only from this document; a callback
/// registration alone never establishes executable eligibility.
pub fn register_fixture(
    host: &InProcessHost,
    fs: &MemoryFs,
    cwd: &str,
    raw: &str,
) -> Result<Vec<String>, String> {
    let manifest = parse_manifest(raw)?;
    let root = cwd.trim_end_matches('/');
    // Reserve enough room for the derived not-a-directory access paths too.
    if !cwd.starts_with('/')
        || root.len() + 2 * MAX_PATH_BYTES + 2 > 4096
        || cwd.bytes().any(|byte| byte < 0x20 || byte == 0x7f)
        || root
            .split('/')
            .skip(1)
            .any(|part| matches!(part, "" | "." | ".."))
    {
        return Err("invalid fixture cwd".to_owned());
    }
    let absolute = |path: &str| format!("{root}/{path}");
    host.register_directory(cwd, cwd);
    for node in &manifest.nodes {
        let path = absolute(&node.path);
        if node.kind == FixtureKind::Directory {
            fs.mkdir(&path, false)
                .map_err(|_| "fixture mkdir failed".to_owned())?;
        } else {
            fs.write_file(&path, &[])
                .map_err(|_| "fixture file failed".to_owned())?;
            fs.set_executable(&path, node.mode & 0o111 != 0)
                .map_err(|_| "fixture metadata failed".to_owned())?;
        }
    }
    for node in &manifest.nodes {
        let path = absolute(&node.path);
        let denied = manifest.nodes.iter().any(|ancestor| {
            ancestor.kind == FixtureKind::Directory
                && ancestor.mode & 0o111 == 0
                && (node.path == ancestor.path
                    || node
                        .path
                        .strip_prefix(ancestor.path.as_str())
                        .is_some_and(|rest| rest.starts_with('/')))
        });
        let result = if denied {
            Err(44)
        } else if node.kind == FixtureKind::Directory {
            Err(2)
        } else if node.mode & 0o111 != 0 {
            Ok(())
        } else {
            Err(2)
        };
        host.register_access(path.clone(), cwd, result);
        if node.kind == FixtureKind::Directory {
            host.register_directory(path.clone(), cwd);
        }
        if node.kind == FixtureKind::File {
            host.register_traversal_error(path.clone(), cwd, 54);
        } else if node.mode & 0o111 == 0 {
            host.register_traversal_error(path.clone(), cwd, 44);
        }
        if let (Some(marker), Some(status)) = (node.marker.clone(), node.status) {
            let marker = marker.into_bytes();
            host.register(path, move |request, cancel| {
                let marker = marker.clone();
                async move {
                    let Some(output) = request.fds.get(1) else {
                        return 1;
                    };
                    for bytes in [b"marker=<".as_slice(), &marker, b">\n"] {
                        if output.write_all(bytes, &cancel).await.is_err() {
                            return 1;
                        }
                    }
                    for arg in request.argv.iter().skip(1) {
                        for bytes in [b"arg=<".as_slice(), arg.as_bytes(), b">\n"] {
                            if output.write_all(bytes, &cancel).await.is_err() {
                                return 1;
                            }
                        }
                    }
                    status
                }
                .boxed_local()
            });
        }
    }
    Ok(manifest
        .nodes
        .iter()
        .filter(|node| node.kind == FixtureKind::Directory && node.mode & 0o111 == 0)
        .map(|node| absolute(&node.path))
        .collect())
}

pub async fn argv(request: SpawnRequest, cancel: Cancel) -> i32 {
    let Some(output) = request.fds.get(1) else {
        return 1;
    };
    if output.write_all(b"[", &cancel).await.is_err() {
        return 1;
    }
    for (index, arg) in request.argv.iter().skip(1).enumerate() {
        if index > 0 && output.write_all(b", ", &cancel).await.is_err() {
            return 1;
        }
        if repr(&output, arg.as_bytes(), &cancel).await.is_err() {
            return 1;
        }
    }
    if output.write_all(b"]\n", &cancel).await.is_err() {
        return 1;
    }
    0
}

pub async fn printenv(request: SpawnRequest, cancel: Cancel) -> i32 {
    let Some(output) = request.fds.get(1) else {
        return 1;
    };
    let mut budget = Budget::default();
    for name in request.argv.iter().skip(1) {
        if budget.checkpoint(&cancel).await.is_err() {
            return 130;
        }
        let value = request.env.get(name).map(String::as_str).unwrap_or("None");
        if output.write_all(value.as_bytes(), &cancel).await.is_err()
            || output.write_all(b"\n", &cancel).await.is_err()
        {
            return 1;
        }
    }
    0
}

async fn repr(output: &Endpoint, bytes: &[u8], cancel: &Cancel) -> Result<(), ()> {
    let quote = if bytes.contains(&b'\'') && !bytes.contains(&b'"') {
        b'"'
    } else {
        b'\''
    };
    let mut buffer = vec![quote];
    let mut budget = Budget::default();
    for byte in bytes {
        budget.checkpoint(cancel).await.map_err(|_| ())?;
        escape(*byte, quote, &mut buffer);
        if buffer.len() >= 8192 {
            output.write_all(&buffer, cancel).await.map_err(|_| ())?;
            buffer.clear();
        }
    }
    buffer.push(quote);
    output.write_all(&buffer, cancel).await.map_err(|_| ())
}

fn escape(byte: u8, quote: u8, buffer: &mut Vec<u8>) {
    match byte {
        b'\\' => buffer.extend_from_slice(b"\\\\"),
        b'\n' => buffer.extend_from_slice(b"\\n"),
        b'\r' => buffer.extend_from_slice(b"\\r"),
        b'\t' => buffer.extend_from_slice(b"\\t"),
        b'\'' if quote == b'\'' => buffer.extend_from_slice(b"\\'"),
        0x20..=0x7e => buffer.push(byte),
        _ => {
            let hex = b"0123456789abcdef";
            buffer.extend_from_slice(&[
                b'\\',
                b'x',
                hex[(byte >> 4) as usize],
                hex[(byte & 15) as usize],
            ]);
        }
    }
}

/// The standalone harness loop shared by the core-only `shell-engine` entry and the
/// `shell-cli` test composition. `install` adds external programs to its own host.
/// Host stdio is touched only between nonblocking executor turns; a bounded
/// terminal endpoint applies backpressure to tasks. No stage calls WASI fd_read.
pub fn standalone(install: impl FnOnce(&InProcessHost, &MemoryFs, Rc<dyn FileSystem>)) -> ! {
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 3 || args[1] != "-c" {
        eprintln!("usage: shell-engine -c 'builtins-only script' (process host not installed)");
        std::process::exit(2);
    }
    let executor = Executor::new();
    let host = InProcessHost::new(executor.clone());
    let fs = MemoryFs::new(16 * 1024 * 1024);
    register(&host, &fs);
    let cwd = std::env::var("PWD").ok();
    let fixture = std::env::var_os("BASH_WEB_PATH_FIXTURE");
    let mut denied_directories = Vec::new();
    if fixture.is_some() && cwd.is_none() {
        eprintln!("cannot install path fixture without PWD");
        std::process::exit(2);
    }
    // The standalone host selects a virtual cwd from its environment. Create
    // that directory in its own filesystem before exposing it to the shell.
    if let Some(cwd) = cwd.as_deref() {
        if let Err(error) = fs.mkdir(cwd, true) {
            eprintln!("cannot create virtual working directory: {error:?}");
            std::process::exit(error.status());
        }
        if let Some(raw) = fixture {
            let Some(raw) = raw.to_str() else {
                eprintln!("cannot install path fixture: invalid UTF-8");
                std::process::exit(2);
            };
            denied_directories = match register_fixture(&host, &fs, cwd, raw) {
                Ok(paths) => paths,
                Err(error) => {
                    eprintln!("cannot install path fixture: {error}");
                    std::process::exit(2);
                }
            };
        }
    }
    let filesystem: Rc<dyn FileSystem> =
        Rc::new(ReadOnlyMount::new(fs.clone(), "/usr").with_denied_directories(denied_directories));
    install(&host, &fs, filesystem.clone());
    let session = Session::new(
        executor.clone(),
        Rc::new(host),
        filesystem,
        Limits::default(),
    );
    {
        let state = session.state();
        let mut state = state.borrow_mut();
        state.initialize_cli_environment(std::env::vars());
        if let Some(cwd) = cwd {
            state.cwd = cwd;
        }
    }
    let (terminal, writer) = pipe();
    let (diagnostics, error_writer) = pipe();
    let mut fds = FdTable::default();
    fds.insert(0, Endpoint::null());
    fds.insert(1, writer);
    fds.insert(2, error_writer);
    session.set_descriptors(fds).unwrap();
    let job = match session.start(&args[2]) {
        Ok(job) => job,
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(2);
        }
    };
    let mut output = std::io::stdout().lock();
    let mut errors = std::io::stderr().lock();
    let code = loop {
        executor.drive(256);
        drain(&terminal, &mut output, &session);
        drain(&diagnostics, &mut errors, &session);
        if job.is_finished() {
            break job.now_or_never().unwrap();
        }
        if !executor.drive(0).runnable {
            // This stand-alone embedding has no external readiness provider.
            // Browser integration supplies one rather than adding a polling loop.
            session.interrupt();
        }
    };
    let completion = session
        .finish(code)
        .expect("foreground submission finished");
    let code = loop {
        executor.drive(256);
        drain(&terminal, &mut output, &session);
        drain(&diagnostics, &mut errors, &session);
        if completion.is_finished() {
            break completion.now_or_never().unwrap();
        }
        if !executor.drive(0).runnable {
            session.interrupt();
        }
    };
    let shutdown = session.shutdown();
    futures::pin_mut!(shutdown);
    while shutdown.as_mut().now_or_never().is_none() {
        executor.drive(256);
    }
    executor.drive(256);
    std::process::exit(code);
}

fn drain(endpoint: &Endpoint, output: &mut impl Write, session: &Session) {
    let mut buffer = [0; 8192];
    loop {
        let Some(result) = endpoint.read(&mut buffer).now_or_never() else {
            return;
        };
        let count = match result {
            Ok(0) => return,
            Ok(count) => count,
            Err(_) => {
                session.interrupt();
                return;
            }
        };
        if output
            .write_all(&buffer[..count])
            .and_then(|_| output.flush())
            .is_err()
        {
            session.interrupt();
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use shell_engine::{executor::Executor, io::IoError};

    #[test]
    fn read_only_mount_preserves_reads_and_rejects_all_mutating_opens() {
        let fs = MemoryFs::new(4096);
        fs.mkdir("/usr/local/bin", true).unwrap();
        fs.write_file("/usr/local/bin/tool", b"original").unwrap();
        let mounted = ReadOnlyMount::new(fs.clone(), "/usr");
        for options in [
            OpenOptions {
                write: true,
                ..OpenOptions::default()
            },
            OpenOptions {
                create: true,
                ..OpenOptions::default()
            },
            OpenOptions {
                write: true,
                truncate: true,
                ..OpenOptions::default()
            },
            OpenOptions {
                write: true,
                append: true,
                ..OpenOptions::default()
            },
        ] {
            for path in ["/usr/local/bin/tool", "/usr/local/bin/new"] {
                assert!(matches!(
                    mounted.open(path, &options).now_or_never(),
                    Some(Err(IoError::Runtime(69)))
                ));
            }
        }
        assert_eq!(fs.read_file("/usr/local/bin/tool").unwrap(), b"original");
        assert_eq!(fs.stat("/usr/local/bin/new", true), Err(IoError::NotFound));
        assert!(
            mounted
                .open("/usr/local/bin/tool", &OpenOptions::default())
                .now_or_never()
                .unwrap()
                .is_ok()
        );
        assert!(
            mounted
                .open_dir("/usr/local/bin")
                .now_or_never()
                .unwrap()
                .is_ok()
        );
        assert_eq!(
            mounted
                .stat("/usr/local/bin/tool", true)
                .now_or_never()
                .unwrap()
                .unwrap()
                .writable,
            Some(false)
        );
        assert_eq!(
            mounted.mkdir("/usr/local/bin", true).now_or_never(),
            Some(Ok(()))
        );
        assert_eq!(
            mounted.mkdir("/usr/local/bin/new", true).now_or_never(),
            Some(Err(IoError::Runtime(69)))
        );
        assert_eq!(
            mounted.mkdir("/usr-local/bin", true).now_or_never(),
            Some(Ok(()))
        );
        assert_eq!(mounted.mkdir("/tmp/bin", true).now_or_never(), Some(Ok(())));
        let write = OpenOptions {
            write: true,
            create: true,
            ..OpenOptions::default()
        };
        for path in ["/usr-local/bin/tool", "/tmp/bin/tool", "/home/guest/tool"] {
            assert!(
                mounted.open(path, &write).now_or_never().unwrap().is_ok(),
                "{path}"
            );
        }
    }

    #[test]
    fn mounted_metadata_preserves_traversal_and_classifies_resolved_paths() {
        let fs = MemoryFs::new(4096);
        fs.mkdir("/usr/bin", true).unwrap();
        fs.mkdir("/blocked", true).unwrap();
        fs.write_file("/blocked/tool", b"hidden").unwrap();
        fs.write_file("/usr/bin/tool", b"system").unwrap();
        let mounted =
            ReadOnlyMount::new(fs, "/usr").with_denied_directories(vec!["/blocked".into()]);
        for path in ["/usr/bin", "//usr/bin", "/./usr/bin", "/tmp/../usr/bin"] {
            let metadata = mounted.stat(path, true).now_or_never().unwrap().unwrap();
            assert_eq!(metadata.writable, Some(false), "{path}");
        }
        for path in ["/tmp", "/usr/../tmp"] {
            let metadata = mounted.stat(path, true).now_or_never().unwrap().unwrap();
            assert_eq!(metadata.writable, Some(true), "{path}");
        }
        for path in ["/blocked/tool", "//blocked/tool", "/blocked/../usr/bin"] {
            assert_eq!(
                mounted.stat(path, true).now_or_never(),
                Some(Err(IoError::Runtime(2))),
                "{path}"
            );
        }
        assert_eq!(
            mounted.stat("/missing/../usr/bin", true).now_or_never(),
            Some(Err(IoError::NotFound))
        );
        assert_eq!(
            mounted.stat("/usr/bin/tool/../tool", true).now_or_never(),
            Some(Err(IoError::NotDirectory))
        );
    }

    fn file(path: &str) -> serde_json::Value {
        json!({"path": path, "kind": "file", "mode": 384})
    }
    fn parse_nodes(nodes: serde_json::Value) -> Result<FixtureManifest, String> {
        parse_manifest(&json!({"schema": 1, "nodes": nodes}).to_string())
    }

    #[test]
    fn manifest_rejects_invalid_late_nodes_without_mutation() {
        let invalid = [
            json!(null),
            json!({}),
            json!({"path": "bad", "kind": "link", "mode": 493}),
            json!({"path": "bad", "kind": "file", "mode": 512}),
            json!({"path": "bad", "kind": "file", "mode": -1}),
            json!({"path": "bad", "kind": "file", "mode": 1.5}),
            json!({"path": "bad", "kind": "file", "mode": 493, "extra": true}),
            json!({"path": "bad", "kind": "file", "mode": 493, "marker": "ok"}),
            json!({"path": "bad", "kind": "file", "mode": 493, "status": 7}),
            json!({"path": "bad", "kind": "file", "mode": 493, "marker": null, "status": null}),
            json!({"path": "bad", "kind": "file", "mode": 493, "marker": "ok", "status": 0}),
            json!({"path": "bad", "kind": "file", "mode": 493, "marker": "ok", "status": 256}),
            json!({"path": "bad", "kind": "file", "mode": 493, "marker": "bad\nmarker", "status": 7}),
            json!({"path": "bad", "kind": "directory", "mode": 493, "marker": "ok", "status": 7}),
            json!({"path": "bad", "kind": "file", "mode": 493, "marker": "x".repeat(MAX_MARKER_BYTES + 1), "status": 7}),
        ];
        let paths = [
            "",
            "/absolute",
            "../escape",
            "a/../b",
            "a//b",
            "a/./b",
            "trailing/",
            "nul\0",
            "line\n",
            "first",
            "first/child",
            "missing/child",
        ];
        for node in invalid.into_iter().chain(paths.into_iter().map(file)) {
            let executor = Executor::new();
            let host = InProcessHost::new(executor);
            let fs = MemoryFs::new(4096);
            fs.mkdir("/fixture", true).unwrap();
            let raw = json!({"schema": 1, "nodes": [file("first"), node]}).to_string();
            assert!(
                register_fixture(&host, &fs, "/fixture", &raw).is_err(),
                "{raw}"
            );
            assert_eq!(fs.stat("/fixture/first", true), Err(IoError::NotFound));
            assert_eq!(fs.used_bytes(), 0);
        }
    }

    #[test]
    fn manifest_derives_traversal_capabilities_before_parent_reduction() {
        use shell_engine::process::{ProcessError, ProcessHost};
        let host = InProcessHost::new(Executor::new());
        let fs = MemoryFs::new(4096);
        fs.mkdir("/fixture", true).unwrap();
        let raw = json!({"schema": 1, "nodes": [
            {"path": "bin", "kind": "directory", "mode": 493},
            {"path": "empty", "kind": "directory", "mode": 493},
            {"path": "denied", "kind": "directory", "mode": 0},
            file("plain"),
            {"path": "bin/probe", "kind": "file", "mode": 493}
        ]})
        .to_string();
        register_fixture(&host, &fs, "/fixture", &raw).unwrap();
        for (path, expected) in [
            ("empty/../bin/probe", Ok(())),
            ("plain/../bin/probe", Err(ProcessError::Runtime(54))),
            ("denied/../bin/probe", Err(ProcessError::Runtime(44))),
            ("missing/../bin/probe", Err(ProcessError::Runtime(44))),
        ] {
            assert_eq!(
                host.access(path.into(), "/fixture".into())
                    .now_or_never()
                    .unwrap(),
                expected,
                "{path}"
            );
        }
    }

    #[test]
    fn manifest_enforces_wire_bounds_and_exact_schema() {
        let empty = r#"{"schema":1,"nodes":[]}"#;
        let padded = format!("{empty}{}", " ".repeat(MAX_MANIFEST_BYTES - empty.len()));
        assert!(parse_manifest(&padded).is_ok());
        assert!(
            parse_manifest(&(padded + " "))
                .unwrap_err()
                .contains("oversized")
        );
        assert!(
            parse_manifest(&(" ".repeat(MAX_MANIFEST_BYTES) + "not JSON"))
                .unwrap_err()
                .contains("oversized")
        );
        let mut nodes: Vec<_> = (0..MAX_NODES)
            .map(|index| file(&format!("file-{index}")))
            .collect();
        assert!(parse_nodes(json!(nodes)).is_ok());
        nodes.push(file("overflow"));
        assert!(parse_nodes(json!(nodes)).is_err());
        assert!(parse_nodes(json!([file(&"x".repeat(MAX_PATH_BYTES))])).is_ok());
        assert!(parse_nodes(json!([file(&"x".repeat(MAX_PATH_BYTES + 1))])).is_err());
        assert!(parse_nodes(json!([file(&"é".repeat(MAX_PATH_BYTES / 2 + 1))])).is_err());
        assert!(parse_nodes(json!([{"path": "max", "kind": "file", "mode": 511, "marker": "x".repeat(MAX_MARKER_BYTES), "status": 255}])).is_ok());
        for raw in [
            "null",
            "[]",
            "{}",
            r#"{"schema":2,"nodes":[]}"#,
            r#"{"schema":1,"nodes":[],"extra":1}"#,
            r#"{"schema":1,"nodes":{}}"#,
            r#"{"schema":1,"schema":1,"nodes":[]}"#,
        ] {
            assert!(parse_manifest(raw).is_err(), "{raw}");
        }
        assert!(
            parse_nodes(
                json!([{"path": "dir", "kind": "directory", "mode": 0}, file("dir/child")])
            )
            .is_ok()
        );
    }
}
