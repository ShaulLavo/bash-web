//! Original ownership regressions for binding operations and restoration policies.
use super::*;
use futures::{FutureExt, task::noop_waker};
use std::{future::Future, task::Context};

fn finish<T>(future: impl Future<Output = T>) -> T {
    let mut future = Box::pin(future);
    let waker = noop_waker();
    let mut context = Context::from_waker(&waker);
    for _ in 0..10_000 {
        if let std::task::Poll::Ready(value) = future.as_mut().poll(&mut context) {
            return value;
        }
    }
    panic!("bounded binding operation did not finish");
}

fn ifs_members(state: &SharedState) -> IfsMembers {
    let mut work = Work::new(256, 0, 0);
    finish(State::admit_ifs_members(state, &Cancel::new(), &mut work))
        .unwrap_or_else(|_| panic!("short IFS fits"))
}

fn builtin(state: &SharedState, assigned: &[(String, String)]) -> PrefixFrame {
    let mut work = Work::new(65_536, 65_536, 0);
    PrefixFrame::builtin(state.clone(), assigned, &Cancel::new(), &mut work)
        .now_or_never()
        .expect("short binding replay must not yield")
        .unwrap_or_else(|_| panic!("short binding replay fits"))
}

#[test]
fn cli_environment_replaces_defaults_and_adds_only_a_nonexported_default_path() {
    let mut state = State::default();
    state.initialize_cli_environment([("HOME".into(), "/home/test".into())]);
    assert_eq!(state.bindings().len(), 2);
    assert!(!state.bindings().contains_key("IFS"));
    assert_eq!(state.bindings()["PATH"], "/usr/bin:/bin");
    assert_eq!(
        state.environment(),
        BTreeMap::from([("HOME".into(), "/home/test".into())])
    );

    let mut inherited = State::default();
    inherited
        .initialize_cli_environment([("PATH".into(), String::new()), ("IFS".into(), ":".into())]);
    assert_eq!(inherited.bindings()["PATH"], "");
    assert_eq!(inherited.environment(), inherited.bindings().clone());
    assert_eq!(inherited.parameter("IFS"), ":");
}

#[test]
fn runtime_environment_extends_defaults_exports_ifs_and_does_not_invent_path() {
    let mut state = State::default();
    state.inherit_environment([("HOME".into(), "/home/test".into())]);
    assert_eq!(state.bindings().len(), 2);
    assert_eq!(state.bindings()["IFS"], " \t\n");
    assert!(!state.bindings().contains_key("PATH"));
    assert_eq!(state.environment(), state.bindings().clone());

    let mut inherited = State::default();
    inherited.inherit_environment([("IFS".into(), ":".into()), ("PATH".into(), String::new())]);
    assert_eq!(inherited.bindings()["IFS"], ":");
    assert_eq!(inherited.environment()["PATH"], "");
}

#[test]
fn binding_views_and_environment_do_not_resolve_aliases_or_special_parameters() {
    let mut state = State::default();
    state.initialize_cli_environment([
        ("PWD".into(), "/raw".into()),
        ("EPOCHREALTIME".into(), "raw-clock".into()),
        ("alias".into(), "raw-alias".into()),
        ("target".into(), "resolved".into()),
    ]);
    state
        .declare_nameref("alias".into(), "target".into(), false)
        .unwrap();
    assert_eq!(state.parameter("alias"), "resolved");
    assert!(!state.bindings().contains_key("alias"));
    assert_eq!(state.namerefs()["alias"], "target");
    assert!(!state.environment().contains_key("alias"));
    assert_eq!(state.environment()["PWD"], "/raw");
    assert_eq!(state.parameter("PWD"), "/home/guest");
    assert_eq!(state.environment()["EPOCHREALTIME"], "raw-clock");
    assert!(state.dynamic_parameter("EPOCHREALTIME"));
}

#[test]
fn expansion_checks_readonly_but_builtin_replay_and_restore_are_privileged() {
    let state = State::default().shared();
    state
        .borrow_mut()
        .readonly("locked".into(), Some("caller".into()))
        .unwrap();
    let expansion = PrefixFrame::enter(state.clone());
    assert_eq!(
        expansion.set("locked".into(), "rejected".into()),
        Err("locked".into())
    );
    assert_eq!(state.borrow().bindings()["locked"], "caller");
    drop(expansion);

    // Represents a target made readonly after prefix preparation. Replay does
    // not add a second validation phase; neither does privileged restoration.
    let frame = builtin(&state, &[("locked".into(), "prepared".into())]);
    assert_eq!(state.borrow().bindings()["locked"], "prepared");
    assert_eq!(
        state
            .borrow_mut()
            .assign_parameter("locked".into(), "bad".into()),
        Err(1)
    );
    drop(frame);
    assert_eq!(state.borrow().bindings()["locked"], "caller");
    assert!(state.borrow().is_readonly("locked"));
}

#[test]
fn builtin_restores_scalar_values_without_rolling_back_attributes_or_namerefs() {
    let state = State::default().shared();
    for name in ["value", "alias"] {
        state
            .borrow_mut()
            .assign_parameter(name.into(), "caller".into())
            .unwrap();
    }
    let frame = builtin(
        &state,
        &[
            ("value".into(), "temporary".into()),
            ("alias".into(), "temporary".into()),
        ],
    );
    state.borrow_mut().export("value".into(), None).unwrap();
    state.borrow_mut().readonly("value".into(), None).unwrap();
    state
        .borrow_mut()
        .declare_nameref("alias".into(), "target".into(), false)
        .unwrap();
    drop(frame);
    assert_eq!(state.borrow().bindings()["value"], "caller");
    assert!(state.borrow().exported_bindings().contains("value"));
    assert!(state.borrow().is_readonly("value"));
    assert_eq!(state.borrow().bindings()["alias"], "caller");
    assert_eq!(state.borrow().namerefs()["alias"], "target");
}

#[test]
fn builtin_ifs_replay_keeps_cache_while_expansion_refreshes_and_restores_it() {
    let state = State::default().shared();
    state
        .borrow_mut()
        .assign_parameter("sep".into(), ":".into())
        .unwrap();
    state
        .borrow_mut()
        .declare_nameref("IFS".into(), "sep".into(), false)
        .unwrap();
    let members = ifs_members(&state);
    assert!(members.contains(':'));
    let separator = state.borrow().star_separator;
    let frame = builtin(&state, &[("IFS".into(), ",".into())]);
    assert_eq!(state.borrow().parameter("IFS"), ",");
    assert_eq!(state.borrow().star_separator, separator);
    assert_eq!(state.borrow().cached_ifs_members(), Some(members));
    drop(frame);
    assert_eq!(state.borrow().parameter("IFS"), ":");
    assert_eq!(state.borrow().cached_ifs_members(), Some(members));

    let frame = PrefixFrame::enter(state.clone());
    frame.set("IFS".into(), ",".into()).unwrap();
    // The effective target is sep, not IFS: even expansion leaves the IFS
    // special-variable cache alone when writing through this alias.
    assert_eq!(state.borrow().cached_ifs_members(), Some(members));
    drop(frame);
    // A direct IFS binding is separately exercised without changing the alias.
    let direct = State::default().shared();
    direct
        .borrow_mut()
        .assign_parameter("IFS".into(), ":".into())
        .unwrap();
    let frame = PrefixFrame::enter(direct.clone());
    frame.set("IFS".into(), ",".into()).unwrap();
    assert_eq!(direct.borrow().positional_separator(), Some(','));
    drop(frame);
    assert_eq!(direct.borrow().positional_separator(), Some(':'));
}

#[test]
fn nested_builtin_clock_guards_only_restore_the_hook_they_suspended() {
    let state = State::default().shared();
    let outer = builtin(&state, &[("EPOCHREALTIME".into(), "outer".into())]);
    let inner = builtin(&state, &[("EPOCHREALTIME".into(), "inner".into())]);
    assert_eq!(state.borrow().parameter("EPOCHREALTIME"), "inner");
    drop(inner);
    assert!(!state.borrow().dynamic_parameter("EPOCHREALTIME"));
    assert_eq!(state.borrow().parameter("EPOCHREALTIME"), "outer");
    drop(outer);
    assert!(state.borrow().dynamic_parameter("EPOCHREALTIME"));
    assert!(!state.borrow().bindings().contains_key("EPOCHREALTIME"));
}

#[test]
fn builtin_inside_expansion_routes_durable_writes_to_only_the_last_expansion_save() {
    let state = State::default().shared();
    state
        .borrow_mut()
        .assign_parameter("x".into(), "caller".into())
        .unwrap();
    state
        .borrow_mut()
        .declare_nameref("alias".into(), "x".into(), false)
        .unwrap();
    let outer = PrefixFrame::enter(state.clone());
    outer.set("x".into(), "outer".into()).unwrap();
    let inner = PrefixFrame::enter(state.clone());
    inner.set("alias".into(), "inner".into()).unwrap();
    let frame = builtin(
        &state,
        &[
            ("alias".into(), "first".into()),
            ("x".into(), "last".into()),
        ],
    );
    assert_eq!(state.borrow().parameter("x"), "last");
    state
        .borrow_mut()
        .assign_parameter("alias".into(), "durable".into())
        .unwrap();
    let mut work = Work::new(65_536, 65_536, 0);
    let child = finish(State::snapshot(&state, &Cancel::new(), &mut work))
        .unwrap_or_else(|_| panic!("snapshot fits"));
    assert_eq!(child.variables["x"], "durable");
    assert_eq!(child.prefixes[0]["x"].as_deref(), Some("caller"));
    assert_eq!(child.prefixes[1]["x"].as_deref(), Some("durable"));
    drop(frame);
    assert_eq!(state.borrow().parameter("x"), "inner");
    drop(inner);
    assert_eq!(state.borrow().parameter("x"), "durable");
    drop(outer);
    assert_eq!(state.borrow().parameter("x"), "caller");
}

#[test]
fn dropping_a_pending_builtin_restores_nested_function_bindings_and_refunds_storage() {
    let memory = crate::exec::StorageBudget::new(65_536);
    let state = State::with_memory(memory.clone()).shared();
    state
        .borrow_mut()
        .assign_parameter("x".into(), "caller".into())
        .unwrap();
    let future_state = state.clone();
    let mut future = Box::pin(async move {
        let mut function =
            FunctionFrame::enter(future_state.clone(), vec!["argument".into()], 4).unwrap();
        function
            .prefixes(vec![("x".into(), "function".into())])
            .unwrap();
        future_state
            .borrow_mut()
            .declare_local("x".into(), None)
            .unwrap();
        assert_eq!(future_state.borrow().parameter("x"), "function");
        let _frame = builtin(&future_state, &[("x".into(), "builtin".into())]);
        futures::future::pending::<()>().await;
    });
    assert!(
        future
            .as_mut()
            .poll(&mut Context::from_waker(&noop_waker()))
            .is_pending()
    );
    assert_eq!(state.borrow().parameter("x"), "builtin");
    assert!(memory.observation().0 > 0);
    drop(future);
    assert_eq!(state.borrow().parameter("x"), "caller");
    assert!(state.borrow().positional().is_empty());
    assert!(state.borrow().locals.is_empty());
    assert!(!state.borrow().exported_bindings().contains("x"));
    assert_eq!(memory.observation().0, 0);
}

#[test]
fn partial_builtin_admission_rolls_back_before_returning_the_error() {
    let memory = crate::exec::StorageBudget::new(65_536);
    let state = State::with_memory(memory.clone()).shared();
    state
        .borrow_mut()
        .assign_parameter("x".into(), "caller".into())
        .unwrap();
    let assigned = [("x".into(), "a".into()), ("missing".into(), "b".into())];
    // Exactly the first replay's cumulative work storage; the second key fails
    // after x has been installed. Its guard must restore before returning Err.
    let first = snapshot_node_bytes::<Option<String>>().unwrap_or_else(|_| panic!("node fits")) + 3;
    let mut work = Work::new(65_536, first, 0);
    let result = PrefixFrame::builtin(state.clone(), &assigned, &Cancel::new(), &mut work)
        .now_or_never()
        .expect("short admission must not yield");
    assert!(matches!(result, Err(Error::Status(2))));
    assert_eq!(work.storage_remaining, 0);
    assert_eq!(state.borrow().parameter("x"), "caller");
    assert!(!state.borrow().bindings().contains_key("missing"));
    assert_eq!(memory.observation().0, 0);
}
