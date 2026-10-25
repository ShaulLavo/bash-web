use futures::FutureExt;
use shell_engine::{
    Limits, Session,
    executor::{Cancel, Executor, JoinHandle},
    io::{Capture, Endpoint, FdTable, IoError, MemoryFs, capture, pipe},
    process::InProcessHost,
};
use std::rc::Rc;

struct Rig {
    executor: Executor,
    shell: Session,
    fs: MemoryFs,
    output: Capture,
    errors: Capture,
}

impl Rig {
    fn new(extra: Option<(u32, Endpoint)>) -> Self {
        let executor = Executor::new();
        let host = InProcessHost::new(executor.clone());
        let fs = MemoryFs::new(64 * 1024);
        let shell = Session::new(
            executor.clone(),
            Rc::new(host),
            Rc::new(fs.clone()),
            Limits::default(),
        );
        let (out, output) = capture(64 * 1024);
        let (err, errors) = capture(64 * 1024);
        let mut fds = FdTable::default();
        fds.insert(0, Endpoint::bytes(b"caller\n".to_vec()));
        fds.insert(1, out);
        fds.insert(2, err);
        if let Some((fd, endpoint)) = extra {
            fds.insert(fd, endpoint);
        }
        shell.set_descriptors(fds).unwrap();
        Self {
            executor,
            shell,
            fs,
            output,
            errors,
        }
    }

    fn finish(&self, job: JoinHandle<i32>) -> i32 {
        for _ in 0..10000 {
            self.executor.drive(256);
            if job.is_finished() {
                return job.now_or_never().unwrap();
            }
        }
        panic!("job did not finish: {:?}", self.errors.bytes());
    }

    fn run(&self, source: &str) -> i32 {
        self.finish(self.shell.start(source).unwrap())
    }

    fn until_ready(&self) {
        for _ in 0..10000 {
            self.executor.drive(64);
            if self.output.bytes() == b"ready" {
                return;
            }
        }
        panic!("missing ready: {:?}", self.errors.bytes());
    }
}

impl Drop for Rig {
    fn drop(&mut self) {
        let shutdown = self.shell.shutdown();
        futures::pin_mut!(shutdown);
        for _ in 0..10000 {
            self.executor.drive(256);
            if shutdown.as_mut().now_or_never().is_some() {
                return;
            }
        }
        panic!("shutdown did not finish");
    }
}

fn caller_scopes(body: &str) -> Vec<String> {
    vec![
        format!("f() {{ {body}; }}; f"),
        format!("eval '{body}'"),
        format!("printf '%s' '{body}' > script; source ./script"),
        format!("{{ {body}; }} > surrounding"),
        format!("shopt -s lastpipe; printf input | {{ {body}; }}"),
        format!("f() {{ eval '{body}'; }}; f > surrounding"),
    ]
}

#[test]
fn caller_scopes_preserve_open_close_and_replace() {
    for scope in caller_scopes("exec 3>out") {
        let rig = Rig::new(None);
        assert_eq!(rig.run(&format!("{scope}; printf X >&3")), 0, "{scope}");
        assert_eq!(
            rig.fs.read_file("/home/guest/out").unwrap(),
            b"X",
            "{scope}"
        );
    }
    for scope in caller_scopes("exec 3>&-") {
        let rig = Rig::new(None);
        assert_eq!(
            rig.run(&format!("exec 3>out; {scope}; printf X >&3")),
            1,
            "{scope}"
        );
        assert_eq!(rig.fs.read_file("/home/guest/out").unwrap(), b"", "{scope}");
    }
    for scope in caller_scopes("exec 3>new") {
        let rig = Rig::new(None);
        assert_eq!(
            rig.run(&format!("exec 3>old; {scope}; printf X >&3")),
            0,
            "{scope}"
        );
        assert_eq!(
            rig.fs.read_file("/home/guest/new").unwrap(),
            b"X",
            "{scope}"
        );
        assert_eq!(rig.fs.read_file("/home/guest/old").unwrap(), b"", "{scope}");
    }
}

#[test]
fn surrounding_bindings_restore_but_nested_body_sees_exec_changes() {
    let rig = Rig::new(None);
    assert_eq!(
        rig.run("f() { exec 1>inner; printf I; exec 3>out; }; f >outer; printf O; printf X >&3"),
        0
    );
    assert_eq!(rig.output.bytes(), b"O");
    assert_eq!(rig.fs.read_file("/home/guest/inner").unwrap(), b"I");
    assert_eq!(rig.fs.read_file("/home/guest/outer").unwrap(), b"");
    assert_eq!(rig.fs.read_file("/home/guest/out").unwrap(), b"X");
    assert_eq!(
        rig.run("exec 3>old; { exec 3>new; exec 4>&3; } 3>temporary; printf A >&3; printf B >&4"),
        0
    );
    assert_eq!(rig.fs.read_file("/home/guest/old").unwrap(), b"A");
    assert_eq!(rig.fs.read_file("/home/guest/new").unwrap(), b"B");
}

#[test]
fn lastpipe_restores_only_pipeline_stdin() {
    let rig = Rig::new(None);
    assert_eq!(rig.run("printf 'inner\n' >input; shopt -s lastpipe; printf pipe | { exec 0<input; read a; exec 3>out; }; read b; printf '%s:%s' \"$a\" \"$b\"; printf X >&3"), 0);
    assert_eq!(rig.output.bytes(), b"inner:caller");
    assert_eq!(rig.fs.read_file("/home/guest/out").unwrap(), b"X");
}

#[test]
fn isolated_scopes_do_not_publish_descriptor_edits() {
    for scope in [
        "(exec 3>&-)",
        "true | { exec 3>&-; }",
        "x=$(exec 3>&-)",
        "{ exec 3>&-; } & wait",
    ] {
        let rig = Rig::new(None);
        assert_eq!(
            rig.run(&format!("exec 3>out; {scope}; printf X >&3")),
            0,
            "{scope}"
        );
        assert_eq!(rig.fs.read_file("/home/guest/out").unwrap(), b"X");
    }
}

#[test]
fn aliases_keep_shared_offsets_after_caller_scope_replacement() {
    for scope in caller_scopes("exec 4>&3; exec 3>new") {
        let rig = Rig::new(None);
        assert_eq!(rig.run(&format!("exec 3>old; exec 5>&3; printf A >&3; {scope}; printf B >&4; printf C >&5; printf D >&3")), 0, "{scope}");
        assert_eq!(rig.fs.read_file("/home/guest/old").unwrap(), b"ABC");
        assert_eq!(rig.fs.read_file("/home/guest/new").unwrap(), b"D");
    }
    let rig = Rig::new(None);
    assert_eq!(rig.run("printf abc >input; exec 3<input; f() { exec 4<&3; }; f; read -rN1 -u3 a; read -rN1 -u4 b; read -rN1 -u3 c; printf '%s%s%s' \"$a\" \"$b\" \"$c\""), 0);
    assert_eq!(rig.output.bytes(), b"abc");
}

#[test]
fn cancellation_keeps_completed_exec_and_restores_surrounding_bindings() {
    for body in ["exec 3>out", "exec 3>&-", "exec 3>new"] {
        for scope in caller_scopes(&format!("{body}; printf ready >&2; while :; do :; done")) {
            let rig = Rig::new(None);
            assert_eq!(rig.run("exec 3>old; exec 2>&1"), 0);
            let job = rig.shell.start(&scope).unwrap();
            rig.until_ready();
            rig.shell.interrupt();
            assert_eq!(rig.finish(job), 130, "{scope}");
            let status = rig.run("printf X >&3; result=$?; printf restored; test \"$result\" = 0");
            assert_eq!(status, i32::from(body == "exec 3>&-"), "{scope}");
            assert!(rig.output.bytes().ends_with(b"restored"), "{scope}");
        }
    }
}

#[test]
fn caller_close_releases_live_pipe_writer_and_reader() {
    for scope in caller_scopes("exec 3>&-") {
        let (reader, writer) = pipe();
        let rig = Rig::new(Some((3, writer)));
        assert_eq!(rig.run(&scope), 0, "{scope}");
        let probe = rig
            .executor
            .spawn(async move { reader.read(&mut [0]).await });
        rig.executor.drive(256);
        assert!(probe.is_finished(), "writer leaked: {scope}");
        assert_eq!(probe.now_or_never().unwrap(), Ok(0));
    }
    for scope in caller_scopes("exec 3<&-") {
        let (reader, writer) = pipe();
        let rig = Rig::new(Some((3, reader)));
        assert_eq!(rig.run(&scope), 0, "{scope}");
        let probe = rig
            .executor
            .spawn(async move { writer.write_all(b"x", &Cancel::new()).await });
        rig.executor.drive(256);
        assert!(probe.is_finished(), "reader leaked: {scope}");
        assert_eq!(probe.now_or_never().unwrap(), Err(IoError::BrokenPipe));
    }
}
