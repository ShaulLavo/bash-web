//! Session-level trap containment and uncatchable registration.
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
fn rejected_registrations_leave_no_action_in_the_session() {
    let (shell, executor, output) = session();
    let before = shell.core.execution_storage.observation().0;
    for event in ["EXIT", "ERR", "RETURN", "DEBUG", "INT", "TERM"] {
        let before_output = output.bytes().len();
        let job = shell
            .start(&format!("trap 'echo forbidden' {event}"))
            .unwrap();
        assert_eq!(complete(&executor, job), 1, "{event}");
        let diagnostic = format!("trap: {event}: trap execution is unsupported\n");
        assert_eq!(&output.bytes()[before_output..], diagnostic.as_bytes());
    }
    let after = output.bytes();
    assert_eq!(complete(&executor, shell.start("trap -p").unwrap()), 0);
    assert_eq!(complete(&executor, shell.start("exit 4").unwrap()), 4);
    assert_eq!(output.bytes(), after);
    assert_eq!(shell.core.execution_storage.observation().0, before);
    assert!(shell.exit_requested());
}
#[test]
fn interrupted_submission_keeps_retained_action_until_reset_refunds_it() {
    let (shell, executor, output) = session();
    let before = shell.core.execution_storage.observation().0;
    let job = shell
        .start("trap 'echo forbidden' KILL; while :; do :; done")
        .unwrap();
    executor.drive(32);
    shell.interrupt();
    assert_eq!(complete(&executor, job), 130);
    assert!(output.bytes().is_empty());
    assert!(shell.core.execution_storage.observation().0 > before);
    assert_eq!(complete(&executor, shell.start("trap - KILL").unwrap()), 0);
    executor.drive(256);
    assert_eq!(shell.core.execution_storage.observation().0, before);
    assert_eq!(
        complete(&executor, shell.start("echo recovered").unwrap()),
        0
    );
    assert_eq!(output.bytes(), b"recovered\n");
}
