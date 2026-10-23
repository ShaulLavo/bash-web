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
    fn charged(link: &Link) -> usize {
        let Some(node) = link else {
            return 0;
        };
        let entry = &node.entry;
        boxed::<Node>()
            + boxed::<Entry>()
            + entry.name.capacity()
            + entry.path.capacity()
            + charged(&node.left)
            + charged(&node.right)
    }
    charged(&table.root)
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
        state.borrow().command_hash.root.as_ref().unwrap(),
        child.borrow().command_hash.root.as_ref().unwrap()
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
    let offset = pending_offset(&state, &budget, charge);
    for cancelled in [true, false] {
        let cancel = Cancel::new();
        let mut work = offset_work(offset);
        let mut pending = Box::pin(update(&state, "new", Some("/path"), &cancel, &mut work));
        poll_until_allocated(pending.as_mut(), &budget, charge);
        if cancelled {
            cancel.cancel();
            assert!(matches!(block_on(pending), Err(Error::Status(130))));
        } else {
            drop(pending);
        }
        assert_eq!(budget.observation().0, charge);
    }
    assert_eq!(state.borrow().command_hash.entries().len(), 600);
}

/// Updates do bounded work after admitting their entry, so the cooperative
/// yield lands there only for some starting positions within a quantum.
fn pending_offset(state: &SharedState, budget: &StorageBudget, charge: usize) -> usize {
    (0..64)
        .find(|&offset| {
            let table = state.borrow().command_hash.clone();
            let mut work = offset_work(offset);
            let cancel = Cancel::new();
            let mut pending =
                Box::pin(table.updated("new", Some("/path"), state, &cancel, &mut work));
            allocated_while_pending(pending.as_mut(), budget, charge)
        })
        .expect("some alignment leaves an update pending with admitted storage")
}
fn offset_work(offset: usize) -> Work {
    let mut work = work();
    for _ in 0..offset {
        block_on(work.checkpoint(&Cancel::new()))
            .ok()
            .expect("offset work");
    }
    work
}
fn allocated_while_pending<F: Future>(
    mut future: std::pin::Pin<&mut F>,
    budget: &StorageBudget,
    initial: usize,
) -> bool {
    let mut context = Context::from_waker(Waker::noop());
    while future.as_mut().poll(&mut context).is_pending() {
        if budget.observation().0 > initial {
            return true;
        }
    }
    false
}

fn poll_until_allocated<F: Future>(
    future: std::pin::Pin<&mut F>,
    budget: &StorageBudget,
    initial: usize,
) {
    assert!(
        allocated_while_pending(future, budget, initial),
        "update never yielded with admitted temporary storage"
    );
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
fn costs(names: &[String], absent: &str) -> Costs {
    let (state, budget) = state(40_000_000);
    let insert = names
        .iter()
        .map(|name| measured_update(&state, name, Some("/kept")))
        .sum();
    let table = state.borrow().command_hash.clone();
    let mut fuel = Work::new(100_000_000, 1_000_000, 1024);
    for _ in names {
        assert!(
            block_on(table.find(absent, &Cancel::new(), &mut fuel))
                .ok()
                .expect("missing lookup")
                .is_none()
        );
    }
    let missing = 100_000_000 - fuel.remaining;
    drop(table);
    let replace = measured_update(&state, &names[0], Some("/new"));
    let delete = measured_update(&state, &names[0], None);
    eprintln!(
        "HASH_COST n={} insert={insert} missing={missing} replace={replace} delete={delete} retained={}",
        names.len(),
        budget.observation().0
    );
    Costs {
        insert,
        missing,
        replace,
        delete,
    }
}
fn assert_doubling(samples: &[Costs]) {
    for pair in samples.windows(2) {
        let [small, large] = pair else { unreachable!() };
        assert!(large.insert * 10 < small.insert * 27, "insert {pair:?}");
        assert!(large.missing * 10 < small.missing * 27, "missing {pair:?}");
        assert!(large.replace * 10 < small.replace * 15, "replace {pair:?}");
        assert!(large.delete * 10 < small.delete * 15, "delete {pair:?}");
    }
}
#[test]
fn command_hash_doubling_scales_with_indexed_paths_not_whole_tables() {
    let samples = [128, 256, 512, 1024].map(|count| {
        let names: Vec<_> = (0..count).map(|i| format!("q{i:05}")).collect();
        costs(&names, "absent")
    });
    assert_doubling(&samples);
}
#[test]
fn command_hash_doubling_stays_logarithmic_within_one_bucket() {
    let target = slot("q00000");
    let colliding: Vec<_> = (0..)
        .map(|i| format!("c{i:06}"))
        .filter(|name| slot(name) == target)
        .take(1025)
        .collect();
    let (absent, names) = colliding.split_last().unwrap();
    let samples = [128, 256, 512, 1024].map(|count| costs(&names[..count], absent));
    assert_doubling(&samples);
}
#[test]
fn command_hash_matches_bucket_newest_first_model_and_stays_balanced() {
    let (state, budget) = state(10_000_000);
    let mut model: Vec<(String, String)> = Vec::new();
    let mut seed = 0x2545_f491u32;
    for step in 0..3000 {
        seed ^= seed << 13;
        seed ^= seed >> 17;
        seed ^= seed << 5;
        let name = format!("n{}", seed % 300);
        let delete = seed.is_multiple_of(5);
        let path = format!("/p{step}");
        let path = (!delete).then_some(path.as_str());
        block_on(update(&state, &name, path, &Cancel::new(), &mut work()))
            .ok()
            .expect("model update");
        apply_model(&mut model, &name, path);
        let table = state.borrow().command_hash.clone();
        let listed: Vec<_> = table
            .entries()
            .iter()
            .map(|entry| (entry.name.clone(), entry.path.clone()))
            .collect();
        assert_eq!(listed, model, "step {step}");
        assert_eq!(table.len, model.len());
        balanced_height(&table.root);
        assert_eq!(budget.observation().0, retained(&table));
    }
}
/// The previous ordered-vector semantics: bucket order, newest insertion
/// first within a bucket, replacement in place.
fn apply_model(model: &mut Vec<(String, String)>, name: &str, path: Option<&str>) {
    let found = model.iter().position(|(key, _)| key == name);
    match (found, path) {
        (Some(index), Some(path)) => model[index].1 = path.into(),
        (Some(index), None) => {
            model.remove(index);
        }
        (None, Some(path)) => {
            let at = model
                .iter()
                .position(|(key, _)| slot(key) >= slot(name))
                .unwrap_or(model.len());
            model.insert(at, (name.into(), path.into()));
        }
        (None, None) => {}
    }
}
fn balanced_height(link: &Link) -> u8 {
    let Some(node) = link else {
        return 0;
    };
    let (left, right) = (balanced_height(&node.left), balanced_height(&node.right));
    assert!(left.abs_diff(right) <= 1);
    assert_eq!(node.height, 1 + left.max(right));
    node.height
}

#[test]
fn command_hash_listing_reserves_traversal_and_sort_comparisons() {
    let target = slot("q00000");
    let names: Vec<_> = (0..)
        .map(|i| format!("c{i:06}"))
        .filter(|name| slot(name) == target)
        .take(2048)
        .collect();
    for count in [20, 0, 1, 2, 10, 16, 21, 32, 64, 128, 256, 512, 1024, 2048] {
        let (state, budget) = state(2_000_000);
        for name in &names[..count] {
            put(&state, name, "/kept");
        }
        let table = state.borrow().command_hash.clone();
        let before = budget.observation().0;
        let mut entries = Vec::new();
        if let Some(root) = &table.root {
            root.collect(&mut entries);
        }
        let mut comparisons = 0;
        sort_listing(&mut entries, |a, b| {
            comparisons += 1;
            a.bucket.cmp(&b.bucket).then(b.serial.cmp(&a.serial))
        });
        let mut fuel = work();
        let listing = block_on(table.listed(&state, &Cancel::new(), &mut fuel))
            .ok()
            .expect("admitted listing");
        assert!(
            listing
                .entries()
                .iter()
                .zip(&entries)
                .all(|(a, b)| Rc::ptr_eq(a, b))
        );
        assert!(
            listing
                .entries()
                .iter()
                .map(|entry| &entry.name)
                .eq(names[..count].iter().rev())
        );
        let charged = 1_000_000 - fuel.remaining;
        let actual = count + comparisons;
        eprintln!("HASH_LISTING n={count} charged={charged} visits_plus_comparisons={actual}");
        assert!(
            charged >= actual,
            "listing charged {charged}, synchronous visits and comparisons {actual}"
        );
        drop(listing);
        assert_eq!(budget.observation().0, before);
    }
}
