use super::*;
use crate::{exec::StorageBudget, state::State};
use std::{
    future::Future,
    task::{Context, Poll, Waker},
};

fn drive<F: Future>(mut future: std::pin::Pin<&mut F>, turns: usize) -> Poll<F::Output> {
    let mut context = Context::from_waker(Waker::noop());
    for _ in 0..turns {
        let outcome = future.as_mut().poll(&mut context);
        if outcome.is_ready() {
            return outcome;
        }
    }
    Poll::Pending
}
fn block_on<F: Future>(future: F) -> F::Output {
    match drive(std::pin::pin!(future), 1_000_000) {
        Poll::Ready(value) => value,
        Poll::Pending => panic!("hash future exceeded its turn bound"),
    }
}
fn slot(name: &str) -> u32 {
    block_on(bucket(name, &Cancel::new(), &mut work()))
        .ok()
        .expect("bucket")
}
fn state(bytes: usize) -> (SharedState, StorageBudget) {
    let budget = StorageBudget::new(bytes);
    (State::with_memory(budget.clone()).shared(), budget)
}
fn work() -> Work {
    Work::new(1_000_000, 1_000_000, 1024)
}
async fn update(
    state: &SharedState,
    name: &str,
    path: Option<&str>,
    cancel: &Cancel,
    work: &mut Work,
) -> Result<(), Error> {
    let table = state.borrow().command_hash.clone();
    let next = table.updated(name, path, state, cancel, work).await?;
    state.borrow_mut().command_hash = next;
    Ok(())
}
fn put(state: &SharedState, name: &str, path: &str) {
    block_on(update(state, name, Some(path), &Cancel::new(), &mut work()))
        .ok()
        .expect("hash update");
}
fn retained(table: &CommandHash) -> usize {
    let Some(version) = &table.0 else {
        return 0;
    };
    boxed::<Version>()
        + version.entries.capacity() * size_of::<Rc<Entry>>()
        + version
            .entries
            .iter()
            .map(|entry| boxed::<Entry>() + entry.name.capacity() + entry.path.capacity())
            .sum::<usize>()
}
#[test]
fn command_hash_charges_actual_capacity_and_refunds_replacement_delete_reset() {
    let (state, budget) = state(8192);
    put(&state, "first", "/path one");
    put(&state, "second", "relative/path");
    assert_eq!(
        budget.observation().0,
        retained(&state.borrow().command_hash)
    );
    put(&state, "first", "/new");
    assert_eq!(
        budget.observation().0,
        retained(&state.borrow().command_hash)
    );
    block_on(update(&state, "second", None, &Cancel::new(), &mut work()))
        .ok()
        .expect("hash update");
    assert_eq!(
        budget.observation().0,
        retained(&state.borrow().command_hash)
    );
    state.borrow_mut().command_hash.clear();
    assert_eq!(budget.observation().0, 0);
}
#[test]
fn command_hash_snapshot_shares_entries_and_isolates_updates() {
    let (state, budget) = state(100_000);
    put(&state, "tool", "/parent");
    let charge = budget.observation().0;
    let child = block_on(State::snapshot(&state, &Cancel::new(), &mut work()))
        .ok()
        .expect("snapshot")
        .shared();
    assert_eq!(budget.observation().0, charge);
    assert!(Rc::ptr_eq(
        state.borrow().command_hash.0.as_ref().unwrap(),
        child.borrow().command_hash.0.as_ref().unwrap()
    ));
    put(&child, "tool", "/child");
    assert_eq!(state.borrow().command_hash.entries()[0].path, "/parent");
    assert_eq!(child.borrow().command_hash.entries()[0].path, "/child");
    state.borrow_mut().command_hash.clear();
    assert_eq!(
        budget.observation().0,
        retained(&child.borrow().command_hash)
    );
    drop(child);
    assert_eq!(budget.observation().0, 0);
}
#[test]
fn command_hash_failed_admission_or_work_does_not_publish_or_leak() {
    let (state, budget) = state(2048);
    put(&state, "tool", "/kept");
    let charge = budget.observation().0;
    let result = block_on(update(
        &state,
        "tool",
        Some(&"x".repeat(2048)),
        &Cancel::new(),
        &mut work(),
    ));
    assert!(matches!(result, Err(Error::Status(RESOURCE_STATUS))));
    let mut short = Work::new(1, 4096, 1024);
    assert!(
        block_on(update(
            &state,
            "other",
            Some("/new"),
            &Cancel::new(),
            &mut short
        ))
        .is_err()
    );
    assert_eq!(budget.observation().0, charge);
    assert_eq!(state.borrow().command_hash.entries()[0].path, "/kept");
}
#[test]
fn command_hash_cancel_and_drop_pending_updates_refund_all_unpublished_storage() {
    let (state, budget) = state(1_000_000);
    for index in 0..600 {
        put(&state, &format!("command{index}"), "/kept");
    }
    let charge = budget.observation().0;
    let cancel = Cancel::new();
    let mut work = work();
    let mut pending = Box::pin(update(&state, "new", Some("/path"), &cancel, &mut work));
    let mut context = Context::from_waker(Waker::noop());
    poll_until_allocated(pending.as_mut(), &mut context, &budget, charge);
    cancel.cancel();
    assert!(matches!(block_on(pending), Err(Error::Status(130))));
    assert_eq!(budget.observation().0, charge);
    let cancel = Cancel::new();
    let mut work = self::work();
    let mut pending = Box::pin(update(&state, "new", Some("/path"), &cancel, &mut work));
    poll_until_allocated(pending.as_mut(), &mut context, &budget, charge);
    drop(pending);
    assert_eq!(budget.observation().0, charge);
    assert_eq!(state.borrow().command_hash.entries().len(), 600);
}

fn poll_until_allocated<F: Future>(
    mut future: std::pin::Pin<&mut F>,
    context: &mut Context<'_>,
    budget: &StorageBudget,
    initial: usize,
) {
    for _ in 0..1000 {
        assert!(future.as_mut().poll(context).is_pending());
        if budget.observation().0 > initial {
            return;
        }
    }
    panic!("update never yielded with admitted temporary storage");
}

#[test]
fn command_hash_replacement_keeps_collision_order() {
    let (state, _) = state(100_000);
    let names: Vec<_> = (0..1000).map(|i| format!("tool{i}")).collect();
    let left = &names[0];
    let right = names
        .iter()
        .skip(1)
        .find(|name| slot(name) == slot(left))
        .unwrap();
    put(&state, left, "/first");
    put(&state, right, "/second");
    put(&state, left, "/updated");
    let state = state.borrow();
    let entries = state.command_hash.entries();
    assert_eq!(entries[0].name, *right);
    assert_eq!(entries[1].name, *left);
    assert_eq!(entries[1].path, "/updated");
}

#[test]
fn command_hash_lookup_admits_name_comparison_work() {
    let (state, budget) = state(8192);
    let name = "x".repeat(256);
    put(&state, &name, "/kept");
    let before = budget.observation().0;
    let table = state.borrow().command_hash.clone();
    let mut short = Work::new(name.len() + 2, 4096, 1024);
    let result = block_on(table.find(&name, &Cancel::new(), &mut short));
    assert!(matches!(result, Err(Error::Status(2))));
    assert_eq!(budget.observation().0, before);
    assert_eq!(table.entries()[0].path, "/kept");
}

#[test]
fn command_hash_reset_admission_is_atomic_and_refunds() {
    let (state, budget) = state(8192);
    put(&state, "one", "/one");
    put(&state, "two", "/two");
    let before = budget.observation().0;
    let table = state.borrow().command_hash.clone();
    let mut short = Work::new(1, 4096, 1024);
    assert!(matches!(
        block_on(table.cleared(&Cancel::new(), &mut short)),
        Err(Error::Status(2))
    ));
    let cancel = Cancel::new();
    cancel.cancel();
    assert!(matches!(
        block_on(table.cleared(&cancel, &mut work())),
        Err(Error::Status(130))
    ));
    assert_eq!(state.borrow().command_hash.entries().len(), 2);
    assert_eq!(budget.observation().0, before);
    let empty = block_on(table.cleared(&Cancel::new(), &mut work()))
        .ok()
        .expect("admitted reset");
    state.borrow_mut().command_hash = empty;
    drop(table);
    assert_eq!(budget.observation().0, 0);
}

#[derive(Debug)]
struct Costs {
    insert: usize,
    missing: usize,
    replace: usize,
    delete: usize,
}
fn measured_update(state: &SharedState, name: &str, path: Option<&str>) -> usize {
    let mut work = work();
    block_on(update(state, name, path, &Cancel::new(), &mut work))
        .ok()
        .expect("measured update");
    1_000_000 - work.remaining
}
fn costs(count: usize) -> Costs {
    let (state, budget) = state(20_000_000);
    let insert = (0..count)
        .map(|i| measured_update(&state, &format!("q{i:05}"), Some("/kept")))
        .sum();
    let table = state.borrow().command_hash.clone();
    let mut fuel = Work::new(100_000_000, 1_000_000, 1024);
    for _ in 0..count {
        assert!(
            block_on(table.find("absent", &Cancel::new(), &mut fuel))
                .ok()
                .expect("missing lookup")
                .is_none()
        );
    }
    let missing = 100_000_000 - fuel.remaining;
    drop(table);
    let replace = measured_update(&state, "q00000", Some("/new"));
    let delete = measured_update(&state, "q00000", None);
    eprintln!(
        "HASH_COST n={count} insert={insert} missing={missing} replace={replace} delete={delete} retained={}",
        budget.observation().0
    );
    Costs {
        insert,
        missing,
        replace,
        delete,
    }
}
#[test]
fn command_hash_doubling_scales_with_indexed_paths_not_whole_tables() {
    let samples = [128, 256, 512, 1024].map(costs);
    for pair in samples.windows(2) {
        let [small, large] = pair else { unreachable!() };
        assert!(large.insert * 10 < small.insert * 27, "insert {pair:?}");
        assert!(large.missing * 10 < small.missing * 27, "missing {pair:?}");
        assert!(large.replace * 10 < small.replace * 15, "replace {pair:?}");
        assert!(large.delete * 10 < small.delete * 15, "delete {pair:?}");
    }
}
