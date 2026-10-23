//! Session trap registration, action cancellation and retained storage.
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
fn interrupt_entered(shell: &Session, executor: &Executor, output: &Capture, job: JoinHandle<i32>) {
    for _ in 0..1000 {
        executor.drive(128);
        if output.bytes() == b"entered\n" {
            break;
        }
    }
    assert_eq!(output.bytes(), b"entered\n");
    shell.interrupt();
    assert_eq!(complete(executor, job), 130);
}
#[test]
fn persistent_submissions_retain_registration_without_running_actions() {
    let (shell, executor, output) = session();
    let job = shell.start("trap 'echo BAD' EXIT; false").unwrap();
    assert_eq!(complete(&executor, job), 1);
    assert!(output.bytes().is_empty());
    assert_eq!(complete(&executor, shell.start("trap -p").unwrap()), 0);
    assert_eq!(output.bytes(), b"trap -- 'echo BAD' EXIT\n");
    assert_eq!(complete(&executor, shell.start("exit 4").unwrap()), 4);
    assert_eq!(output.bytes(), b"trap -- 'echo BAD' EXIT\n");
    assert!(shell.exit_requested());
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
fn interrupted_error_action_is_not_left_running_and_reset_refunds_storage() {
    let (shell, executor, output) = session();
    let before = shell.core.execution_storage.observation().0;
    let job = shell
        .start("trap 'echo entered; while :; do :; done' ERR; false")
        .unwrap();
    interrupt_entered(&shell, &executor, &output, job);
    assert!(
        shell
            .state
            .borrow()
            .traps
            .action(crate::state::traps::Event::Error)
            .is_some()
    );
    let job = shell.start("trap 'echo recovered' ERR; false").unwrap();
    assert_eq!(complete(&executor, job), 1);
    assert_eq!(output.bytes(), b"entered\nrecovered\n");
    assert_eq!(complete(&executor, shell.start("trap - ERR").unwrap()), 0);
    executor.drive(256);
    assert_eq!(shell.core.execution_storage.observation().0, before);
}

#[test]
fn interrupted_return_action_restores_function_bindings_and_running_guard() {
    let (shell, executor, output) = session();
    let job = shell.start("set -- outer; x=outer; f(){ local x=inner; trap 'echo entered; while :; do :; done' RETURN; :; }; f inner").unwrap();
    interrupt_entered(&shell, &executor, &output, job);
    assert_eq!(shell.state.borrow().function_calls, 0);
    assert!(
        shell
            .state
            .borrow()
            .traps
            .action(crate::state::traps::Event::Return)
            .is_some()
    );
    let job = shell
        .start("trap - RETURN; echo $x:$1; f(){ trap 'echo returned' RETURN; :; }; f")
        .unwrap();
    assert_eq!(complete(&executor, job), 0);
    assert_eq!(output.bytes(), b"entered\nouter:outer\nreturned\n");
}
