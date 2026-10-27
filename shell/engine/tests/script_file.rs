use futures::{FutureExt, future::LocalBoxFuture};
use shell_engine::{
    Limits, Session,
    executor::{Executor, JoinHandle},
    io::{
        self, Capture, DescriptorKind, Endpoint, FileSystem, HostEndpoint, IoError, MemoryFs,
        OpenOptions,
    },
    process::InProcessHost,
};
use std::{cell::Cell, rc::Rc};

#[derive(Clone, Copy)]
enum Fault {
    None,
    Open,
    Read,
    PendingOpen,
    PendingRead,
}
struct Fs {
    inner: MemoryFs,
    fault: Fault,
    opens: Cell<usize>,
    closed: Rc<Cell<usize>>,
}
impl FileSystem for Fs {
    fn mkdir<'a>(
        &'a self,
        path: &'a str,
        parents: bool,
    ) -> LocalBoxFuture<'a, Result<(), IoError>> {
        async move { self.inner.mkdir(path, parents) }.boxed_local()
    }
    fn open<'a>(
        &'a self,
        path: &'a str,
        options: &'a OpenOptions,
    ) -> LocalBoxFuture<'a, Result<Endpoint, IoError>> {
        self.opens.set(self.opens.get() + 1);
        match self.fault {
            Fault::None => FileSystem::open(&self.inner, path, options),
            Fault::Open => async { Err(IoError::Runtime(2)) }.boxed_local(),
            Fault::PendingOpen => futures::future::pending().boxed_local(),
            Fault::Read | Fault::PendingRead => {
                let endpoint = Endpoint::host(Rc::new(Input {
                    fault: self.fault,
                    closed: self.closed.clone(),
                }));
                async { Ok(endpoint) }.boxed_local()
            }
        }
    }
}
struct Input {
    fault: Fault,
    closed: Rc<Cell<usize>>,
}
impl Drop for Input {
    fn drop(&mut self) {
        self.closed.set(self.closed.get() + 1);
    }
}
impl HostEndpoint for Input {
    fn runtime_fd(&self) -> Option<u32> {
        None
    }
    fn descriptor_kind(&self) -> Result<DescriptorKind, IoError> {
        Ok(DescriptorKind::Regular)
    }
    fn read<'a>(&'a self, _: &'a mut [u8]) -> LocalBoxFuture<'a, Result<usize, IoError>> {
        if matches!(self.fault, Fault::PendingRead) {
            return futures::future::pending().boxed_local();
        }
        async { Err(IoError::Runtime(29)) }.boxed_local()
    }
    fn write<'a>(&'a self, _: &'a [u8]) -> LocalBoxFuture<'a, Result<usize, IoError>> {
        async { Err(IoError::BadDescriptor) }.boxed_local()
    }
}
struct Shell {
    executor: Executor,
    session: Rc<Session>,
    fs: Rc<Fs>,
    out: Capture,
    err: Capture,
}
impl Shell {
    fn new(limits: Limits, fault: Fault) -> Self {
        let executor = Executor::new();
        let fs = Rc::new(Fs {
            inner: MemoryFs::new(1024 * 1024),
            fault,
            opens: Cell::new(0),
            closed: Rc::new(Cell::new(0)),
        });
        fs.inner.mkdir("/home/guest", true).unwrap();
        let session = Rc::new(Session::new(
            executor.clone(),
            Rc::new(InProcessHost::new(executor.clone())),
            fs.clone(),
            limits,
        ));
        let (stdout, out) = io::capture(65536);
        let (stderr, err) = io::capture(65536);
        let mut fds = io::FdTable::default();
        for (fd, endpoint) in [(0, Endpoint::null()), (1, stdout), (2, stderr)] {
            fds.insert(fd, endpoint);
        }
        session.set_descriptors(fds).unwrap();
        Self {
            executor,
            session,
            fs,
            out,
            err,
        }
    }
    fn finish(&self, job: JoinHandle<i32>) -> i32 {
        for _ in 0..100_000 {
            if job.is_finished() {
                return job.now_or_never().unwrap();
            }
            self.executor.drive(64);
        }
        panic!("file job exceeded bounded turns");
    }
    fn run(&self, name: &str, args: Vec<String>) -> i32 {
        self.finish(self.session.start_file(name.into(), args).unwrap())
    }
}
impl Drop for Shell {
    fn drop(&mut self) {
        let session = self.session.clone();
        let shutdown = self.executor.spawn(async move { session.shutdown().await });
        self.executor.drive(4096);
        if !std::thread::panicking() {
            assert!(shutdown.is_finished());
            assert_eq!(self.executor.drive(64).pending, 0);
        }
    }
}
#[test]
fn file_path_arguments_cwd_and_exit_are_literal() {
    for name in ["run name;'$.sh", "/home/guest/run name;'$.sh"] {
        let shell = Shell::new(Limits::default(), Fault::None);
        shell
            .fs
            .inner
            .write_file(
                "/home/guest/run name;'$.sh",
                b"printf '<%s>\\n' \"$0\" \"$#\" \"$1\" \"$@\"; pwd; exit 37",
            )
            .unwrap();
        assert_eq!(
            shell.run(name, vec!["".into(), "two words".into(), "$x*;".into()]),
            37
        );
        assert_eq!(
            shell.out.bytes(),
            format!("<{name}>\n<3>\n<>\n<>\n<two words>\n<$x*;>\n/home/guest\n").as_bytes()
        );
        assert!(shell.err.bytes().is_empty());
    }
}
#[test]
fn file_syntax_diagnostic_has_filename_and_line_and_keeps_prior_commands() {
    let shell = Shell::new(Limits::default(), Fault::None);
    shell
        .fs
        .inner
        .write_file("/home/guest/bad", b"echo before\nif ; then\n")
        .unwrap();
    assert_eq!(shell.run("bad", Vec::new()), 2);
    assert_eq!(shell.out.bytes(), b"before\n");
    let diagnostic = String::from_utf8(shell.err.bytes()).unwrap();
    assert!(diagnostic.contains("bad: line 2:"), "{diagnostic}");
}
#[test]
fn file_bytes_utf8_and_storage_are_bounded_before_execution() {
    for (text, status, message) in [
        (b":   ".as_slice(), 0, ""),
        (b":    ".as_slice(), 2, "shell source limit exceeded"),
        (b"\xff".as_slice(), 2, "invalid UTF-8"),
    ] {
        let shell = Shell::new(
            Limits {
                source_bytes: 4,
                ..Limits::default()
            },
            Fault::None,
        );
        shell.fs.inner.write_file("/home/guest/file", text).unwrap();
        assert_eq!(shell.run("file", Vec::new()), status);
        let error = String::from_utf8(shell.err.bytes()).unwrap();
        assert!(error.contains(message), "{error}");
    }
    let shell = Shell::new(
        Limits {
            expansion_bytes: 4096,
            ..Limits::default()
        },
        Fault::None,
    );
    shell
        .fs
        .inner
        .write_file("/home/guest/file", b"echo BAD")
        .unwrap();
    assert_eq!(shell.run("file", Vec::new()), 2);
    assert!(shell.out.bytes().is_empty());
    assert!(
        String::from_utf8(shell.err.bytes())
            .unwrap()
            .contains("storage limit")
    );
}
#[test]
fn file_open_directory_and_read_failures_keep_status_and_name() {
    for (name, fault, status) in [
        ("missing", Fault::None, 127),
        ("", Fault::None, 127),
        (".", Fault::None, 126),
        ("denied", Fault::Open, 126),
        ("broken", Fault::Read, 126),
    ] {
        let shell = Shell::new(Limits::default(), fault);
        assert_eq!(shell.run(name, Vec::new()), status);
        assert!(shell.out.bytes().is_empty());
        assert!(
            String::from_utf8(shell.err.bytes())
                .unwrap()
                .starts_with(&format!("{name}: "))
        );
        if matches!(fault, Fault::Read) {
            assert_eq!(shell.fs.closed.get(), 1);
        }
    }
}
#[test]
fn file_loading_can_be_interrupted_during_open_or_read() {
    for fault in [Fault::PendingOpen, Fault::PendingRead] {
        let shell = Shell::new(Limits::default(), fault);
        let job = shell
            .session
            .start_file("waiting".into(), Vec::new())
            .unwrap();
        shell.executor.drive(64);
        assert_eq!(shell.fs.opens.get(), 1);
        assert!(!job.is_finished());
        assert!(
            shell
                .session
                .start_file("other".into(), Vec::new())
                .is_err()
        );
        shell.session.interrupt();
        assert_eq!(shell.finish(job), 130);
        assert!(shell.err.bytes().is_empty());
        if matches!(fault, Fault::PendingRead) {
            assert_eq!(shell.fs.closed.get(), 1);
        }
    }
}
#[test]
fn file_argument_admission_is_atomic_before_open() {
    let shell = Shell::new(
        Limits {
            execution_bytes: 1024,
            ..Limits::default()
        },
        Fault::None,
    );
    shell
        .session
        .set_arguments("saved".into(), vec!["tail".into()])
        .unwrap();
    let error = shell
        .session
        .start_file("x".repeat(8192), Vec::new())
        .err()
        .expect("oversized invocation must be refused");
    assert_eq!(error.status(), 2);
    assert_eq!(shell.session.state().borrow().shell_name, "saved");
    assert_eq!(shell.fs.opens.get(), 0);
}

#[test]
fn file_reader_refunds_failed_loads_and_preserves_stored_file_identity() {
    let shell = Shell::new(
        Limits {
            source_bytes: 64 * 1024,
            ..Limits::default()
        },
        Fault::None,
    );
    shell
        .fs
        .inner
        .write_file("/home/guest/large", &vec![b' '; 64 * 1024 + 1])
        .unwrap();
    assert_eq!(shell.run("large", Vec::new()), 2);
    shell
        .fs
        .inner
        .write_file(
            "/home/guest/library",
            b"f() {\n printf '<%s>\\n' \"${BASH_SOURCE[0]}\";\n}\n",
        )
        .unwrap();
    assert_eq!(shell.run("library", Vec::new()), 0);
    assert_eq!(
        shell.finish(shell.session.start("f").unwrap()),
        0,
        "{}",
        String::from_utf8_lossy(&shell.err.bytes())
    );
    assert_eq!(shell.out.bytes(), b"<library>\n");
}

#[test]
fn file_execution_diagnostic_keeps_filename_line_and_status() {
    let shell = Shell::new(Limits::default(), Fault::None);
    shell
        .fs
        .inner
        .write_file("/home/guest/failure", b"\nmissing-script-command\n")
        .unwrap();
    assert_eq!(shell.run("failure", Vec::new()), 127);
    let error = String::from_utf8(shell.err.bytes()).unwrap();
    assert!(error.contains("failure: line 2:"), "{error}");
}

#[test]
fn file_entry_is_noninteractive_root_execution_not_a_source_frame() {
    let shell = Shell::new(Limits::default(), Fault::None);
    {
        let state = shell.session.state();
        let mut state = state.borrow_mut();
        state.interactive = true;
        state.command_string = true;
    }
    shell
        .fs
        .inner
        .write_file("/home/guest/root", b"printf '%s\\n' \"$-\"; return 9")
        .unwrap();
    assert_eq!(shell.run("root", Vec::new()), 2);
    let flags = String::from_utf8(shell.out.bytes()).unwrap();
    assert!(!flags.contains('c') && !flags.contains('i'), "{flags}");
}
