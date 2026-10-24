//! Session trap lifecycle, retained action ownership and cancellation.
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
fn submissions_are_not_eof_but_explicit_exit_completes_once() {
    let (shell, executor, output) = session();
    let job = shell.start("trap 'echo BAD' EXIT; false").unwrap();
    assert_eq!(complete(&executor, job), 1);
    assert!(output.bytes().is_empty());
    assert_eq!(complete(&executor, shell.start("trap -p").unwrap()), 0);
    assert_eq!(output.bytes(), b"trap -- 'echo BAD' EXIT\n");
    assert_eq!(complete(&executor, shell.start("exit 4").unwrap()), 4);
    assert_eq!(output.bytes(), b"trap -- 'echo BAD' EXIT\nBAD\n");
    assert!(shell.exit_requested());
    assert_eq!(complete(&executor, shell.finish(99).unwrap()), 4);
    assert!(shell.start("echo UNREACHABLE").is_err());
    assert_eq!(output.bytes(), b"trap -- 'echo BAD' EXIT\nBAD\n");
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

#[test]
fn actual_eof_completes_once_and_refuses_new_submissions() {
    let (shell, executor, output) = session();
    assert_eq!(
        complete(
            &executor,
            shell.start("trap 'echo eof:$?' EXIT; false").unwrap()
        ),
        1
    );
    assert!(output.bytes().is_empty());
    assert_eq!(complete(&executor, shell.finish(1).unwrap()), 1);
    assert_eq!(complete(&executor, shell.finish(9).unwrap()), 1);
    assert_eq!(output.bytes(), b"eof:1\n");
    assert!(shell.start(":").is_err());
}

#[test]
fn handler_replacement_changes_only_the_next_event_and_same_kind_does_not_reenter() {
    let (shell, executor, output) = session();
    let source = "trap 'echo first; trap \"echo next\" DEBUG' DEBUG; :; :; trap - DEBUG";
    assert_eq!(complete(&executor, shell.start(source).unwrap()), 0);
    assert_eq!(output.bytes(), b"first\nnext\nnext\n");
}

#[test]
fn original_pipeline_is_visible_to_err_and_restored_after_handler_commands() {
    let (shell, executor, output) = session();
    let source = "set -o pipefail; trap 'echo \"err:$?:${PIPESTATUS[*]}\"; true' ERR; false | true; echo \"after:$?:${PIPESTATUS[*]}\"";
    assert_eq!(complete(&executor, shell.start(source).unwrap()), 0);
    assert_eq!(output.bytes(), b"err:1:1 0\nafter:1:1 0\n");
}

#[test]
fn refused_trap_reader_has_no_handler_effects_and_refunds_entry_storage() {
    let (shell, executor, output) = session();
    assert_eq!(
        complete(
            &executor,
            shell.start("trap 'seen=1; echo BAD' ERR").unwrap()
        ),
        0
    );
    let before = shell.core.execution_storage.observation().0;
    let context = context(&shell);
    let limit = shell.core.limits.expansion_bytes;
    let used = shell.core.eval_storage.observation().0;
    let held = shell.core.eval_storage.admit(limit - used).unwrap();
    let result = super::traps::run(
        super::traps::Event::Err,
        shell.state(),
        shell.core.descriptors.clone(),
        context,
    )
    .now_or_never()
    .unwrap();
    assert_eq!(result.flow, super::Flow::Resource);
    assert!(shell.state().borrow().bindings().get("seen").is_none());
    assert!(output.bytes().is_empty());
    drop(held);
    assert_eq!(shell.core.eval_storage.observation().0, used);
    assert_eq!(shell.core.execution_storage.observation().0, before);
    assert_eq!(complete(&executor, shell.start("trap - ERR").unwrap()), 0);
}

#[test]
fn cancellation_inside_handler_unwinds_without_starting_exit_and_refunds_reader() {
    let (shell, executor, output) = session();
    assert_eq!(
        complete(
            &executor,
            shell
                .start("trap 'echo BAD_EXIT' EXIT; trap 'ready=1; while :; do :; done' ERR")
                .unwrap()
        ),
        0
    );
    let before = shell.core.execution_storage.observation().0;
    let job = shell.start("false").unwrap();
    for _ in 0..1024 {
        executor.drive(1);
        if shell.state().borrow().bindings().get("ready").is_some() {
            break;
        }
    }
    assert!(shell.state().borrow().bindings().get("ready").is_some());
    shell.interrupt();
    assert_eq!(complete(&executor, job), 130);
    assert!(output.bytes().is_empty());
    assert_eq!(shell.core.eval_storage.observation().0, 0);
    assert_eq!(
        complete(
            &executor,
            shell.start("trap - ERR EXIT; unset ready").unwrap()
        ),
        0
    );
    assert_eq!(shell.core.execution_storage.observation().0, 0);
    assert!(before > 0);
}

#[test]
fn late_resource_failure_preserves_completed_handler_effects() {
    let (shell, executor, output) = session();
    assert_eq!(
        complete(
            &executor,
            shell
                .start("trap 'seen=1; while :; do :; done' ERR")
                .unwrap()
        ),
        0
    );
    let job = shell.start("false").unwrap();
    for _ in 0..1024 {
        executor.drive(1);
        if shell.state().borrow().bindings().get("seen").is_some() {
            break;
        }
    }
    assert!(shell.state().borrow().bindings().get("seen").is_some());
    let used = shell.core.execution_storage.observation().0;
    let held = shell
        .core
        .execution_storage
        .admit(shell.core.limits.execution_bytes - used)
        .unwrap();
    assert_eq!(complete(&executor, job), 2);
    assert_eq!(shell.state().borrow().scalar_parameter("seen"), Some("1"));
    drop(held);
    assert_eq!(
        complete(&executor, shell.start("trap - ERR; unset seen").unwrap()),
        0
    );
    assert_eq!(shell.core.eval_storage.observation().0, 0);
    assert_eq!(shell.core.execution_storage.observation().0, 0);
    assert!(
        String::from_utf8(output.bytes())
            .unwrap()
            .contains("memory limit")
    );
}

fn context(shell: &Session) -> super::Context {
    let core = shell.core.clone();
    let evaluation = crate::exec::Scope::new(
        core.limits.source_bytes,
        core.eval_storage.clone(),
        core.execution_storage.clone(),
    );
    let group = core.host.allocate_group();
    super::Context::root(
        core,
        crate::exec::Source::root(""),
        evaluation,
        crate::executor::Cancel::new(),
        group,
    )
}

#[test]
fn dropping_handler_wait_cancels_reader_and_restores_status_before_reuse() {
    let (shell, executor, output) = session();
    assert_eq!(
        complete(
            &executor,
            shell
                .start("trap 'seen=1; while :; do :; done' ERR; false || true")
                .unwrap()
        ),
        0
    );
    shell.state().borrow_mut().publish_status(7);
    let before = shell.core.execution_storage.observation().0;
    let mut handler = super::traps::run(
        super::traps::Event::Err,
        shell.state(),
        shell.core.descriptors.clone(),
        context(&shell),
    );
    assert!((&mut handler).now_or_never().is_none());
    executor.drive(64);
    assert_eq!(shell.state().borrow().scalar_parameter("seen"), Some("1"));
    drop(handler);
    for _ in 0..1000 {
        if executor.drive(64).pending == 0 {
            break;
        }
    }
    assert_eq!(executor.drive(64).pending, 0);
    assert_eq!(shell.state().borrow().status(), 7);
    assert_eq!(shell.core.eval_storage.observation().0, 0);
    assert_eq!(
        complete(&executor, shell.start("trap - ERR; unset seen").unwrap()),
        0
    );
    assert_eq!(shell.core.execution_storage.observation().0, 0);
    assert!(output.bytes().is_empty());
    assert!(before > 0);
}
