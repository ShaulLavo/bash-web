use super::*;
use crate::exec::{RESOURCE_STATUS, StorageBudget};
use futures::FutureExt;

fn source_state(args: &[&str], memory: Option<StorageBudget>) -> SharedState {
    let mut state = memory.map(State::with_memory).unwrap_or_default();
    let args = args.iter().map(|arg| (*arg).to_owned()).collect();
    state.replace_positional(args).unwrap();
    state.shared()
}

#[test]
fn source_frame_shares_positionals_when_no_arguments_are_supplied() {
    let state = source_state(&["outer", "tail"], None);
    let frame = SourceFrame::enter(state.clone(), Vec::new()).unwrap();
    state.borrow_mut().shift_positional(1).unwrap();
    frame.finish();
    assert_eq!(state.borrow().positional(), &["tail"]);
    assert_eq!(state.borrow().source_calls, 0);
}

#[test]
fn source_frame_restores_shifted_arguments_without_creating_a_local_scope() {
    let state = source_state(&["outer"], None);
    let frame = SourceFrame::enter(state.clone(), vec!["inner".into()]).unwrap();
    assert_eq!(state.borrow().source_calls, 1);
    assert_eq!(state.borrow().function_calls, 0);
    assert!(state.borrow().locals.is_empty());
    state.borrow_mut().shift_positional(1).unwrap();
    frame.finish();
    assert_eq!(state.borrow().positional(), &["outer"]);
}

#[test]
fn source_frame_keeps_top_level_set_but_a_nested_argument_frame_consumes_it() {
    let state = source_state(&["outer"], None);
    let frame = SourceFrame::enter(state.clone(), vec!["inner".into()]).unwrap();
    state
        .borrow_mut()
        .replace_positional(vec!["changed".into()])
        .unwrap();
    frame.finish();
    assert_eq!(state.borrow().positional(), &["changed"]);
    let outer = SourceFrame::enter(state.clone(), vec!["one".into()]).unwrap();
    let inner = SourceFrame::enter(state.clone(), vec!["two".into()]).unwrap();
    state
        .borrow_mut()
        .replace_positional(vec!["nested".into()])
        .unwrap();
    inner.finish();
    assert_eq!(state.borrow().positional(), &["nested"]);
    outer.finish();
    assert_eq!(state.borrow().positional(), &["changed"]);
}

#[test]
fn source_frame_inside_a_function_restores_even_explicit_set() {
    let state = State::default().shared();
    let function = FunctionFrame::enter(state.clone(), vec!["function".into()], 8).unwrap();
    let source = SourceFrame::enter(state.clone(), vec!["source".into()]).unwrap();
    state
        .borrow_mut()
        .replace_positional(vec!["changed".into()])
        .unwrap();
    source.finish();
    assert_eq!(state.borrow().positional(), &["function"]);
    drop(function);
    assert!(state.borrow().positional().is_empty());
}

#[test]
fn source_frame_failed_admission_leaves_state_and_storage_unchanged() {
    let memory = StorageBudget::new(256);
    let state = source_state(&["outer"], Some(memory.clone()));
    let before = memory.observation().0;
    assert!(matches!(
        SourceFrame::enter(state.clone(), vec!["x".repeat(256)]),
        Err(RESOURCE_STATUS)
    ));
    assert_eq!(state.borrow().source_calls, 0);
    assert_eq!(state.borrow().positional(), &["outer"]);
    assert_eq!(memory.observation().0, before);
}

#[test]
fn source_frame_future_drop_restores_arguments_and_refunds_storage() {
    let memory = StorageBudget::new(1024);
    let state = source_state(&["outer"], Some(memory.clone()));
    let before = memory.observation().0;
    let frame = SourceFrame::enter(state.clone(), vec!["inner".into()]).unwrap();
    let future = async move {
        let _frame = frame;
        futures::future::pending::<()>().await;
    };
    let mut future = Box::pin(future);
    assert!(future.as_mut().now_or_never().is_none());
    assert!(memory.observation().0 > before);
    drop(future);
    assert_eq!(state.borrow().source_calls, 0);
    assert_eq!(state.borrow().positional(), &["outer"]);
    assert_eq!(memory.observation().0, before);
    drop(state);
    assert_eq!(memory.observation().0, 0);
}
