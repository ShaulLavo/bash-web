//! Durable indexed writes against recorded Bash 5.3.15 controls, and their
//! ownership under assignment rollback, prefixes, sharing and exhaustion.
use super::*;
use crate::exec::StorageBudget;
use futures::task::noop_waker;
use std::{future::Future, task::Context};

const FIXTURE: &str =
    include_str!("../../../../scripts/fixtures/shell-indexed-durable-writes.json");

fn bash(id: &str) -> String {
    let fixture: serde_json::Value = serde_json::from_str(FIXTURE).unwrap();
    assert_eq!(fixture["bash"], "5.3.15(1)-release");
    let case = fixture["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["id"] == id)
        .unwrap_or_else(|| panic!("recorded control {id}"));
    case["stdout"].as_str().unwrap().to_owned()
}

fn finish<T>(future: impl Future<Output = T>) -> T {
    let mut future = Box::pin(future);
    let waker = noop_waker();
    let mut context = Context::from_waker(&waker);
    for _ in 0..100_000 {
        if let std::task::Poll::Ready(value) = future.as_mut().poll(&mut context) {
            return value;
        }
    }
    panic!("bounded durable write did not finish");
}

fn work() -> Work {
    Work::new(1 << 24, 1 << 24, 0)
}

fn status(error: Error) -> i32 {
    match error {
        Error::Status(status) => status,
        _ => 2,
    }
}

/// `name[index]=value` as an arithmetic consumer publishes it.
fn element(state: &SharedState, name: &str, index: i64, value: &str) -> Result<(), i32> {
    let index = state.borrow().indexed_write_index(name, index).ok_or(1)?;
    let mut work = work();
    let cancel = Cancel::new();
    let admitted =
        State::admit_indexed_element(state, name, index, value.len(), &cancel, &mut work);
    finish(admitted).map_err(status)?;
    state
        .borrow_mut()
        .assign_indexed_element(name.into(), index, value.into())
}

/// `read -a name` or `mapfile name` with these fields.
fn replace(state: &SharedState, name: &str, fields: &[&str]) -> Result<(), i32> {
    let mut work = work();
    finish(State::admit_indexed_replacement(
        state,
        name,
        &Cancel::new(),
        &mut work,
    ))
    .map_err(status)?;
    state
        .borrow_mut()
        .assign_indexed(name.into(), values(fields))
}

fn scalar(state: &SharedState, name: &str, value: &str) {
    state
        .borrow_mut()
        .assign_parameter(name.into(), value.into())
        .unwrap();
}

/// Bash's `declare -p` for the plain values these controls use.
fn declare(state: &SharedState, name: &str) -> String {
    let state = state.borrow();
    let mut flags = String::new();
    let binding = state.bindings().get(name).unwrap();
    let indexed = matches!(binding, Binding::Indexed(_));
    if indexed {
        flags.push('a');
    }
    if state.is_readonly(name) {
        flags.push('r');
    }
    if state.exported_bindings().contains(name) {
        flags.push('x');
    }
    if flags.is_empty() {
        flags.push('-');
    }
    if !indexed {
        return format!("declare -{flags} {name}=\"{}\"\n", binding.as_str());
    }
    let mut elements = Vec::new();
    let mut previous = None;
    while let Some((index, value)) = binding.next(previous) {
        elements.push(format!("[{index}]=\"{value}\""));
        previous = Some(index);
    }
    format!("declare -{flags} {name}=({})\n", elements.join(" "))
}

fn journal_update(
    state: &SharedState,
    completed: &mut AssignmentFrame,
    name: &str,
    update: BindingUpdate,
) {
    let mut work = work();
    let (_, storage) = state
        .borrow()
        .admit_binding_update(name, &update, &mut work)
        .unwrap_or_else(|_| panic!("short update fits"));
    let retained = update.undo_bytes(state.borrow().binding(name));
    completed
        .reserve(name, retained)
        .unwrap_or_else(|_| panic!("undo fits"));
    let frame = PrefixFrame::enter(state.clone());
    frame.reserve(name, storage).unwrap();
    frame
        .commit_update(name.into(), update, completed)
        .unwrap_or_else(|_| panic!("admitted update fits"));
}

fn values(fields: &[&str]) -> Indexed {
    run(0, fields)
}

/// Consecutive elements from `first`, as a compound append stages them.
fn run(first: i64, fields: &[&str]) -> Indexed {
    let mut values = Indexed::default();
    for (offset, field) in fields.iter().enumerate() {
        values.insert(first + offset as i64, (*field).into());
    }
    values
}

fn enter(state: &SharedState) -> AssignmentFrame {
    AssignmentFrame::enter(state.clone()).unwrap_or_else(|_| panic!("journal fits"))
}

#[test]
fn element_writes_convert_unset_and_scalar_bindings_like_bash() {
    let state = State::default().shared();
    element(&state, "u", 3, "1").unwrap();
    assert_eq!(declare(&state, "u"), bash("unset-becomes-array"));
    scalar(&state, "t", "str");
    element(&state, "t", 2, "5").unwrap();
    assert_eq!(declare(&state, "t"), bash("scalar-keeps-element-zero"));
    scalar(&state, "s", "str");
    element(&state, "s", 0, "5").unwrap();
    assert_eq!(
        declare(&state, "s"),
        bash("scalar-index-zero-becomes-array")
    );
    state
        .borrow_mut()
        .export("e".into(), Some("1".into()))
        .unwrap();
    element(&state, "e", 1, "2").unwrap();
    assert_eq!(declare(&state, "e"), bash("exported-scalar-becomes-array"));
    assert!(!state.borrow().environment().contains_key("e"));
}

#[test]
fn element_writes_resolve_namerefs_and_reject_readonly_and_cycles() {
    let state = State::default().shared();
    replace(&state, "a", &["1", "2"]).unwrap();
    for (name, target) in [("r", "a"), ("r2", "r")] {
        state
            .borrow_mut()
            .declare_nameref(name.into(), target.into(), false)
            .unwrap();
    }
    element(&state, "r2", 4, "8").unwrap();
    assert_eq!(declare(&state, "a"), bash("nameref-chain"));

    replace(&state, "ro", &["1", "2"]).unwrap();
    state.borrow_mut().readonly("ro".into(), None).unwrap();
    assert_eq!(element(&state, "ro", 1, "3"), Err(1));
    assert_eq!(replace(&state, "ro", &["x"]), Err(1));
    let recorded = bash("readonly-rejected");
    assert_eq!(format!("st=1\n{}", declare(&state, "ro")), recorded);
    assert!(bash("read-a-readonly").starts_with("st=1\n"));

    for (name, target) in [("c1", "c2"), ("c2", "c1")] {
        state
            .borrow_mut()
            .declare_nameref(name.into(), target.into(), false)
            .unwrap();
    }
    assert_eq!(element(&state, "c1", 1, "2"), Err(1));
    assert!(!state.borrow().bindings().contains_key("c1"));
}

#[test]
fn element_writes_follow_dynamic_scope_and_function_return_restores_caller() {
    let memory = StorageBudget::new(65_536);
    let state = State::with_memory(memory.clone()).shared();
    replace(&state, "a", &["g"]).unwrap();
    let function = FunctionFrame::enter(state.clone(), Vec::new(), usize::MAX).unwrap();
    state.borrow_mut().local("a".into(), "1".into()).unwrap();
    let callee = FunctionFrame::enter(state.clone(), Vec::new(), usize::MAX).unwrap();
    element(&state, "a", 2, "3").unwrap();
    drop(callee);
    let inside = declare(&state, "a");
    drop(function);
    assert_eq!(
        format!("{inside}{}", declare(&state, "a")),
        bash("dynamic-local")
    );
    assert_eq!(memory.observation().0, 0);
}

#[test]
fn negative_write_subscripts_count_back_from_the_last_element() {
    let state = State::default().shared();
    replace(&state, "a", &["1", "2", "3"]).unwrap();
    element(&state, "a", -1, "9").unwrap();
    let recorded = bash("negative-index");
    assert!(recorded.starts_with(&declare(&state, "a")));
    assert_eq!(state.borrow().indexed_write_index("a", -5), None);
    assert_eq!(state.borrow().indexed_write_index("missing", -1), None);
    assert_eq!(
        state
            .borrow_mut()
            .assign_indexed_element("a".into(), -1, "x".into()),
        Err(2)
    );
}

#[test]
fn optind_element_and_replacement_writes_keep_the_getopts_cursor() {
    assert_eq!(bash("optind-element-keeps-cursor"), "b 3\n");
    assert_eq!(bash("read-a-optind-keeps-cursor"), "b 3\n");
    let state = State::default().shared();
    state.borrow_mut().getopts.index = 2;
    element(&state, "OPTIND", 0, "3").unwrap();
    assert_eq!(state.borrow().getopts.index, 2);
    replace(&state, "OPTIND", &["3"]).unwrap();
    assert_eq!(state.borrow().getopts.index, 2);
}

#[test]
fn replacements_match_read_a_and_mapfile() {
    let state = State::default().shared();
    replace(&state, "a", &["1", "2", "3"]).unwrap();
    replace(&state, "a", &["x", "y"]).unwrap();
    assert_eq!(declare(&state, "a"), bash("read-a-replaces"));
    replace(&state, "a", &[]).unwrap();
    assert_eq!(declare(&state, "a"), bash("read-a-empty"));

    let memory = StorageBudget::new(65_536);
    let state = State::with_memory(memory.clone()).shared();
    replace(&state, "m", &["g"]).unwrap();
    let function = FunctionFrame::enter(state.clone(), Vec::new(), usize::MAX).unwrap();
    state.borrow_mut().declare_local("m".into(), None).unwrap();
    replace(&state, "m", &["x", "y"]).unwrap();
    let inside = declare(&state, "m");
    drop(function);
    assert_eq!(
        format!("{inside}{}", declare(&state, "m")),
        bash("mapfile-local")
    );
    assert_eq!(memory.observation().0, 0);

    state
        .borrow_mut()
        .declare_nameref("r".into(), "m".into(), false)
        .unwrap();
    replace(&state, "r", &["x", "y"]).unwrap();
    assert_eq!(declare(&state, "m"), bash("mapfile-nameref"));
}

#[test]
fn prefix_element_writes_change_the_variable_that_outlives_the_prefix() {
    for (id, initial) in [
        ("prefix-saved-array", Some(&["o", "p"][..])),
        ("prefix-saved-scalar", None),
    ] {
        let state = State::default().shared();
        match initial {
            Some(fields) => replace(&state, "a", fields).unwrap(),
            None => scalar(&state, "a", "g"),
        }
        let frame = PrefixFrame::enter(state.clone());
        frame.set("a".into(), "tmp".into()).unwrap();
        let temporary = state.borrow().bindings()["a"].clone();
        element(&state, "a", 1, "5").unwrap();
        // Bash's later RHS still sees only the temporary ("prefix-later-rhs-saved").
        assert_eq!(state.borrow().bindings()["a"], temporary);
        drop(frame);
        assert_eq!(declare(&state, "a"), bash(id));
    }
    let state = State::default().shared();
    let frame = PrefixFrame::enter(state.clone());
    frame.set("a".into(), "tmp".into()).unwrap();
    element(&state, "a", 1, "5").unwrap();
    let a = state.borrow().binding("a").cloned().unwrap();
    let seen = format!(
        "{}|{}|{}\n",
        a.slot(1).map_or("", String::as_str),
        a.slot(0).map_or("", String::as_str),
        a.count()
    );
    assert_eq!(seen, bash("prefix-later-rhs-temporary"));
    drop(frame);
    assert!(!state.borrow().bindings().contains_key("a"));
    assert_eq!(bash("prefix-unset-temporary"), "");
}

#[test]
fn kept_assignment_commands_keep_journaled_and_durable_writes() {
    let state = State::default().shared();
    replace(&state, "a", &["o", "p"]).unwrap();
    let mut completed = enter(&state);
    journal_update(
        &state,
        &mut completed,
        "a",
        BindingUpdate::Element {
            index: 1,
            value: "q".into(),
        },
    );
    element(&state, "a", 3, "5").unwrap();
    completed.keep();
    drop(completed);
    assert!(bash("assignment-only-keeps-both").starts_with(&declare(&state, "a")));

    replace(&state, "a", &["o"]).unwrap();
    let mut completed = enter(&state);
    journal_update(
        &state,
        &mut completed,
        "a",
        BindingUpdate::Append(run(1, &["x", "y"])),
    );
    element(&state, "a", 2, "5").unwrap();
    element(&state, "a", 9, "6").unwrap();
    completed.keep();
    drop(completed);
    assert_eq!(
        declare(&state, "a"),
        bash("assignment-only-append-then-element")
    );

    replace(&state, "a", &["o", "p"]).unwrap();
    let mut completed = enter(&state);
    element(&state, "a", 1, "5").unwrap();
    journal_update(
        &state,
        &mut completed,
        "a",
        BindingUpdate::Replace(Binding::Indexed(Rc::new(values(&["x", "y"])))),
    );
    completed.keep();
    drop(completed);
    assert_eq!(declare(&state, "a"), bash("assignment-only-replace-after"));
}

/// Rollback undoes the command's own writes and keeps durable ones.
#[test]
fn rollback_keeps_durable_elements_over_every_inverse_kind() {
    let state = State::default().shared();
    // Same-slot and unrelated-slot element inverses, on an original scalar.
    scalar(&state, "s", "str");
    let mut completed = enter(&state);
    journal_update(
        &state,
        &mut completed,
        "s",
        BindingUpdate::Element {
            index: 1,
            value: "q".into(),
        },
    );
    journal_update(
        &state,
        &mut completed,
        "s",
        BindingUpdate::Element {
            index: 2,
            value: "r".into(),
        },
    );
    element(&state, "s", 2, "5").unwrap();
    drop(completed);
    assert_eq!(
        declare(&state, "s"),
        "declare -a s=([0]=\"str\" [2]=\"5\")\n"
    );

    // Restore(None) and Restore(Some(Scalar)) images.
    let mut completed = enter(&state);
    journal_update(
        &state,
        &mut completed,
        "u",
        BindingUpdate::Replace("x".into()),
    );
    element(&state, "u", 3, "1").unwrap();
    scalar(&state, "t", "str");
    journal_update(
        &state,
        &mut completed,
        "t",
        BindingUpdate::Replace("y".into()),
    );
    element(&state, "t", 2, "5").unwrap();
    drop(completed);
    assert_eq!(declare(&state, "u"), bash("unset-becomes-array"));
    assert_eq!(declare(&state, "t"), bash("scalar-keeps-element-zero"));

    // An appended run keeps a durable slot inside it and one beyond it.
    replace(&state, "a", &["o"]).unwrap();
    let mut completed = enter(&state);
    journal_update(
        &state,
        &mut completed,
        "a",
        BindingUpdate::Append(run(1, &["x", "y", "z"])),
    );
    element(&state, "a", 2, "5").unwrap();
    element(&state, "a", 9, "6").unwrap();
    drop(completed);
    assert_eq!(
        declare(&state, "a"),
        "declare -a a=([0]=\"o\" [2]=\"5\" [9]=\"6\")\n"
    );

    // A durable replacement supersedes earlier inverses.
    let mut completed = enter(&state);
    journal_update(
        &state,
        &mut completed,
        "a",
        BindingUpdate::Element {
            index: 0,
            value: "q".into(),
        },
    );
    replace(&state, "a", &["x", "y"]).unwrap();
    journal_update(
        &state,
        &mut completed,
        "a",
        BindingUpdate::Element {
            index: 1,
            value: "w".into(),
        },
    );
    drop(completed);
    assert_eq!(declare(&state, "a"), bash("read-a-replaces"));
}

#[test]
fn durable_write_to_a_shared_array_copies_once_and_leaves_the_snapshot() {
    let state = State::default().shared();
    replace(&state, "a", &["o", "p"]).unwrap();
    let mut work = work();
    let child = finish(State::snapshot(&state, &Cancel::new(), &mut work))
        .unwrap_or_else(|_| panic!("snapshot fits"));
    let address = |state: &State| match &state.variables["a"] {
        Binding::Indexed(values) => Rc::as_ptr(values),
        Binding::Scalar(_) => panic!("array expected"),
    };
    let shared = address(&child);
    assert_eq!(address(&state.borrow()), shared);
    element(&state, "a", 1, "5").unwrap();
    let copied = address(&state.borrow());
    assert_ne!(copied, shared);
    element(&state, "a", 2, "6").unwrap();
    assert_eq!(address(&state.borrow()), copied);
    assert_eq!(child.variables["a"].slot(1).map(String::as_str), Some("p"));
    assert_eq!(state.borrow().array_element("a", 1), Some("5"));
}

#[test]
fn five_thousand_element_writes_reuse_one_unique_array() {
    let memory = StorageBudget::new(1 << 22);
    let state = State::with_memory(memory.clone()).shared();
    let function = FunctionFrame::enter(state.clone(), Vec::new(), usize::MAX).unwrap();
    state.borrow_mut().declare_local("a".into(), None).unwrap();
    element(&state, "a", 0, "0").unwrap();
    let address = match &state.borrow().variables["a"] {
        Binding::Indexed(values) => Rc::as_ptr(values),
        Binding::Scalar(_) => panic!("array expected"),
    };
    let mut work = work();
    let before = work.storage_left();
    for index in 1..5000 {
        finish(State::admit_indexed_element(
            &state,
            "a",
            index,
            1,
            &Cancel::new(),
            &mut work,
        ))
        .unwrap_or_else(|_| panic!("write fits"));
        state
            .borrow_mut()
            .assign_indexed_element("a".into(), index, "x".into())
            .unwrap();
    }
    // Per write: at most one new tree slot, never a copy of the array.
    assert!(before - work.storage_left() < 5000 * Binding::node_bytes());
    assert_eq!(state.borrow().array_count("a"), 5000);
    let live = match &state.borrow().variables["a"] {
        Binding::Indexed(values) => Rc::as_ptr(values),
        Binding::Scalar(_) => panic!("array expected"),
    };
    assert_eq!(live, address);
    let storage = state.borrow().binding("a").unwrap().storage_bytes();
    assert_eq!(state.borrow().held_local_value("a"), storage);
    drop(function);
    assert_eq!(memory.observation().0, 0);
}

/// A rejected write changes no value, ticket, journal or saved prefix.
#[test]
fn exhausted_session_storage_rejects_without_partial_effects() {
    let limit = 65_536;
    let memory = StorageBudget::new(limit);
    let state = State::with_memory(memory.clone()).shared();
    let function = FunctionFrame::enter(state.clone(), Vec::new(), usize::MAX).unwrap();
    state.borrow_mut().local("a".into(), "o".into()).unwrap();
    let mut completed = enter(&state);
    journal_update(
        &state,
        &mut completed,
        "a",
        BindingUpdate::Element {
            index: 1,
            value: "q".into(),
        },
    );
    let before = state.borrow().binding("a").cloned();
    let held = state.borrow().held_local_value("a");
    let filler = memory.admit(limit - memory.observation().0).unwrap();
    let used = memory.observation().0;
    assert_eq!(
        element(&state, "a", 7, "durable"),
        Err(crate::exec::RESOURCE_STATUS)
    );
    assert_eq!(
        element(&state, "a", 1, "durable"),
        Err(crate::exec::RESOURCE_STATUS)
    );
    assert_eq!(
        replace(&state, "a", &["x"; 64]),
        Err(crate::exec::RESOURCE_STATUS)
    );
    assert_eq!(state.borrow().binding("a").cloned(), before);
    assert_eq!(state.borrow().held_local_value("a"), held);
    assert_eq!(memory.observation().0, used);
    drop(filler);
    drop(completed);
    assert_eq!(declare(&state, "a"), "declare -- a=\"o\"\n");
    drop(function);
    assert_eq!(memory.observation().0, 0);
}

/// PR 1's crash with a durable element write in place of the scalar one.
#[test]
fn rollback_after_durable_element_write_under_exhausted_budget_refunds_exactly() {
    let limit = 65_536;
    let memory = StorageBudget::new(limit);
    let state = State::with_memory(memory.clone()).shared();
    let function = FunctionFrame::enter(state.clone(), Vec::new(), usize::MAX).unwrap();
    state
        .borrow_mut()
        .local("a".into(), "local".into())
        .unwrap();
    let mut large = String::with_capacity(8192);
    large.push('z');
    let mut seed = values(&["zero"]);
    seed.insert(9, large);
    let mut kept = enter(&state);
    journal_update(
        &state,
        &mut kept,
        "a",
        BindingUpdate::Replace(Binding::Indexed(Rc::new(seed))),
    );
    kept.keep();
    drop(kept);
    let mut completed = enter(&state);
    journal_update(
        &state,
        &mut completed,
        "a",
        BindingUpdate::Element {
            index: 9,
            value: "small".into(),
        },
    );
    journal_update(
        &state,
        &mut completed,
        "a",
        BindingUpdate::Append(run(10, &["x"])),
    );
    element(&state, "a", 0, "durable").unwrap();
    element(&state, "a", 10, "kept").unwrap();
    let filler = memory.admit(limit - memory.observation().0).unwrap();
    drop(completed);
    {
        let state = state.borrow();
        let a = state.binding("a").unwrap();
        assert_eq!(a.slot(9).unwrap().capacity(), 8192);
        assert_eq!(a.slot(0).map(String::as_str), Some("durable"));
        assert_eq!(a.slot(10).map(String::as_str), Some("kept"));
        assert_eq!(a.count(), 3);
        assert_eq!(state.held_local_value("a"), a.storage_bytes());
    }
    drop(filler);
    drop(function);
    assert_eq!(memory.observation().0, 0);
}
