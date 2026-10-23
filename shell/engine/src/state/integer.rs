use super::{Binding, State, snapshot_node_bytes};
use crate::exec::Work;

impl State {
    pub(crate) fn integer_assignment(&self, name: &str) -> bool {
        self.integers.contains(name)
            && !self.namerefs.contains_key(name)
            && !matches!(self.variables.get(name), Some(Binding::Indexed(_)))
    }

    pub(crate) fn declare_integer(
        &mut self,
        name: &str,
        enabled: bool,
        work: &mut Work,
    ) -> Result<(), i32> {
        if self.is_readonly(name) {
            return Err(1);
        }
        if self.namerefs.contains_key(name)
            || name == "PIPESTATUS"
            || matches!(self.variables.get(name), Some(Binding::Indexed(_)))
        {
            return Err(2);
        }
        if enabled && !self.integers.contains(name) {
            let bytes = name
                .len()
                .saturating_add(snapshot_node_bytes::<()>().map_err(|_| 2)?);
            work.admit_storage(bytes).map_err(|_| 2)?;
        }
        self.restore_integer(name, enabled);
        Ok(())
    }

    pub(super) fn saved_integer_storage(&self, name: &str) -> usize {
        if !self.integers.contains(name) {
            return 0;
        }
        name.len()
            .saturating_add(snapshot_node_bytes::<()>().unwrap_or(usize::MAX))
    }

    pub(super) fn restore_integer(&mut self, name: &str, enabled: bool) {
        if enabled && !self.integers.contains(name) {
            self.integers.insert(name.to_owned());
        } else if !enabled {
            self.integers.remove(name);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integer_metadata_follows_existing_local_restoration() {
        let state = State::default().shared();
        let mut work = Work::new(100_000, 100_000, 0);
        state
            .borrow_mut()
            .declare_integer("x", true, &mut work)
            .unwrap();
        let frame =
            super::super::FunctionFrame::enter(state.clone(), Vec::new(), usize::MAX).unwrap();
        state.borrow_mut().declare_local("x".into(), None).unwrap();
        assert!(!state.borrow().integer_assignment("x"));
        drop(frame);
        assert!(state.borrow().integer_assignment("x"));
    }

    #[test]
    fn integer_metadata_admission_precedes_mutation() {
        let mut state = State::default();
        let mut work = Work::new(100, 0, 0);
        assert_eq!(state.declare_integer("x", true, &mut work), Err(2));
        assert!(!state.integer_assignment("x"));
        assert!(!state.variables.contains_key("x"));
    }

    #[test]
    fn integer_metadata_reapplication_does_not_charge_another_node() {
        let mut state = State::default();
        let bytes = 1 + snapshot_node_bytes::<()>().unwrap_or_else(|_| panic!("node fits"));
        let mut work = Work::new(100, bytes, 0);
        state.declare_integer("x", true, &mut work).unwrap();
        assert_eq!(work.storage_left(), 0);
        state.declare_integer("x", true, &mut work).unwrap();
        assert_eq!(work.storage_left(), 0);
        assert_eq!(state.declaration("x").unwrap().unwrap().value, None);
        assert!(state.declaration("x").unwrap().unwrap().integer);
        state.declare_integer("x", false, &mut work).unwrap();
        assert!(!state.integer_assignment("x"));
    }
}
