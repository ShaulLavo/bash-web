use super::*;
use crate::exec::StorageBudget;
use std::{
    future::Future,
    task::{Context, Poll, Waker},
};
fn block_on<F: Future>(future: F) -> F::Output {
    let mut future = std::pin::pin!(future);
    let mut context = Context::from_waker(Waker::noop());
    for _ in 0..1_000_000 {
        if let Poll::Ready(result) = future.as_mut().poll(&mut context) {
            return result;
        }
    }
    panic!("completion-state future did not finish");
}

fn state(limit: usize) -> (SharedState, StorageBudget) {
    let budget = StorageBudget::new(limit);
    (State::with_memory(budget.clone()).shared(), budget)
}
fn put(state: &SharedState, name: &str, words: &str, cancel: &Cancel) -> Result<(), Error> {
    let spec = Spec {
        text: [None, Some(words), None, None, None, None, None],
        ..Spec::default()
    };
    let spec = StoredSpec::retain(spec, &state.borrow())?;
    let table = state.borrow().completions.clone();
    let mut work = Work::new(1_000_000, 1_000_000, 1024);
    let updated =
        block_on(table.updated(Target::Name(name), Some(spec), state, cancel, &mut work))?;
    state.borrow_mut().completions = updated;
    Ok(())
}
fn retained(table: &CompletionTable) -> usize {
    let Some(value) = &table.retained else {
        return 0;
    };
    let mut bytes = box_bytes::<Retained>() + value.entries.capacity() * size_of::<Entry>();
    for entry in &value.entries {
        bytes += entry.key.bytes() + box_bytes::<StoredSpec>();
        bytes += entry
            .spec
            .text
            .iter()
            .flatten()
            .map(String::capacity)
            .sum::<usize>();
    }
    bytes
}
#[test]
fn charges_all_table_and_spec_storage_and_refunds_on_clear() {
    let (state, budget) = state(4096);
    put(&state, "cmd", "one two", &Cancel::new())
        .ok()
        .expect("completion update succeeds");
    assert_eq!(
        budget.observation().0,
        retained(&state.borrow().completions)
    );
    put(&state, "other", "three", &Cancel::new())
        .ok()
        .expect("completion update succeeds");
    assert_eq!(
        budget.observation().0,
        retained(&state.borrow().completions)
    );
    state.borrow_mut().completions.clear();
    assert_eq!(budget.observation().0, 0);
    assert!(state.borrow().completions.initialized);
}
#[test]
fn snapshots_share_storage_but_isolate_subsequent_replacement() {
    let (state, budget) = state(100_000);
    put(&state, "cmd", "parent", &Cancel::new())
        .ok()
        .expect("completion update succeeds");
    let charge = budget.observation().0;
    let mut work = Work::new(1_000_000, 1_000_000, 1024);
    let child = block_on(State::snapshot(&state, &Cancel::new(), &mut work))
        .ok()
        .expect("snapshot succeeds")
        .shared();
    assert_eq!(budget.observation().0, charge);
    put(&child, "cmd", "child", &Cancel::new())
        .ok()
        .expect("completion update succeeds");
    let parent = state.borrow().completions.clone();
    let child_table = child.borrow().completions.clone();
    assert_eq!(parent.entry(0).1.view().text[1], Some("parent"));
    assert_eq!(child_table.entry(0).1.view().text[1], Some("child"));
    drop((child, child_table, parent));
    assert_eq!(budget.observation().0, charge);
}
#[test]
fn rejected_changes_leave_the_table_and_charge_unchanged() {
    let (state, budget) = state(1024);
    put(&state, "cmd", "kept", &Cancel::new())
        .ok()
        .expect("completion update succeeds");
    let charge = budget.observation().0;
    assert!(put(&state, "too_large", &"x".repeat(1024), &Cancel::new()).is_err());
    assert_eq!(
        state.borrow().completions.entry(0).1.view().text[1],
        Some("kept")
    );
    assert_eq!(budget.observation().0, charge);
    let cancel = Cancel::new();
    cancel.cancel();
    assert!(matches!(
        put(&state, "cmd", "cancelled", &cancel),
        Err(Error::Status(130))
    ));
    assert_eq!(budget.observation().0, charge);
}
#[test]
fn exhausted_scan_never_publishes_a_partial_table() {
    let (state, budget) = state(4096);
    put(&state, "long-command", "kept", &Cancel::new())
        .ok()
        .expect("completion update succeeds");
    let charge = budget.observation().0;
    let table = state.borrow().completions.clone();
    let mut work = Work::new(1, 4096, 1024);
    let result =
        block_on(table.updated(Target::Name("new"), None, &state, &Cancel::new(), &mut work));
    assert!(result.is_err());
    assert_eq!(state.borrow().completions.len(), 1);
    assert_eq!(budget.observation().0, charge);
}
