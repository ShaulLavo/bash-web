//! Original retained trap bindings. Inherited handlers are query-only until mutation.
//! Bindings are registration state only: no event runs a stored action.
use crate::exec::StorageAllocation;
use std::rc::Rc;

pub(crate) const SLOTS: usize = 68;
const SIGNAL_SLOTS: usize = 65;
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
        let mut traps = self.clone();
        traps.inherited = true;
        traps
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
    pub(crate) fn prepare_process_substitution(&mut self) {
        self.clear_signal_handlers();
        self.bindings[0] = None;
        self.inherited = false;
    }
    fn clear_handlers(&mut self) {
        self.clear_signal_handlers();
        self.bindings[SIGNAL_SLOTS..].fill(None);
    }
    fn clear_signal_handlers(&mut self) {
        for binding in &mut self.bindings[..SIGNAL_SLOTS] {
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
    fn child_mutation_drops_special_ignores_but_retains_exit_and_signal_ignores() {
        let mut parent = Traps::default();
        for signal in [0, 2, 65, 66, 67] {
            parent.set(signal, Some(Binding::Ignored));
        }
        let mut child = parent.inherited();
        child.set(1, Some(Binding::Ignored));
        for signal in [0, 2] {
            assert!(matches!(child.get(signal), Some(Binding::Ignored)));
        }
        for signal in 65..SLOTS {
            assert!(child.get(signal).is_none());
            assert!(matches!(parent.get(signal), Some(Binding::Ignored)));
        }
    }
    #[test]
    fn process_substitution_has_no_deferred_reset_but_its_nested_child_does() {
        let mut parent = Traps::default();
        let action = Rc::new(Action {
            text: ":".into(),
            _storage: None,
        });
        for signal in [0, 2, 66] {
            parent.set(signal, Some(Binding::Handler(action.clone())));
        }
        for signal in [15, 65, 67] {
            parent.set(signal, Some(Binding::Ignored));
        }
        let mut child = parent.inherited();
        child.prepare_process_substitution();
        assert!(child.get(0).is_none());
        assert!(child.get(2).is_none());
        child.set(1, Some(Binding::Ignored));
        assert!(matches!(child.get(66), Some(Binding::Handler(_))));
        for signal in [15, 65, 67] {
            assert!(matches!(child.get(signal), Some(Binding::Ignored)));
        }
        let mut nested = child.inherited();
        nested.set(3, Some(Binding::Ignored));
        assert!(matches!(nested.get(15), Some(Binding::Ignored)));
        for signal in 65..SLOTS {
            assert!(nested.get(signal).is_none());
        }
        assert!(matches!(parent.get(0), Some(Binding::Handler(_))));
    }
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
