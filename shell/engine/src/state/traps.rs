//! Queryable registrations for uncatchable signals.
use crate::exec::StorageAllocation;
use std::rc::Rc;

#[derive(Clone, Copy)]
pub(crate) enum UncatchableSignal {
    Kill,
    Stop,
}
impl UncatchableSignal {
    pub(crate) const ALL: [Self; 2] = [Self::Kill, Self::Stop];

    pub(crate) fn from_number(number: usize) -> Option<Self> {
        match number {
            9 => Some(Self::Kill),
            19 => Some(Self::Stop),
            _ => None,
        }
    }

    pub(crate) fn number(self) -> usize {
        match self {
            Self::Kill => 9,
            Self::Stop => 19,
        }
    }
}

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
#[derive(Clone, Debug, Default)]
pub(crate) struct Traps {
    bindings: [Option<Binding>; UncatchableSignal::ALL.len()],
    reset_handlers_on_mutation: bool,
}
impl Traps {
    pub(crate) fn inherited(&self) -> Self {
        let mut traps = self.clone();
        traps.reset_handlers_on_mutation = true;
        traps
    }

    pub(crate) fn get(&self, signal: UncatchableSignal) -> Option<&Binding> {
        self.bindings[signal as usize].as_ref()
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.bindings.iter().all(Option::is_none)
    }

    pub(crate) fn prepare_mutation(&mut self) {
        if self.reset_handlers_on_mutation {
            self.clear_handlers();
            self.reset_handlers_on_mutation = false;
        }
    }

    pub(crate) fn set(&mut self, signal: UncatchableSignal, binding: Option<Binding>) {
        self.prepare_mutation();
        self.bindings[signal as usize] = binding;
    }

    pub(crate) fn process_substitution(&self) -> Self {
        let mut traps = self.clone();
        if !traps.reset_handlers_on_mutation {
            traps.clear_handlers();
        }
        traps
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
    use UncatchableSignal::{Kill, Stop};

    fn handler() -> Binding {
        Binding::Handler(Rc::new(Action {
            text: ":".into(),
            _storage: None,
        }))
    }

    #[test]
    fn process_substitution_from_an_active_parent_only_retains_ignores() {
        let mut parent = Traps::default();
        parent.set(Kill, Some(handler()));
        parent.set(Stop, Some(Binding::Ignored));
        let child = parent.process_substitution();
        assert!(child.get(Kill).is_none());
        assert!(matches!(child.get(Stop), Some(Binding::Ignored)));
        assert!(matches!(parent.get(Kill), Some(Binding::Handler(_))));
    }

    #[test]
    fn process_substitution_from_an_inherited_parent_keeps_the_deferred_reset() {
        let mut parent = Traps::default();
        parent.set(Kill, Some(handler()));
        parent.set(Stop, Some(Binding::Ignored));
        let inherited = parent.inherited();
        let mut child = inherited.process_substitution().process_substitution();
        assert!(matches!(child.get(Kill), Some(Binding::Handler(_))));
        child.prepare_mutation();
        assert!(child.get(Kill).is_none());
        assert!(matches!(child.get(Stop), Some(Binding::Ignored)));
        assert!(matches!(inherited.get(Kill), Some(Binding::Handler(_))));
    }

    #[test]
    fn clearing_the_last_inherited_action_refunds_storage() {
        let budget = StorageBudget::new(100);
        let mut parent = Traps::default();
        parent.set(
            Stop,
            Some(Binding::Handler(Rc::new(Action {
                text: ":".into(),
                _storage: Some(budget.admit(80).unwrap()),
            }))),
        );
        let mut child = parent.inherited();
        parent.set(Stop, None);
        assert_eq!(budget.observation().0, 80);
        child.prepare_mutation();
        assert!(child.is_empty());
        assert_eq!(budget.observation().0, 0);
    }
}
