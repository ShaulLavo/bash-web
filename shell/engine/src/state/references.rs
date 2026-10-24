//! Reference spelling and selected storage. Evaluation belongs to the feature layer.
use super::{MAX_NAMEREF_DEPTH, ScalarResolution, State};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Reference<'a> {
    pub(crate) name: &'a str,
    pub(crate) subscript: Option<&'a str>,
}
impl<'a> Reference<'a> {
    pub(crate) fn parse(text: &'a str) -> Option<Self> {
        let end = text.find('[').unwrap_or(text.len());
        let name = &text[..end];
        let mut bytes = name.bytes();
        if !bytes
            .next()
            .is_some_and(|b| b.is_ascii_alphabetic() || b == b'_')
            || !bytes.all(|b| b.is_ascii_alphanumeric() || b == b'_')
        {
            return None;
        }
        if end == text.len() {
            return Some(Self {
                name,
                subscript: None,
            });
        }
        let close = Self::end(text, end)?;
        if close != text.len() || close == end + 2 {
            return None;
        }
        Some(Self {
            name,
            subscript: Some(&text[end + 1..close - 1]),
        })
    }

    /// End of one balanced selector. Shared by builtin operands and arithmetic lexing.
    pub(crate) fn end(text: &str, start: usize) -> Option<usize> {
        let mut depth = 0usize;
        let mut quote = None;
        let mut escaped = false;
        for (offset, ch) in text[start..].char_indices() {
            if escaped {
                escaped = false;
                continue;
            }
            if ch == '\\' && quote != Some('\'') {
                escaped = true;
                continue;
            }
            if quote == Some(ch) {
                quote = None;
                continue;
            }
            if quote.is_some() {
                continue;
            }
            if matches!(ch, '\'' | '"') {
                quote = Some(ch);
                continue;
            }
            depth += usize::from(ch == '[');
            if ch != ']' {
                continue;
            }
            depth = depth.checked_sub(1)?;
            if depth == 0 {
                return Some(start + offset + 1);
            }
        }
        None
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Owner {
    scope: Option<usize>,
    incarnation: u64,
}
#[derive(Clone, Debug)]
pub(super) struct SavedBinding {
    pub(super) value: Option<super::Binding>,
    pub(crate) owner: Owner,
}
impl std::ops::Deref for SavedBinding {
    type Target = Option<super::Binding>;
    fn deref(&self) -> &Self::Target {
        &self.value
    }
}
impl std::ops::DerefMut for SavedBinding {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.value
    }
}
#[derive(Debug)]
pub(crate) struct Place {
    pub(crate) name: String,
    pub(crate) index: Option<i64>,
    /// A phase observation, not a lease. RHS code may reveal/recreate an owner.
    pub(crate) owner: Owner,
}

impl State {
    pub(crate) fn reference<'a>(
        &'a self,
        mut reference: Reference<'a>,
    ) -> Result<Reference<'a>, ScalarResolution<'a>> {
        let mut seen = [""; MAX_NAMEREF_DEPTH];
        for depth in 0..MAX_NAMEREF_DEPTH {
            if seen[..depth].contains(&reference.name) {
                return Err(ScalarResolution::Cycle);
            }
            seen[depth] = reference.name;
            let Some(target) = self.namerefs.get(reference.name) else {
                return Ok(reference);
            };
            let Some(target) = Reference::parse(target) else {
                return Err(ScalarResolution::Cycle);
            };
            if reference.subscript.is_some() && target.subscript.is_some() {
                return Err(ScalarResolution::Cycle);
            }
            reference = Reference {
                name: target.name,
                subscript: reference.subscript.or(target.subscript),
            };
        }
        if self.namerefs.contains_key(reference.name) {
            return Err(ScalarResolution::DepthExceeded);
        }
        Ok(reference)
    }
    pub(crate) fn reference_owner(&self, name: &str) -> Owner {
        let scope = self
            .locals
            .iter()
            .rposition(|frame| frame.contains_key(name));
        let incarnation = scope.map_or(0, |index| self.locals[index][name].incarnation);
        Owner { scope, incarnation }
    }
    pub(crate) fn place_value(&self, place: &Place) -> Option<&str> {
        match place.index {
            Some(index) => self
                .variables
                .get(&place.name)
                .and_then(|v| v.element(index)),
            None => self.scalar_parameter(&place.name),
        }
    }
    pub(crate) fn place_index(&self, name: &str, index: i64) -> Option<i64> {
        self.variables
            .get(name)
            .map_or((index >= 0).then_some(index), |v| v.resolve_index(index))
    }
}

impl State {
    pub(crate) async fn write_element(
        state: &super::SharedState,
        place: &Place,
        update: super::BindingUpdate,
        cancel: &crate::executor::Cancel,
        work: &mut crate::exec::Work,
    ) -> Result<(), crate::exec::Error> {
        work.checkpoint(cancel).await?;
        let bytes = state.borrow().element_effect_bytes(&place.name, &update);
        work.admit_storage(bytes)?;
        super::snapshot_steps(bytes, cancel, work).await?;
        let mut state = state.borrow_mut();
        if state.is_readonly(&place.name) {
            work.admit_storage(place.name.len().saturating_add(160))?;
            return Err(crate::exec::Error::Readonly {
                name: place.name.clone(),
                line: None,
                expansion: false,
            });
        }
        // Rebinding/recreation is legal: preserve the evaluated selector and
        // select the current owner, rather than reporting a stale-place error.
        let _owner_changed = place.owner != state.reference_owner(&place.name);
        state.commit_element_effect(&place.name, &update)
    }

    fn element_effect_bytes(&self, name: &str, update: &super::BindingUpdate) -> usize {
        let mut largest = self
            .variables
            .get(name)
            .map_or(0, super::Binding::storage_bytes);
        let mut count = 1usize;
        for saved in self.prefixes.iter().filter_map(|frame| frame.get(name)) {
            largest = largest.saturating_add(
                saved
                    .value
                    .as_ref()
                    .map_or(0, super::Binding::storage_bytes),
            );
            count = count.saturating_add(1);
        }
        let changes = self.assignment_undo.0.upgrade();
        let Some(changes) = changes else {
            return effect_bytes(largest, count, name, update);
        };
        for (_, undo, _) in changes
            .borrow()
            .undo
            .iter()
            .filter(|(target, _, _)| target == name)
        {
            largest = largest.saturating_add(undo.storage_bytes());
            count = count.saturating_add(1);
        }
        effect_bytes(largest, count, name, update)
    }

    fn commit_element_effect(
        &mut self,
        name: &str,
        update: &super::BindingUpdate,
    ) -> Result<(), crate::exec::Error> {
        let owner = self.reference_owner(name);
        let changes = self.assignment_undo.0.upgrade();
        let bytes = self.element_effect_bytes(name, update);
        let journal_bytes = changes.as_ref().map_or(0, |_| bytes);
        let prefix_count = self
            .prefixes
            .iter()
            .filter(|saved| saved.get(name).is_some_and(|saved| saved.owner == owner))
            .count();
        let held = update
            .storage_after(self.variables.get(name))
            .max(self.held_local_value(name));
        let local_growth = self.getopts_local_growth(name, held)?;
        let reservation = self.admit_temporary(
            journal_bytes
                .saturating_add(bytes.saturating_mul(prefix_count))
                .saturating_add(local_growth),
        )?;
        // Reserve the complete outside overlap together. No yield/admission can
        // intervene while its parts move to the existing owners below.
        drop(reservation);
        if let Some(changes) = &changes {
            changes
                .borrow_mut()
                .grow(journal_bytes)
                .unwrap_or_else(|_| panic!("aggregate journal admission"));
        }
        self.prefixes
            .reserve_effect(name, owner, bytes)
            .unwrap_or_else(|_| panic!("aggregate prefix admission"));
        self.reserve_local_value(name, held)
            .expect("aggregate local admission");
        let image = update.image(self.variables.get(name));
        if let Some(changes) = changes {
            amend_inverses(
                &mut changes.borrow_mut(),
                self.variables.get(name),
                name,
                owner,
                update,
            );
        }
        self.prefixes.amend(name, owner, update);
        match image {
            Some(binding) => {
                self.variables.insert(name.to_owned(), binding);
            }
            None => {
                self.variables.remove(name);
            }
        }
        Ok(())
    }
}

fn effect_bytes(largest: usize, count: usize, name: &str, update: &super::BindingUpdate) -> usize {
    largest
        .saturating_add(update.staged_bytes())
        .saturating_add(super::Binding::node_bytes())
        .saturating_add(name.len())
        .saturating_mul(count)
        .saturating_mul(4)
        .saturating_add(count.saturating_mul(std::mem::size_of::<Option<super::Binding>>()))
}
fn amend_inverses(
    changes: &mut super::AssignmentChanges,
    live: Option<&super::Binding>,
    name: &str,
    owner: Owner,
    update: &super::BindingUpdate,
) {
    let mut prior = live.cloned();
    let count = changes
        .undo
        .iter()
        .filter(|(target, _, saved)| target == name && *saved == owner)
        .count();
    let mut inverses = Vec::with_capacity(count);
    for (_, undo, _) in changes
        .undo
        .iter()
        .rev()
        .filter(|(target, _, saved)| target == name && *saved == owner)
    {
        prior = undo.clone().restore(prior);
        inverses.push(update.image(prior.as_ref()));
    }
    for (_, undo, _) in changes
        .undo
        .iter_mut()
        .filter(|(target, _, saved)| target == name && *saved == owner)
    {
        *undo = super::BindingUndo::Restore(inverses.pop().unwrap());
    }
}

#[cfg(test)]
mod tests {
    use super::super::bindings_tests::finish;
    use super::*;
    use crate::{
        exec::{StorageBudget, Work},
        executor::Cancel,
    };
    use futures::FutureExt;
    #[test]
    fn typed_reference_prefix_capacity_is_retained_until_state_drop() {
        let memory = StorageBudget::new(65_536);
        let state = State::with_memory(memory.clone()).shared();
        let mut work = Work::new(65_536, 65_536, 0);
        let frame = super::super::PrefixFrame::enter(state.clone(), &mut work)
            .unwrap_or_else(|_| panic!("fits"));
        let capacity = memory.observation().0;
        assert!(capacity > 0);
        drop(frame);
        assert_eq!(memory.observation().0, capacity);
        let frame = super::super::PrefixFrame::enter(state.clone(), &mut work)
            .unwrap_or_else(|_| panic!("reuses slot"));
        assert_eq!(memory.observation().0, capacity);
        drop(frame);
        drop(state);
        assert_eq!(memory.observation().0, 0);
    }
    #[test]
    fn typed_reference_refused_prefix_growth_publishes_nothing() {
        let memory = StorageBudget::new(0);
        let state = State::with_memory(memory.clone()).shared();
        let mut work = Work::new(10, 65_536, 0);
        assert!(super::super::PrefixFrame::enter(state.clone(), &mut work).is_err());
        assert!(state.borrow().prefixes.is_empty());
        assert_eq!(memory.observation().0, 0);
    }
    #[test]
    fn typed_reference_cancelled_and_refused_effects_leave_binding_unchanged() {
        let state = State::default().shared();
        state
            .borrow_mut()
            .assign_parameter("a".into(), "old".into())
            .unwrap();
        let place = Place {
            name: "a".into(),
            index: Some(0),
            owner: Owner::default(),
        };
        let cancel = Cancel::new();
        cancel.cancel();
        let mut work = Work::new(65_536, 65_536, 0);
        let update = super::super::BindingUpdate::Element {
            index: 0,
            value: "new".into(),
        };
        assert!(matches!(
            State::write_element(&state, &place, update, &cancel, &mut work).now_or_never(),
            Some(Err(crate::exec::Error::Status(130)))
        ));
        let mut work = Work::new(65_536, 0, 0);
        let update = super::super::BindingUpdate::Remove { index: 0 };
        assert!(
            finish(State::write_element(
                &state,
                &place,
                update,
                &Cancel::new(),
                &mut work
            ))
            .is_err()
        );
        assert_eq!(state.borrow().scalar_parameter("a"), Some("old"));
    }
}
