//! Retained trap bindings, trace inheritance and action re-entry suppression.
use crate::exec::StorageAllocation;
use std::rc::Rc;

pub(crate) const SLOTS: usize = 68;
const SIGNAL_SLOTS: usize = 65;
#[derive(Clone, Copy)]
pub(crate) enum Event {
    Error,
    Return,
}
impl Event {
    fn index(self) -> usize {
        match self {
            Self::Error => 0,
            Self::Return => 1,
        }
    }
    fn signal(self) -> usize {
        66 + self.index()
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
#[derive(Clone, Debug)]
pub(crate) struct Traps {
    bindings: [Option<Binding>; SLOTS],
    inherited: bool,
    exit_inherited: bool,
    implicit_ignores: [bool; 2],
    traced: [bool; 2],
    running: [bool; 2],
}
impl Default for Traps {
    fn default() -> Self {
        Self {
            bindings: std::array::from_fn(|_| None),
            inherited: false,
            exit_inherited: false,
            implicit_ignores: [false; 2],
            traced: [false; 2],
            running: [false; 2],
        }
    }
}
impl Traps {
    #[cfg(test)]
    pub(crate) fn inherited(&self) -> Self {
        self.inherited_traced(false, false)
    }
    pub(crate) fn inherited_traced(&self, errtrace: bool, functrace: bool) -> Self {
        let mut traps = self.clone();
        traps.inherited = true;
        traps.traced = [errtrace, functrace];
        traps.exit_inherited = traps.bindings[0].is_some();
        traps.implicit_ignores = [false; 2];
        traps
    }
    pub(crate) fn pipeline_subshell(&mut self) {
        // The pipeline's last subshell has an ERR boundary outside its child body.
        self.traced[Event::Error.index()] = true;
    }
    pub(crate) fn action(&self, event: Event) -> Option<Rc<Action>> {
        if self.running[event.index()] || self.inherited && !self.traced[event.index()] {
            return None;
        }
        match self.get(event.signal()) {
            Some(Binding::Handler(action)) => Some(action.clone()),
            _ => None,
        }
    }
    pub(crate) fn begin(&mut self, event: Event) -> Option<Rc<Action>> {
        let action = self.action(event)?;
        self.running[event.index()] = true;
        Some(action)
    }
    pub(crate) fn end(&mut self, event: Event) {
        self.running[event.index()] = false;
    }
    pub(crate) fn suspend(&mut self, event: Event) -> Option<Binding> {
        if !matches!(self.get(event.signal()), Some(Binding::Handler(_))) {
            return None;
        }
        self.bindings[event.signal()].take()
    }
    pub(crate) fn restore(&mut self, event: Event, binding: Option<Binding>) {
        if self.get(event.signal()).is_none() {
            self.bindings[event.signal()] = binding;
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
        if matches!(signal, 2 | 3) {
            let implicit = &mut self.implicit_ignores[signal - 2];
            if *implicit && matches!(binding, Some(Binding::Ignored)) {
                return;
            }
            *implicit = false;
        }
        self.exit_inherited &= signal != 0;
        self.bindings[signal] = binding;
    }
    pub(crate) fn process_substitution(&self) -> Self {
        let mut traps = self.clone();
        for (signal, binding) in traps
            .bindings
            .iter_mut()
            .enumerate()
            .take(SIGNAL_SLOTS)
            .skip(1)
        {
            let reset = !self.inherited || matches!(signal, 2 | 3 | 17);
            if reset && matches!(binding, Some(Binding::Handler(_))) {
                *binding = None;
            }
        }
        if !traps.exit_inherited {
            traps.bindings[0] = None;
        }
        if !self.inherited {
            // Implicit INT/QUIT ignores do not create query-visible trap bindings.
            traps.implicit_ignores = [
                !matches!(traps.bindings[2], Some(Binding::Ignored)),
                !matches!(traps.bindings[3], Some(Binding::Ignored)),
            ];
        }
        traps
    }
    fn clear_handlers(&mut self) {
        self.clear_signal_handlers();
        self.bindings[65] = None;
        for event in [Event::Error, Event::Return] {
            if !self.traced[event.index()] {
                self.bindings[event.signal()] = None;
            }
        }
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
        let mut child = parent.process_substitution();
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
    fn inherited_process_substitution_retains_deferred_state_until_mutation() {
        let mut parent = Traps::default();
        let action = Rc::new(Action {
            text: ":".into(),
            _storage: None,
        });
        for signal in [0, 1, 2, 3, 17, 66] {
            parent.set(signal, Some(Binding::Handler(action.clone())));
        }
        parent.set(65, Some(Binding::Ignored));
        let inherited = parent.inherited();
        let mut child = inherited.process_substitution();
        for signal in [0, 1, 66] {
            assert!(matches!(child.get(signal), Some(Binding::Handler(_))));
        }
        for signal in [2, 3, 17] {
            assert!(child.get(signal).is_none());
        }
        assert!(matches!(child.get(65), Some(Binding::Ignored)));
        child.prepare_mutation();
        for signal in [0, 1, 65, 66] {
            assert!(child.get(signal).is_none());
        }
        assert!(matches!(inherited.get(0), Some(Binding::Handler(_))));
    }
    #[test]
    fn inherited_ignored_exit_survives_until_explicitly_set_again() {
        let mut parent = Traps::default();
        parent.set(0, Some(Binding::Ignored));
        let mut child = parent.inherited();
        child.set(1, Some(Binding::Ignored));
        let nested = child.process_substitution().process_substitution();
        assert!(matches!(nested.get(0), Some(Binding::Ignored)));
        child.set(0, Some(Binding::Ignored));
        assert!(child.process_substitution().get(0).is_none());
        assert!(matches!(parent.get(0), Some(Binding::Ignored)));
    }
    #[test]
    fn implicit_process_ignores_stay_hidden_until_reset_or_handler_assignment() {
        for signal in [2, 3] {
            let mut child = Traps::default().process_substitution();
            child.set(signal, Some(Binding::Ignored));
            child.set(signal, Some(Binding::Ignored));
            assert!(child.get(signal).is_none());
            child.set(signal, None);
            child.set(signal, Some(Binding::Ignored));
            assert!(matches!(child.get(signal), Some(Binding::Ignored)));
            let mut child = Traps::default().process_substitution();
            child.set(
                signal,
                Some(Binding::Handler(Rc::new(Action {
                    text: ":".into(),
                    _storage: None,
                }))),
            );
            child.set(signal, Some(Binding::Ignored));
            assert!(matches!(child.get(signal), Some(Binding::Ignored)));
        }
    }
    #[test]
    fn explicit_and_deferred_ignores_remain_query_visible() {
        for signal in [2, 3] {
            let mut parent = Traps::default();
            parent.set(signal, Some(Binding::Ignored));
            let mut child = parent.process_substitution();
            child.set(signal, Some(Binding::Ignored));
            assert!(matches!(child.get(signal), Some(Binding::Ignored)));
            assert!(matches!(parent.get(signal), Some(Binding::Ignored)));
            let mut child = Traps::default().inherited().process_substitution();
            child.set(signal, Some(Binding::Ignored));
            assert!(matches!(child.get(signal), Some(Binding::Ignored)));
        }
    }
    #[test]
    fn ordinary_child_clears_implicit_ignore_provenance_but_nested_process_does_not() {
        for signal in [2, 3] {
            let parent = Traps::default().process_substitution();
            let mut ordinary = parent.inherited();
            ordinary.set(signal, Some(Binding::Ignored));
            assert!(matches!(ordinary.get(signal), Some(Binding::Ignored)));
            let mut process = parent.process_substitution();
            process.set(signal, Some(Binding::Ignored));
            assert!(process.get(signal).is_none());
        }
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
