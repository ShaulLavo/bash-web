//! Session-level trap lifecycle and command-boundary status.
use super::{Limits, Session};
use crate::{
    executor::{Executor, JoinHandle},
    io::{Capture, Endpoint, FdTable, MemoryFs, capture},
    process::InProcessHost,
};
use futures::FutureExt;
use std::rc::Rc;

fn session() -> (Session, Executor, Capture) {
    let executor = Executor::new();
    let host = InProcessHost::new(executor.clone());
    let shell = Session::new(
        executor.clone(),
        Rc::new(host),
        Rc::new(MemoryFs::new(4096)),
        Limits::default(),
    );
    let (writer, output) = capture(4096);
    let mut descriptors = FdTable::default();
    descriptors.insert(0, Endpoint::null());
    descriptors.insert(1, writer.clone());
    descriptors.insert(2, writer);
    shell.set_descriptors(descriptors).unwrap();
    (shell, executor, output)
}
fn complete(executor: &Executor, job: JoinHandle<i32>) -> i32 {
    for _ in 0..10000 {
        executor.drive(256);
        if job.is_finished() {
            return job.now_or_never().unwrap();
        }
    }
    panic!("trap test exceeded executor turn limit");
}
#[test]
fn persistent_submissions_run_exit_action_only_when_shell_exits() {
    let (shell, executor, output) = session();
    let job = shell.start("trap 'echo cleanup:$?' EXIT; false").unwrap();
    assert_eq!(complete(&executor, job), 1);
    assert!(output.bytes().is_empty());
    assert_eq!(complete(&executor, shell.start("trap -p").unwrap()), 0);
    assert_eq!(output.bytes(), b"trap -- 'echo cleanup:$?' EXIT\n");
    assert_eq!(complete(&executor, shell.start("exit 4").unwrap()), 4);
    assert_eq!(
        output.bytes(),
        b"trap -- 'echo cleanup:$?' EXIT\ncleanup:4\n"
    );
    assert!(shell.exit_requested());
}

#[test]
fn command_string_and_eof_dispatch_exit_before_publishing_the_final_status() {
    for command_string in [false, true] {
        let (shell, executor, output) = session();
        shell.state().borrow_mut().command_string = command_string;
        let job = shell
            .start("trap 'echo cleanup:$?; exit 12' EXIT; false")
            .unwrap();
        let code = complete(&executor, job);
        if command_string {
            assert_eq!(code, 12);
        } else {
            assert_eq!(code, 1);
            assert!(output.bytes().is_empty());
            assert_eq!(complete(&executor, shell.finish(code).unwrap()), 12);
        }
        assert_eq!(output.bytes(), b"cleanup:1\n");
    }
}

#[test]
fn err_skips_tested_failures_and_precedes_exit_under_errexit() {
    let (shell, executor, output) = session();
    shell.state().borrow_mut().command_string = true;
    let job = shell.start("trap 'echo error:$?' ERR; trap 'echo exit:$?' EXIT; set -e; if false; then echo wrong; fi; false || :; false; echo wrong").unwrap();
    assert_eq!(complete(&executor, job), 1);
    assert_eq!(output.bytes(), b"error:1\nexit:1\n");
}

#[test]
fn return_uses_traced_function_locals_before_unwind() {
    let (shell, executor, output) = session();
    let job = shell.start("set -T; trap 'echo returning:$value' RETURN; f() { local value=inside; return 9; }; f; echo result:$?:${value-outside}").unwrap();
    assert_eq!(complete(&executor, job), 0);
    assert_eq!(output.bytes(), b"returning:inside\nresult:9:outside\n");
}

#[test]
fn unsupported_traps_fail_registration_and_leave_no_binding() {
    for (script, signal) in [
        (
            "trap 'echo forbidden' DEBUG; code=$?; trap -p DEBUG; exit \"$code\"",
            "DEBUG",
        ),
        (
            "(trap 'echo forbidden' HUP; code=$?; trap -p HUP; exit \"$code\")",
            "HUP",
        ),
    ] {
        let (shell, executor, output) = session();
        assert_eq!(complete(&executor, shell.start(script).unwrap()), 1);
        assert_eq!(
            output.bytes(),
            format!("trap: {signal}: trap execution is unsupported in this shell\n").as_bytes()
        );
    }
}

#[test]
fn isolated_exit_handlers_run_at_their_own_output_boundary() {
    let (shell, executor, output) = session();
    let job = shell
        .start("trap 'echo root' EXIT; (echo inherited); x=$(trap 'echo child:$?' EXIT; false); echo capture:$?:$x; exit")
        .unwrap();
    assert_eq!(complete(&executor, job), 0);
    assert_eq!(output.bytes(), b"inherited\ncapture:1:child:1\nroot\n");
}

#[test]
fn background_exit_inherits_the_compounds_redirected_output() {
    let (shell, executor, output) = session();
    let job = shell
        .start("{ trap 'echo cleanup' EXIT; echo body; } >output & wait; printf '%s\\n' \"$(<output)\"")
        .unwrap();
    assert_eq!(complete(&executor, job), 0);
    assert_eq!(output.bytes(), b"body\ncleanup\n");
}

#[test]
fn errtrace_handles_the_pipeline_once_and_traces_commands_within_it() {
    let (shell, executor, output) = session();
    let job = shell
        .start("set -E; trap 'echo err:$?' ERR; { false; echo body; } | while read -r line; do echo \"$line\"; done; false | false")
        .unwrap();
    assert_eq!(complete(&executor, job), 1);
    assert_eq!(output.bytes(), b"err:1\nbody\nerr:1\n");
}

#[test]
fn return_exposes_the_preceding_status_for_functions_and_source() {
    let (shell, executor, output) = session();
    let job = shell
        .start("set -T; trap 'echo return:$?' RETURN; f() { false; return 7; }; f; echo function:$?; echo 'false; return 8' >library; source library; echo source:$?")
        .unwrap();
    assert_eq!(complete(&executor, job), 0);
    assert_eq!(
        output.bytes(),
        b"return:1\nfunction:7\nreturn:1\nsource:8\n"
    );
}

#[test]
fn a_child_can_install_its_own_err_handler_inside_a_parent_handler() {
    let (shell, executor, output) = session();
    let job = shell
        .start("trap 'echo parent; (trap \"echo child\" ERR; false)' ERR; false")
        .unwrap();
    assert_eq!(complete(&executor, job), 1);
    assert_eq!(output.bytes(), b"parent\nchild\n");
}
#[test]
fn interrupted_submission_keeps_retained_action_until_reset_refunds_it() {
    let (shell, executor, output) = session();
    let before = shell.core.execution_storage.observation().0;
    let job = shell
        .start("trap 'echo BAD_EXIT' EXIT; while :; do :; done")
        .unwrap();
    executor.drive(32);
    shell.interrupt();
    assert_eq!(complete(&executor, job), 130);
    assert!(output.bytes().is_empty());
    assert!(shell.core.execution_storage.observation().0 > before);
    assert_eq!(complete(&executor, shell.start("trap - EXIT").unwrap()), 0);
    executor.drive(256);
    assert_eq!(shell.core.execution_storage.observation().0, before);
    assert_eq!(
        complete(&executor, shell.start("echo recovered").unwrap()),
        0
    );
    assert_eq!(output.bytes(), b"recovered\n");
}
