//! Original EXIT completion, called only by the shell scope that is ending.
use super::{Context, Descriptors, Flow, Outcome, eval};
use crate::{
    executor::Budget,
    state::{FunctionFrame, SharedState},
};

pub(super) async fn finish_function_exit(
    result: Outcome,
    state: SharedState,
    fds: Descriptors,
    context: Context,
) -> Outcome {
    if result.flow != Flow::Exit || context.scope.0.id != 0 || state.borrow().function_calls == 0 {
        return result;
    }
    finish(result, state, fds, context).await
}

pub(super) async fn finish_function_abort(
    result: Outcome,
    frame: &mut FunctionFrame,
    state: SharedState,
    context: Context,
) -> Outcome {
    if result.flow != Flow::Abort || context.scope.0.id != 0 || !state.borrow().traps.pending_exit()
    {
        return result;
    }
    frame.restore_locals_for_exit();
    let fds = context.core.descriptors.clone();
    finish(result, state, fds, context).await
}

pub(super) async fn finish(
    result: Outcome,
    state: SharedState,
    fds: Descriptors,
    context: Context,
) -> Outcome {
    if context.cancel.is_cancelled() || matches!(result.flow, Flow::Resource | Flow::SpawnFailed) {
        return result;
    }
    let action = state.borrow_mut().traps.begin_exit();
    let Some(action) = action else {
        return result;
    };
    let _storage = match context.evaluation.admit_storage(action.text.len()) {
        Ok(storage) => storage,
        Err(code) => return Outcome::status(code),
    };
    let mut budget = Budget::default();
    for _ in action.text.bytes() {
        if context
            .evaluation
            .checkpoint(&mut budget, &context.cancel)
            .await
            .is_err()
        {
            return Outcome::status(context.cancel_status());
        }
    }
    state.borrow_mut().publish_status(result.code);
    let handler = eval::run(vec![action.text.clone()], state.clone(), fds, context).await;
    let outcome = match handler.flow {
        Flow::Exit | Flow::Abort | Flow::Resource | Flow::SpawnFailed => handler,
        Flow::Return => Outcome {
            code: handler.code,
            flow: Flow::Exit,
        },
        _ => result,
    };
    state.borrow_mut().publish_status(outcome.code);
    outcome
}

#[cfg(test)]
mod tests {
    use super::super::{Limits, Session};
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
    fn persistent_submissions_keep_traps_until_explicit_completion() {
        let (shell, executor, output) = session();
        assert_eq!(
            complete(
                &executor,
                shell
                    .start("trap 'echo exit:$?; KEPT=yes; false' EXIT; false")
                    .unwrap()
            ),
            1
        );
        assert!(output.bytes().is_empty());
        assert_eq!(complete(&executor, shell.start("echo next:$?").unwrap()), 0);
        assert_eq!(
            complete(&executor, shell.start_script("exit 9").unwrap()),
            9
        );
        assert_eq!(output.bytes(), b"next:1\nexit:9\n");
        assert_eq!(
            shell
                .state()
                .borrow()
                .bindings()
                .get("KEPT")
                .map(String::as_str),
            Some("yes")
        );
        assert!(shell.exit_requested());
    }
    #[test]
    fn handler_exit_after_errexit_marks_the_session_terminal() {
        let (shell, executor, output) = session();
        assert_eq!(
            complete(
                &executor,
                shell.start("set -e; trap 'exit 7' EXIT; false").unwrap()
            ),
            7
        );
        assert!(shell.exit_requested());
        assert!(output.bytes().is_empty());
    }
    #[test]
    fn function_abort_handler_return_marks_the_session_terminal() {
        let (shell, executor, output) = session();
        assert_eq!(
            complete(
                &executor,
                shell
                    .start("set -e; f() { trap 'return 7' EXIT; false; }; f")
                    .unwrap()
            ),
            7
        );
        assert!(shell.exit_requested());
        assert!(output.bytes().is_empty());
    }
    #[test]
    fn interrupted_abort_handler_restores_nested_frames_once() {
        let (shell, executor, output) = session();
        let job = shell.start("v=global; set -- root; f() { local v=outer; g inner; }; g() { local v=inner; trap 'echo $v:$*; while :; do :; done' EXIT; false; }; set -e; f outer").unwrap();
        for _ in 0..1000 {
            executor.drive(32);
            if !output.bytes().is_empty() {
                break;
            }
        }
        assert_eq!(output.bytes(), b"global:inner\n");
        shell.interrupt();
        assert_eq!(complete(&executor, job), 130);
        assert_eq!(
            shell
                .state()
                .borrow()
                .bindings()
                .get("v")
                .map(String::as_str),
            Some("global")
        );
        assert_eq!(shell.state().borrow().function_calls, 0);
        assert!(!shell.state().borrow().in_function_scope());
        assert_eq!(complete(&executor, shell.start("echo $v:$*").unwrap()), 0);
        assert_eq!(output.bytes(), b"global:inner\nglobal:root\n");
    }
    #[test]
    fn interrupt_does_not_run_exit_and_next_submission_can_remove_retained_action() {
        let (shell, executor, output) = session();
        let job = shell
            .start("trap 'echo BAD_EXIT' EXIT; while :; do :; done")
            .unwrap();
        executor.drive(32);
        shell.interrupt();
        assert_eq!(complete(&executor, job), 130);
        assert!(output.bytes().is_empty());
        assert!(shell.core.execution_storage.observation().0 > 0);
        assert_eq!(complete(&executor, shell.start("trap - EXIT").unwrap()), 0);
        executor.drive(256);
        assert_eq!(shell.core.execution_storage.observation().0, 0);
        assert_eq!(
            complete(&executor, shell.start_script("echo recovered").unwrap()),
            0
        );
        assert_eq!(output.bytes(), b"recovered\n");
    }
}
