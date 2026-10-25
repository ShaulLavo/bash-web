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
            cancelled_scope(body, &scope);
        }
    }
}

fn cancelled_scope(body: &str, scope: &str) {
    let rig = Rig::new(None);
    assert_eq!(rig.run("exec 3>old; exec 2>&1"), 0);
    let job = rig.shell.start(scope).unwrap();
    rig.until_ready();
    rig.shell.interrupt();
    assert_eq!(rig.finish(job), 130, "{scope}");
    let status = rig.run("printf X >&3; result=$?; printf restored; test \"$result\" = 0");
    assert_eq!(status, i32::from(body == "exec 3>&-"), "{scope}");
    assert!(rig.output.bytes().ends_with(b"restored"), "{scope}");
    let changed = match body {
        "exec 3>out" => Some("/home/guest/out"),
        "exec 3>new" => Some("/home/guest/new"),
        _ => None,
    };
    if let Some(path) = changed {
        assert_eq!(rig.fs.read_file(path).unwrap(), b"X", "{scope}");
    }
    assert_eq!(rig.fs.read_file("/home/guest/old").unwrap(), b"", "{scope}");
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

#[test]
fn issue_108_exact_reproducer() {
    let rig = Rig::new(None);
    assert_eq!(rig.run("f() { exec 3>out; }; f; printf X >&3; result=$?; printf '<%s:%s>' \"$result\" \"$(<out)\""), 0);
    assert_eq!(rig.output.bytes(), b"<0:X>");
}

#[test]
fn process_substitution_numbers_close_but_explicit_aliases_survive() {
    for body in [
        "g() { exec 63>out; exec 4>&63; }; g < <(printf data)",
        "for path in <(printf data); do exec 63>out; exec 4>&63; done",
        "{ exec 63>out; exec 4>&63; } < <(printf data)",
    ] {
        let rig = Rig::new(None);
        assert_eq!(rig.run(&format!("f() {{ {body}; }}; f; printf leaked >&63; result=$?; printf kept >&4; test \"$result\" = 1")), 0, "{body}");
        assert_eq!(rig.fs.read_file("/home/guest/out").unwrap(), b"kept");
    }
}

#[test]
fn caller_pipe_aliases_keep_endpoint_alive_until_the_last_binding_closes() {
    let (reader, writer) = pipe();
    let rig = Rig::new(Some((3, writer)));
    assert_eq!(rig.run("f() { exec 4>&3; exec 3>&-; }; f; printf X >&4"), 0);
    let probe = rig.executor.spawn(async move {
        let mut byte = [0];
        assert_eq!(reader.read(&mut byte).await, Ok(1));
        assert_eq!(byte, *b"X");
        reader.read(&mut byte).await
    });
    rig.executor.drive(256);
    assert!(!probe.is_finished());
    assert_eq!(rig.run("eval 'exec 4>&-'"), 0);
    rig.executor.drive(256);
    assert_eq!(probe.now_or_never().unwrap(), Ok(0));
}

#[test]
fn failed_exec_preparation_does_not_publish_partial_bindings() {
    for scope in caller_scopes("exec 3>new 4>&99") {
        let rig = Rig::new(None);
        assert_eq!(
            rig.run(&format!("exec 3>old; {scope}; printf X >&3; printf Y >&4")),
            1
        );
        assert_eq!(rig.fs.read_file("/home/guest/old").unwrap(), b"X");
        assert_eq!(rig.fs.read_file("/home/guest/new").unwrap(), b"");
    }
}

#[test]
fn wrappers_and_high_descriptor_numbers_keep_caller_ownership() {
    let rig = Rig::new(None);
    assert_eq!(rig.run("command eval 'exec 123>out'; builtin eval 'exec 124>&123'; printf A >&123; printf B >&124"), 0);
    assert_eq!(rig.fs.read_file("/home/guest/out").unwrap(), b"AB");
}

#[test]
fn cancelled_nested_stdout_change_restores_temporary_outer_stdout() {
    let rig = Rig::new(None);
    let job = rig
        .shell
        .start("f() { exec 1>inner; exec 3>out; printf ready >&2; while :; do :; done; }; f >outer")
        .unwrap();
    for _ in 0..10000 {
        rig.executor.drive(64);
        if rig.errors.bytes() == b"ready" {
            break;
        }
    }
    assert_eq!(rig.errors.bytes(), b"ready");
    rig.shell.interrupt();
    assert_eq!(rig.finish(job), 130);
    assert_eq!(rig.run("printf restored; printf X >&3"), 0);
    assert_eq!(rig.output.bytes(), b"restored");
    assert_eq!(rig.fs.read_file("/home/guest/out").unwrap(), b"X");
    assert_eq!(rig.fs.read_file("/home/guest/inner").unwrap(), b"");
}

#[test]
fn caller_close_releases_pipe_endpoints_before_the_scope_is_cancelled() {
    for close_writer in [true, false] {
        for scope in caller_scopes("exec 3>&-; printf ready >&2; while :; do :; done") {
            active_pipe_close(close_writer, &scope);
        }
    }
}

fn active_pipe_close(close_writer: bool, scope: &str) {
    let (reader, writer) = pipe();
    let (binding, observer) = if close_writer {
        (writer, reader)
    } else {
        (reader, writer)
    };
    let rig = Rig::new(Some((3, binding)));
    assert_eq!(rig.run("exec 2>&1"), 0);
    let job = rig.shell.start(scope).unwrap();
    rig.until_ready();
    let probe = rig.executor.spawn(async move {
        if close_writer {
            return observer.read(&mut [0]).await == Ok(0);
        }
        observer.write_all(b"x", &Cancel::new()).await == Err(IoError::BrokenPipe)
    });
    rig.executor.drive(256);
    assert!(
        probe.is_finished(),
        "endpoint retained by active scope: {scope}"
    );
    assert!(probe.now_or_never().unwrap());
    assert!(!job.is_finished());
    rig.shell.interrupt();
    assert_eq!(rig.finish(job), 130);
    assert_eq!(rig.run("printf X >&3"), 1);
}

#[test]
fn exec_generated_replacement_stays_command_local() {
    let rig = Rig::new(None);
    assert_eq!(rig.run(r#"f() { exec < <(printf data) 63>out; }; f; printf leaked >&63; result=$?; printf "<%s:%s>" "$result" "$(<out)""#), 0);
    assert_eq!(String::from_utf8(rig.output.bytes()).unwrap(), "<1:>");
    assert_eq!(rig.fs.read_file("/home/guest/out").unwrap(), b"");
}

#[test]
fn exec_generated_alias_retains_data_after_the_number_is_replaced() {
    for redirects in ["4>&63", "4>&63 63>out"] {
        let rig = Rig::new(None);
        assert_eq!(rig.run(&format!("f() {{ exec < <(printf data) {redirects}; }}; f; read -rN4 -u4 data; printf '<%s:%s>' \"$?\" \"$data\"; exec 0<&- 4<&-; wait")), 0);
        assert_eq!(rig.output.bytes(), b"<0:data>", "{redirects}");
    }
}

#[test]
fn ordinary_explicit_high_descriptors_are_not_generated_numbers() {
    for source in [
        "f() { exec 63>out; }; f",
        "f() { exec 63>out < <(printf data); }; f",
        "exec 63>old; f() { exec < <(printf data) 63>out; }; f",
    ] {
        let rig = Rig::new(None);
        assert_eq!(
            rig.run(&format!(
                "{source}; printf kept >&63; exec 0<&- 63>&-; wait"
            )),
            0,
            "{source}"
        );
        assert_eq!(
            rig.fs.read_file("/home/guest/out").unwrap(),
            b"kept",
            "{source}"
        );
    }
}

#[test]
fn cancelled_exec_scope_keeps_aliases_but_not_generated_replacements() {
    let rig = Rig::new(None);
    assert_eq!(rig.run("exec 2>&1"), 0);
    let job = rig.shell.start("f() { exec < <(printf data) 4>&63 63>out; wait; printf ready >&2; while :; do :; done; }; f").unwrap();
    rig.until_ready();
    rig.shell.interrupt();
    assert_eq!(rig.finish(job), 130);
    assert_eq!(rig.run("printf leaked >&63; result=$?; read -rN4 -u4 data; printf '<%s:%s>' \"$result\" \"$data\"; exec 0<&- 4<&-; wait"), 0);
    assert!(rig.output.bytes().ends_with(b"<1:data>"));
    assert_eq!(rig.fs.read_file("/home/guest/out").unwrap(), b"");
    assert_eq!(rig.executor.drive(256).pending, 0);
}

#[test]
fn cancelled_exec_preparation_releases_generated_jobs_without_publication() {
    let rig = Rig::new(None);
    assert_eq!(rig.run("exec 2>&1; exec 4>kept"), 0);
    let job = rig.shell.start("f() { exec < <(while :; do :; done) 4>&63 63>$(printf ready >&2; while :; do :; done); }; f").unwrap();
    rig.until_ready();
    rig.shell.interrupt();
    assert_eq!(rig.finish(job), 130);
    assert_eq!(
        rig.run(
            "printf kept >&4; printf leaked >&63; result=$?; exec 4>&-; wait; test \"$result\" = 1"
        ),
        0
    );
    assert_eq!(rig.fs.read_file("/home/guest/kept").unwrap(), b"kept");
    assert_eq!(rig.executor.drive(256).pending, 0);
}
