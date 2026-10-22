//! Original retained trap bindings. Inherited handlers are query-only until mutation.
//! Bindings are registration state only: no event runs a stored action.
use crate::exec::StorageAllocation;
use std::rc::Rc;

pub(crate) const SLOTS: usize = 68;
#[derive(Debug)]
pub(crate) struct Action {
    pub(crate) text: String,
    pub(crate) _storage: Option<StorageAllocation>,
}
#[derive(Clone, Debug)]
pub(crate) enum Binding {
    Ignored,
    Handler(Rc<Action>),
}
#[derive(Clone, Debug)]
pub(crate) struct Traps {
    bindings: [Option<Binding>; SLOTS],
    inherited: bool,
}
impl Default for Traps {
    fn default() -> Self {
        Self {
            bindings: std::array::from_fn(|_| None),
            inherited: false,
        }
    }
}
impl Traps {
    pub(crate) fn inherited(&self) -> Self {
        Self {
            inherited: true,
            ..self.clone()
        }
    }
    pub(crate) fn get(&self, signal: usize) -> Option<&Binding> {
        self.bindings[signal].as_ref()
    }
    pub(crate) fn prepare_mutation(&mut self) {
        if self.inherited {
            self.clear_handlers();
            self.inherited = false;
        }
    }
    pub(crate) fn set(&mut self, signal: usize, binding: Option<Binding>) {
        self.prepare_mutation();
        self.bindings[signal] = binding;
    }
    fn clear_handlers(&mut self) {
        for binding in &mut self.bindings {
            if matches!(binding, Some(Binding::Handler(_))) {
                *binding = None;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exec::StorageBudget;
    #[test]
    fn retained_action_refunds_after_last_child_and_failed_admission_is_atomic() {
        let budget = StorageBudget::new(100);
        let mut parent = Traps::default();
        parent.set(
            0,
            Some(Binding::Handler(Rc::new(Action {
                text: "echo exit".into(),
                _storage: Some(budget.admit(80).unwrap()),
            }))),
        );
        assert!(budget.admit(21).is_err());
        let mut child = parent.inherited();
        assert!(matches!(child.get(0), Some(Binding::Handler(_))));
        parent.set(0, None);
        assert_eq!(budget.observation().0, 80);
        child.set(2, Some(Binding::Ignored));
        assert!(child.get(0).is_none());
        assert_eq!(budget.observation().0, 0);
    }
}
