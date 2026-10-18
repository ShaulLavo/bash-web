//! Original compiled-capability contracts. No system utilities or browser stand-ins.
use futures::FutureExt;
use shell_engine::{
    Limits, Session,
    executor::Executor,
    io::{Capture, Endpoint, FdTable, MemoryFs, capture},
    process::InProcessHost,
};
#[cfg(not(feature = "acceptance-utilities"))]
use std::cell::RefCell;
use std::rc::Rc;

struct Rig {
    executor: Executor,
    session: Session,
    host: InProcessHost,
    output: Capture,
    errors: Capture,
}
impl Rig {
    fn new() -> Self {
        let executor = Executor::new();
        let host = InProcessHost::new(executor.clone());
        let session = Session::new(
            executor.clone(),
            Rc::new(host.clone()),
            Rc::new(MemoryFs::new(65536)),
            Limits::default(),
        );
        session
            .state()
            .borrow_mut()
            .assign_parameter("PATH".into(), "/utilities".into())
            .unwrap();
        let (stdout, output) = capture(65536);
        let (stderr, errors) = capture(65536);
        let mut fds = FdTable::default();
        fds.insert(0, Endpoint::null());
        fds.insert(1, stdout);
        fds.insert(2, stderr);
        session.set_descriptors(fds).unwrap();
        Self {
            executor,
            session,
            host,
            output,
            errors,
        }
    }
    fn run(&self, source: &str) -> i32 {
        let job = self.session.start(source).unwrap();
        for _ in 0..100000 {
            if job.is_finished() {
                return job.now_or_never().unwrap();
            }
            let turn = self.executor.drive(64);
            assert!(
                turn.runnable || job.is_finished(),
                "parked capability control"
            );
        }
        panic!("capability control exceeded turn limit");
    }
}
impl Drop for Rig {
    fn drop(&mut self) {
        let shutdown = self.session.shutdown();
        futures::pin_mut!(shutdown);
        for _ in 0..1000 {
            self.executor.drive(64);
            if shutdown.as_mut().now_or_never().is_some() {
                assert_eq!(self.host.active_count(), 0);
                assert_eq!(self.host.retained_count(), 0);
                return;
            }
        }
        panic!("capability fixture did not shut down");
    }
}

#[test]
fn both_builds_keep_real_regex_syntax_and_shell_options_separate() {
    let rig = Rig::new();
    assert_eq!(rig.run(r#"set -u; shopt -s nullglob; v=abc123; [[ $v =~ ^[a-z]+[0-9]+$ ]]; printf '%s\n' "$?"; pattern='['; [[ x =~ $pattern ]]; printf '%s\n' "$?""#), 0);
    assert_eq!(rig.output.bytes(), b"0\n2\n");
}

#[test]
fn both_builds_keep_query_membership_distinct_from_internal_utility_dispatch() {
    let rig = Rig::new();
    for name in ["cat", "grep", "mkdir", "seq"] {
        assert_eq!(rig.run(&format!("command -v {name}")), 1);
    }
    assert!(rig.output.bytes().is_empty());
    assert!(rig.errors.bytes().is_empty());
}

#[cfg(feature = "acceptance-utilities")]
#[test]
fn full_retains_all_four_acceptance_standins() {
    let rig = Rig::new();
    assert_eq!(rig.run("mkdir directory; printf 'one\\ntwo\\n' > directory/input; cat directory/input | grep two; seq 2"), 0);
    assert_eq!(rig.output.bytes(), b"two\n1\n2\n");
    assert!(rig.errors.bytes().is_empty());
}

#[cfg(not(feature = "acceptance-utilities"))]
#[test]
fn lite_missing_utilities_are_127_not_placeholders_and_do_not_change_options() {
    let rig = Rig::new();
    for name in ["cat", "grep", "mkdir", "seq"] {
        assert_eq!(rig.run(&format!("set -u; shopt -s nullglob; {name}")), 127);
        assert_eq!(rig.run(&format!("command {name}")), 127);
    }
    let errors = String::from_utf8(rig.errors.bytes()).unwrap();
    assert_eq!(errors.matches("command not found").count(), 8);
    assert_eq!(
        errors
            .matches("bash-web Lite; omitted capability: acceptance-utilities")
            .count(),
        8
    );
    assert!(rig.output.bytes().is_empty());
}

#[cfg(not(feature = "acceptance-utilities"))]
#[test]
fn lite_uses_ordinary_external_resolution_prefixes_functions_and_queries() {
    let rig = Rig::new();
    let calls = Rc::new(RefCell::new(Vec::new()));
    for name in ["cat", "grep", "mkdir", "seq"] {
        let calls = calls.clone();
        rig.host
            .register(format!("/utilities/{name}"), move |request, _| {
                calls.borrow_mut().push((request.argv, request.env));
                futures::future::ready(23).boxed_local()
            });
        assert_eq!(rig.run(&format!("command -v {name}; command -V {name}")), 0);
        assert_eq!(rig.run(&format!("MARK=prefix {name} operand")), 23);
        assert_eq!(
            rig.run(&format!(
                "{name}() {{ printf function; }}; {name}; command {name} wrapped"
            )),
            23
        );
    }
    assert_eq!(calls.borrow().len(), 8);
    for call in calls.borrow().iter().step_by(2) {
        assert_eq!(call.0[1], "operand");
        assert!(
            call.1
                .iter()
                .any(|(key, value)| key == "MARK" && value == "prefix")
        );
    }
    assert!(rig.errors.bytes().is_empty());
    let output = String::from_utf8(rig.output.bytes()).unwrap();
    assert_eq!(output.matches("function").count(), 4);
    assert_eq!(output.matches(" is /utilities/").count(), 4);
}

#[cfg(not(feature = "acceptance-utilities"))]
#[test]
fn lite_external_utility_heredocs_keep_command_local_scope_and_function_errors() {
    for name in ["cat", "grep", "mkdir", "seq"] {
        let rig = Rig::new();
        rig.host
            .register(format!("/utilities/{name}"), |request, cancel| {
                copy_heredoc(request, cancel).boxed_local()
            });
        assert_eq!(
            rig.run(&format!(
                "unset x\n{name} <<EOF\n${{x:=reader}}:$x\nEOF\nprintf '<%s>\\n' \"${{x-unset}}\"\n"
            )),
            0
        );
        assert_eq!(rig.output.bytes(), b"reader:reader\n<unset>\n", "{name}");
        assert_eq!(
            rig.run(&format!(
                "set -u\n{name} <<EOF\n$missing\nEOF\nprintf 'continued:%s\\n' \"$?\"\n"
            )),
            0
        );
        assert!(rig.output.bytes().ends_with(b"continued:127\n"), "{name}");
        let before = rig.output.bytes();
        assert_eq!(
            rig.run(&format!(
                "{name}() {{ printf forbidden; }}\n{name} <<EOF\n$missing\nEOF\nprintf forbidden\n"
            )),
            127
        );
        assert_eq!(rig.output.bytes(), before, "{name}");
        let errors = String::from_utf8(rig.errors.bytes()).unwrap();
        assert_eq!(
            errors.matches("missing: unbound variable").count(),
            2,
            "{name}"
        );
        assert!(!errors.contains("omitted capability"));
    }
}

#[cfg(not(feature = "acceptance-utilities"))]
async fn copy_heredoc(
    request: shell_engine::process::SpawnRequest,
    cancel: shell_engine::executor::Cancel,
) -> i32 {
    let input = request.fds.get(0).unwrap();
    let output = request.fds.get(1).unwrap();
    let mut byte = [0];
    loop {
        let count = input.read_cancelled(&mut byte, &cancel).await.unwrap();
        if count == 0 {
            return 0;
        }
        output.write_all(&byte, &cancel).await.unwrap();
    }
}
