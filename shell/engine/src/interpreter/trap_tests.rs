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
            shell
                .start("trap - ERR EXIT; unset ready BASH_COMMAND")
                .unwrap()
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
        complete(
            &executor,
            shell
                .start("trap - ERR; unset seen BASH_COMMAND; unset -f f")
                .unwrap()
        ),
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
                .start("f() { while :; do :; done; }; trap 'seen=1; f' ERR; false || true")
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
        complete(
            &executor,
            shell
                .start("trap - ERR; unset seen BASH_COMMAND; unset -f f")
                .unwrap()
        ),
        0
    );
    assert_eq!(shell.core.execution_storage.observation().0, 0);
    assert!(output.bytes().is_empty());
    assert!(before > 0);
}

#[test]
fn extdebug_skip_and_function_return_transfer_do_not_execute_the_command() {
    let (shell, executor, output) = session();
    assert_eq!(
        complete(
            &executor,
            shell
                .start("shopt -s extdebug; trap 'false' DEBUG")
                .unwrap()
        ),
        0
    );
    assert_eq!(
        complete(&executor, shell.start("seen=1; echo BAD").unwrap()),
        0
    );
    assert!(shell.state().borrow().scalar_parameter("seen").is_none());
    assert!(output.bytes().is_empty());
    shell.state().borrow_mut().traps.set(65, None);
    let source = "f() { trap '(exit 2)' DEBUG; seen=1; echo BAD; }; f; echo after:$?";
    assert_eq!(complete(&executor, shell.start(source).unwrap()), 0);
    assert!(shell.state().borrow().scalar_parameter("seen").is_none());
    assert_eq!(output.bytes(), b"after:2\n");
}

#[test]
fn compound_setup_failure_uses_err_policy_with_or_without_errexit() {
    let (shell, executor, output) = session();
    assert_eq!(
        complete(
            &executor,
            shell
                .start("trap 'seen=1; echo err' ERR; { :; } > /; echo done")
                .unwrap()
        ),
        0
    );
    assert_eq!(shell.state().borrow().scalar_parameter("seen"), Some("1"));
    assert!(
        String::from_utf8(output.bytes())
            .unwrap()
            .ends_with("err\ndone\n")
    );
    assert_eq!(
        complete(
            &executor,
            shell
                .start("unset seen; set -e; trap 'echo exit' EXIT; { :; } > /; echo BAD")
                .unwrap()
        ),
        1
    );
    assert_eq!(shell.state().borrow().scalar_parameter("seen"), Some("1"));
    assert!(shell.exit_requested());
    assert_eq!(output.bytes(), b"err\ndone\nerr\n");
    assert_eq!(
        complete(&executor, shell.start("set +e; echo recovered").unwrap()),
        0
    );
    assert_eq!(output.bytes(), b"err\ndone\nerr\nrecovered\n");
    assert_eq!(complete(&executor, shell.finish(1).unwrap()), 1);
    assert_eq!(output.bytes(), b"err\ndone\nerr\nrecovered\nexit\n");
}

#[test]
fn lastpipe_is_shared_and_isolated_child_actions_do_not_mutate_parent() {
    let (shell, executor, output) = session();
    let source = "shopt -s lastpipe; trap 'echo parent' EXIT; : | trap 'echo last' EXIT; (trap 'echo child' EXIT; seen=child); trap -p EXIT";
    assert_eq!(complete(&executor, shell.start(source).unwrap()), 0);
    assert!(shell.state().borrow().scalar_parameter("seen").is_none());
    assert_eq!(output.bytes(), b"child\ntrap -- 'echo last' EXIT\n");
    assert_eq!(complete(&executor, shell.finish(0).unwrap()), 0);
    assert_eq!(output.bytes(), b"child\ntrap -- 'echo last' EXIT\nlast\n");
}

#[test]
fn handler_failures_obey_errexit_but_same_kind_does_not_recurse() {
    let (shell, executor, output) = session();
    let source = "trap 'echo err; false; echo tail' ERR; false; set -e; false; echo BAD";
    assert_eq!(complete(&executor, shell.start(source).unwrap()), 1);
    assert_eq!(output.bytes(), b"err\ntail\nerr\n");
    assert!(shell.exit_requested());
    assert_eq!(
        complete(&executor, shell.start("set +e; echo recovered").unwrap()),
        0
    );
    assert_eq!(output.bytes(), b"err\ntail\nerr\nrecovered\n");
}

#[test]
fn child_exit_registered_inside_parent_exit_still_has_its_own_completion() {
    let (shell, executor, output) = session();
    let source = "trap '(trap \"echo child\" EXIT); echo parent' EXIT; exit";
    assert_eq!(complete(&executor, shell.start(source).unwrap()), 0);
    assert_eq!(output.bytes(), b"child\nparent\n");
}

#[test]
fn optimized_arithmetic_loop_body_keeps_err_and_debug_boundaries() {
    let (shell, executor, output) = session();
    let source = "trap 'echo err' ERR; for i in 1; do ((0)); done; trap - ERR; trap 'echo debug' DEBUG; for i in 1; do ((1)); done; trap - DEBUG";
    assert_eq!(complete(&executor, shell.start(source).unwrap()), 0);
    assert_eq!(output.bytes(), b"err\ndebug\ndebug\ndebug\n");
}

#[test]
fn explicit_handler_exit_keeps_its_status_and_pipeline_instead_of_restoring_trigger() {
    let (shell, executor, output) = session();
    assert_eq!(
        complete(&executor, shell.start("trap 'exit 9' EXIT; false").unwrap()),
        1
    );
    assert_eq!(complete(&executor, shell.finish(1).unwrap()), 9);
    assert_eq!(shell.state().borrow().status(), 9);
    assert_eq!(shell.state().borrow().pipeline_status(), &[9]);
    assert!(output.bytes().is_empty());
}

#[test]
fn err_metadata_stays_at_trigger_through_handler_commands_and_debug() {
    let (shell, executor, output) = session();
    let source = "set -T; trap ':' DEBUG; trap 'before=$BASH_COMMAND; :; after=$BASH_COMMAND' ERR; false; trap - ERR DEBUG; echo \"$before/$after\"";
    assert_eq!(complete(&executor, shell.start(source).unwrap()), 0);
    assert_eq!(output.bytes(), b"false/false\n");
}

#[test]
fn function_err_restore_uses_entry_trace_policy_not_changed_option() {
    let (shell, executor, output) = session();
    let source = "set -E; trap 'echo BAD' ERR; f() { trap - ERR; set +E; }; f; false; trap 'echo kept' ERR; g() { set -E; trap - ERR; return 1; }; g; false";
    assert_eq!(complete(&executor, shell.start(source).unwrap()), 1);
    assert_eq!(output.bytes(), b"kept\nkept\n");
}

#[test]
fn explicit_subshell_pipeline_retains_structural_condition_suppression() {
    let (shell, executor, output) = session();
    let source = "trap 'echo BAD' ERR; (false) | true; ! true | (false); if true | (false); then :; fi; true | (false) || :; echo done";
    assert_eq!(complete(&executor, shell.start(source).unwrap()), 0);
    assert_eq!(output.bytes(), b"done\n");
}

#[test]
fn arithmetic_loop_err_metadata_uses_the_normal_command_entry() {
    let (shell, executor, output) = session();
    let source = "trap 'echo \"$BASH_COMMAND\"' ERR; while :; do ((0)); break; done";
    assert_eq!(complete(&executor, shell.start(source).unwrap()), 0);
    assert_eq!(output.bytes(), b"((0))\n");
}

#[test]
fn err_metadata_entry_refusal_and_cancel_leave_binding_and_handler_untouched() {
    let (shell, executor, output) = session();
    assert_eq!(
        complete(
            &executor,
            shell
                .start("BASH_COMMAND=prior; trap 'seen=1' ERR")
                .unwrap()
        ),
        0
    );
    let context = context(&shell);
    let command =
        super::Command::Compound(super::CompoundCommand::Arithmetic("0".into()), Vec::new());
    let before = shell.core.execution_storage.observation().0;
    let used = shell.core.eval_storage.observation().0;
    let held = shell
        .core
        .execution_storage
        .admit(shell.core.limits.execution_bytes - before)
        .unwrap();
    let decision = super::traps::debug(
        &command,
        shell.state(),
        shell.core.descriptors.clone(),
        context.clone(),
    )
    .now_or_never()
    .unwrap();
    assert_eq!(decision.outcome().unwrap().flow, super::Flow::Resource);
    drop(held);
    context.cancel.cancel();
    let decision = super::traps::debug(
        &command,
        shell.state(),
        shell.core.descriptors.clone(),
        context,
    )
    .now_or_never()
    .unwrap();
    assert_eq!(decision.outcome().unwrap().code, 130);
    assert_eq!(
        shell.state().borrow().scalar_parameter("BASH_COMMAND"),
        Some("prior")
    );
    assert!(shell.state().borrow().scalar_parameter("seen").is_none());
    assert!(output.bytes().is_empty());
    assert_eq!(shell.core.eval_storage.observation().0, used);
    assert_eq!(shell.core.execution_storage.observation().0, before);
    assert_eq!(
        complete(
            &executor,
            shell.start("trap - ERR; unset BASH_COMMAND").unwrap()
        ),
        0
    );
    assert_eq!(shell.core.execution_storage.observation().0, 0);
}

#[test]
fn background_completion_handoff_refunds_on_completion_and_cancellation() {
    let (shell, executor, output) = session();
    let before = shell.core.execution_storage.observation().0;
    let source = "value=$({ trap ':' EXIT; :; } & wait); unset value";
    assert_eq!(complete(&executor, shell.start(source).unwrap()), 0);
    executor.drive(256);
    assert_eq!(shell.core.eval_storage.observation().0, 0);
    assert_eq!(shell.core.execution_storage.observation().0, before);
    let source = "{ trap 'echo BAD_EXIT' EXIT; while :; do :; done; } >/dev/null & wait";
    let job = shell.start(source).unwrap();
    executor.drive(256);
    assert!(!job.is_finished());
    shell.interrupt();
    assert_eq!(complete(&executor, job), 130);
    // Foreground interruption preserves the separately owned background job.
    assert!(executor.drive(0).pending > 0);
    assert_eq!(
        complete(&executor, shell.start("kill %1; wait").unwrap()),
        0
    );
    executor.drive(256);
    assert!(output.bytes().is_empty());
    assert_eq!(shell.core.eval_storage.observation().0, 0);
    assert_eq!(shell.core.execution_storage.observation().0, before);
    assert_eq!(complete(&executor, shell.start(":").unwrap()), 0);
}
