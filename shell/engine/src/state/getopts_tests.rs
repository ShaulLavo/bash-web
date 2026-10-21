//! Original indexed-local getopts publication admission regressions.
use super::*;
use crate::exec::StorageBudget;

const CAPACITY: usize = 65_536;

#[test]
fn getopts_indexed_local_preflight_covers_publication() {
    let memory = StorageBudget::new(CAPACITY);
    let state = State::with_memory(memory.clone()).shared();
    let frame = FunctionFrame::enter(state.clone(), Vec::new(), usize::MAX).unwrap();
    for name in ["OPTIND", "OPTARG", "o"] {
        let mut state = state.borrow_mut();
        state.local(name.into(), "1".into()).unwrap();
        let old = state.variables.remove(name);
        let update = BindingUpdate::Element {
            index: 0,
            value: "1".into(),
        };
        let (binding, _) = update.apply_with_undo(old);
        state
            .reserve_local_value(name, binding.storage_bytes())
            .unwrap();
        state.variables.insert(name.into(), binding);
    }
    let hold =
        publish_index_at_capacity(&state, &memory, &[("OPTIND", 1), ("OPTARG", 1), ("o", 1)]);
    assert_eq!(
        state
            .borrow_mut()
            .assign_parameter("OPTARG".into(), "x".into()),
        Ok(())
    );
    assert_eq!(
        state.borrow_mut().assign_parameter("o".into(), "b".into()),
        Ok(())
    );
    drop(hold);
    drop(frame);
    assert_eq!(memory.observation().0, 0);
}

fn publish_index_at_capacity(
    state: &SharedState,
    memory: &StorageBudget,
    publications: &[(&str, usize); 3],
) -> crate::exec::StorageAllocation {
    let reservation = state
        .borrow()
        .reserve_getopts_publication(publications)
        .unwrap();
    let hold = memory.admit(CAPACITY - memory.observation().0).unwrap();
    drop(reservation);
    assert_eq!(state.borrow_mut().publish_getopts_index("1".into()), Ok(()));
    hold
}

#[test]
fn getopts_indexed_local_preflight_covers_repeated_alias_publication() {
    let memory = StorageBudget::new(CAPACITY);
    let state = State::with_memory(memory.clone()).shared();
    let frame = FunctionFrame::enter(state.clone(), Vec::new(), usize::MAX).unwrap();
    {
        let mut state = state.borrow_mut();
        state.local("OPTIND".into(), "1".into()).unwrap();
        let update = BindingUpdate::Element {
            index: 5,
            value: "saved".into(),
        };
        let (binding, _) = update.apply_with_undo(None);
        state
            .reserve_local_value("OPTIND", binding.storage_bytes())
            .unwrap();
        state.variables.insert("OPTIND".into(), binding);
        state
            .declare_nameref("ref".into(), "OPTIND".into(), false)
            .unwrap();
    }
    let hold = publish_index_at_capacity(&state, &memory, &[("OPTIND", 1), ("", 0), ("ref", 1)]);
    assert_eq!(
        state
            .borrow_mut()
            .assign_parameter("ref".into(), "b".into()),
        Ok(())
    );
    assert_eq!(state.borrow().variables["OPTIND"].element(5), Some("saved"));
    drop(hold);
    drop(frame);
    assert_eq!(memory.observation().0, 0);
}
