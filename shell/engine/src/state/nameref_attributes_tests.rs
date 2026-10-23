use super::*;
use futures::FutureExt;

fn setup() -> SharedState {
    let mut state = State::default();
    state
        .assign_parameter("target".into(), "value".into())
        .unwrap();
    state
        .declare_nameref("ref".into(), "target".into(), false)
        .unwrap();
    state.shared()
}

fn disable(state: &SharedState, cancel: &Cancel, work: &mut Work) -> Result<(), Error> {
    State::disable_nameref(state, "ref".into(), None, false, cancel, work)
        .now_or_never()
        .expect("small reference does not yield")
}

fn unchanged(state: &SharedState) {
    let state = state.borrow();
    assert_eq!(state.namerefs()["ref"], "target");
    assert!(!state.bindings().contains_key("ref"));
    assert_eq!(state.scalar_parameter("target"), Some("value"));
}

#[test]
fn removal_rejects_storage_and_cancellation_before_mutation() {
    let state = setup();
    let mut work = Work::new(4096, 0, 0);
    assert!(disable(&state, &Cancel::new(), &mut work).is_err());
    unchanged(&state);
    let cancel = Cancel::new();
    cancel.cancel();
    let mut work = Work::new(4096, 4096, 0);
    assert!(disable(&state, &cancel, &mut work).is_err());
    unchanged(&state);
    let mut work = Work::new(4096, 4096, 0);
    disable(&state, &Cancel::new(), &mut work).unwrap_or_else(|_| panic!("removal fits"));
    let state = state.borrow();
    assert!(!state.is_nameref("ref"));
    assert_eq!(state.scalar_parameter("ref"), Some("target"));
    assert_eq!(state.scalar_parameter("target"), Some("value"));
}

#[test]
fn raw_attributes_do_not_make_the_referent_readonly_or_exported() {
    let state = setup();
    state.borrow_mut().set_nameref_attributes("ref", true, true);
    assert!(state.borrow().is_readonly("ref"));
    assert!(state.borrow().exported_bindings().contains("ref"));
    assert!(!state.borrow().is_readonly("target"));
    assert!(!state.borrow().exported_bindings().contains("target"));
    assert_eq!(state.borrow().environment()["ref"], "target");
    state
        .borrow_mut()
        .assign_parameter("ref".into(), "changed".into())
        .unwrap();
    assert_eq!(state.borrow().scalar_parameter("target"), Some("changed"));
    assert_eq!(state.borrow_mut().unset_nameref("ref"), Err(1));
    let mut work = Work::new(4096, 4096, 0);
    assert!(disable(&state, &Cancel::new(), &mut work).is_err());
    assert!(state.borrow().is_nameref("ref"));
}
