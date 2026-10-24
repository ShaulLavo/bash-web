//! Durable indexed-array writes: arithmetic element assignment, `read -a` and
//! `mapfile`. Unlike an assignment-only command's own writes, these are not
//! undone by its journal; like `assign_parameter`, they update the journal
//! so that its rollback keeps them. Bash 5.3.15 controls are recorded in
//! scripts/fixtures/shell-indexed-durable-writes.json.
//!
//! Each write is two steps with no await between them: `admit_*` charges
//! the command's Work before anything is published, and `assign_*` checks
//! readonly and session storage, then publishes or changes nothing.
use super::{
    AssignmentChanges, Binding, BindingUndo, BindingUpdate, Indexed, ScalarResolution, SharedState,
    State, snapshot_node_bytes, snapshot_steps,
};
use crate::{
    exec::{Error, StorageAllocation, Work},
    executor::Cancel,
};
use std::{cell::RefCell, collections::BTreeSet, rc::Rc};

use super::binding::{kept_insertion_steps, tree_bytes};

#[derive(Default)]
struct ElementEffectCost {
    storage: usize,
    steps: usize,
}

/// Which binding a durable array write changes while an expansion prefix
/// saves the target. Bash writes the variable that outlives the temporary
/// assignment, or the temporary one when nothing outlives it.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Destination {
    Live,
    /// The saved value restored after the prefix; the temporary is unchanged.
    Saved,
    /// A temporary over an unset variable, discarded with its prefix.
    Temporary,
}

impl State {
    /// Resolve a write subscript as Bash does: a negative index counts back
    /// from the last element. `None` is Bash's "bad array subscript".
    pub(crate) fn indexed_write_index(&self, name: &str, index: i64) -> Option<i64> {
        let ScalarResolution::Target(target) = self.resolve_scalar_target(name) else {
            return (index >= 0).then_some(index);
        };
        let destination = self.indexed_destination(target);
        match self.destination_binding(target, destination) {
            Some(binding) => binding.resolve_index(index),
            None => (index >= 0).then_some(index),
        }
    }
    /// Admit `name[index]=value` before `assign_indexed_element`. The caller
    /// has admitted `value` itself. This covers what publication allocates:
    /// an owned alias target, a copy of a shared array, tree growth, and the
    /// value copies an enclosing assignment journal keeps.
    pub(crate) async fn admit_indexed_element(
        state: &SharedState,
        name: &str,
        index: i64,
        value_bytes: usize,
        cancel: &Cancel,
        work: &mut Work,
    ) -> Result<(), Error> {
        Self::admit_scalar_access(state, name, cancel, work).await?;
        let steps = state
            .borrow()
            .admit_element_storage(name, index, value_bytes, work)?;
        snapshot_steps(steps, cancel, work).await
    }
    fn admit_element_storage(
        &self,
        name: &str,
        index: i64,
        value_bytes: usize,
        work: &mut Work,
    ) -> Result<usize, Error> {
        let (target, destination) = self.indexed_target(name)?;
        let image = self.destination_binding(target, destination);
        let copy = Binding::shared_bytes(image);
        let journal =
            self.durable_journal(destination)
                .map_or_else(ElementEffectCost::default, |changes| {
                    changes
                        .borrow()
                        .element_effect_cost(target, index, value_bytes)
                });
        work.admit_storage(
            Binding::element_write_bytes(image, index)
                .saturating_add(journal.storage)
                .saturating_add(self.indexed_key_bytes(name, target)?),
        )?;
        Ok(copy.saturating_add(journal.steps))
    }
    /// Durably publish an admitted `name[index]=value` for a nonnegative,
    /// already resolved `index`. Returns 1 for a readonly or cyclic target,
    /// the resource status when session storage is exhausted, and 2 for a
    /// negative index. On any error nothing is published or recharged.
    pub(crate) fn assign_indexed_element(
        &mut self,
        name: String,
        index: i64,
        value: String,
    ) -> Result<(), i32> {
        if index < 0 {
            return Err(2);
        }
        let name = self.assignment_name(name)?;
        if self.is_readonly(&name) {
            return Err(1);
        }
        let destination = self.indexed_destination(&name);
        let journal = self.durable_journal(destination);
        let effect = journal.as_ref().map_or(0, |changes| {
            changes
                .borrow()
                .element_effect_cost(&name, index, value.len())
                .storage
        });
        let mut reservation = self.admit_temporary(effect)?;
        let image = self.destination_binding(&name, destination);
        let storage = Binding::element_storage_after(image, index, value.capacity());
        self.reserve_local_value(&name, storage)?;
        if let Some(changes) = journal {
            let mut changes = changes.borrow_mut();
            changes.absorb(reservation.as_mut());
            changes.element_effect(&name, index, &value);
        }
        let ifs = name == "IFS";
        match self.destination_binding_mut(name, destination) {
            Some(binding) => binding.set_element(index, value),
            None => unreachable!("an element destination exists or is vacant live"),
        }
        if ifs {
            self.refresh_star_separator();
        }
        Ok(())
    }
    /// Admit replacing `name` with a caller-built, already admitted array.
    pub(crate) async fn admit_indexed_replacement(
        state: &SharedState,
        name: &str,
        cancel: &Cancel,
        work: &mut Work,
    ) -> Result<(), Error> {
        Self::admit_scalar_access(state, name, cancel, work).await?;
        let steps = {
            let state = state.borrow();
            let (target, destination) = state.indexed_target(name)?;
            work.admit_storage(
                Binding::indexed_header_bytes()
                    .saturating_add(state.indexed_key_bytes(name, target)?),
            )?;
            state.durable_journal(destination).map_or(0, |changes| {
                changes.borrow().replacement_effect_steps(target)
            })
        };
        snapshot_steps(steps, cancel, work).await
    }
    /// Durably replace `name` with `values`, as `read -a` and `mapfile`
    /// without an origin do. Errors as `assign_indexed_element`.
    pub(crate) fn assign_indexed(&mut self, name: String, values: Indexed) -> Result<(), i32> {
        let name = self.assignment_name(name)?;
        if self.is_readonly(&name) {
            return Err(1);
        }
        let destination = self.indexed_destination(&name);
        let binding = Binding::Indexed(Rc::new(values));
        self.reserve_local_value(&name, binding.storage_bytes())?;
        if let Some(changes) = self.durable_journal(destination) {
            changes.borrow_mut().supersede(&name);
        }
        let ifs = name == "IFS";
        match self.destination_binding_mut(name, destination) {
            Some(slot) => *slot = binding,
            None => unreachable!("a replacement destination exists or is vacant live"),
        }
        if ifs {
            self.refresh_star_separator();
        }
        Ok(())
    }
    fn indexed_target<'a>(&'a self, name: &'a str) -> Result<(&'a str, Destination), Error> {
        let ScalarResolution::Target(target) = self.resolve_scalar_target(name) else {
            return Err(1.into());
        };
        Ok((target, self.indexed_destination(target)))
    }
    /// An owned alias target, plus a key and node for a new live binding.
    fn indexed_key_bytes(&self, name: &str, target: &str) -> Result<usize, Error> {
        let alias = if target == name { 0 } else { target.len() };
        if self.variables.contains_key(target) {
            return Ok(alias);
        }
        Ok(alias
            .saturating_add(target.len())
            .saturating_add(snapshot_node_bytes::<Binding>()?))
    }
    fn indexed_destination(&self, target: &str) -> Destination {
        match self.prefixes.last().and_then(|frame| frame.get(target)) {
            None => Destination::Live,
            Some(Some(_)) => Destination::Saved,
            Some(None) => Destination::Temporary,
        }
    }
    fn destination_binding(&self, target: &str, destination: Destination) -> Option<&Binding> {
        if destination == Destination::Saved {
            return self.prefixes.last()?.get(target)?.as_ref();
        }
        self.variables.get(target)
    }
    /// The binding to change, inserting an empty array for a vacant live one.
    fn destination_binding_mut(
        &mut self,
        target: String,
        destination: Destination,
    ) -> Option<&mut Binding> {
        if destination == Destination::Saved {
            return self.prefixes.last_mut()?.get_mut(&target)?.as_mut();
        }
        Some(
            self.variables
                .entry(target)
                .or_insert_with(|| Binding::Indexed(Rc::default())),
        )
    }
    /// A temporary's write is discarded with its prefix, so it is not kept
    /// by rollback either.
    fn durable_journal(&self, destination: Destination) -> Option<Rc<RefCell<AssignmentChanges>>> {
        if destination == Destination::Temporary {
            return None;
        }
        self.assignment_undo.0.upgrade()
    }
}

impl AssignmentChanges {
    fn element_effect_cost(&self, name: &str, index: i64, value_bytes: usize) -> ElementEffectCost {
        let mut cost = ElementEffectCost::default();
        for (target, undo) in &self.undo {
            cost.steps = cost
                .steps
                .saturating_add(target.len().saturating_add(name.len()).saturating_mul(3));
            if target != name {
                continue;
            }
            let effect = undo.element_effect_cost(index, value_bytes);
            cost.storage = cost.storage.saturating_add(effect.storage);
            cost.steps = cost.steps.saturating_add(effect.steps);
        }
        cost
    }
    fn element_effect(&mut self, name: &str, index: i64, value: &str) {
        for (_, undo) in self.undo.iter_mut().filter(|(target, _)| target == name) {
            undo.element_effect(index, value);
        }
    }
    fn replacement_effect_steps(&self, name: &str) -> usize {
        let mut steps = 0usize;
        for (target, undo) in &self.undo {
            // Both this estimate and publication visit and compare each name.
            steps = steps.saturating_add(
                target
                    .len()
                    .saturating_add(name.len())
                    .saturating_mul(2)
                    .saturating_add(2),
            );
            if target == name {
                steps = steps.saturating_add(undo.supersede_steps());
            }
        }
        steps
    }
    /// A durable replacement leaves nothing earlier for rollback to restore.
    fn supersede(&mut self, name: &str) {
        for (_, undo) in self.undo.iter_mut().filter(|(target, _)| target == name) {
            *undo = BindingUndo::Superseded;
        }
    }
    /// Keep a reservation admitted for this journal's inverses with it.
    fn absorb(&mut self, reservation: Option<&mut StorageAllocation>) {
        let (Some(memory), Some(reservation)) = (&mut self.memory, reservation) else {
            return;
        };
        let bytes = reservation.bytes();
        memory.take_from(reservation, bytes);
    }
}

impl Binding {
    /// Bash's `name[index]=value`: a scalar becomes an array whose element
    /// zero is the old value, even when `index` is zero.
    fn set_element(&mut self, index: i64, value: String) {
        if let Self::Scalar(current) = self {
            let scalar = std::mem::take(current);
            *self = Self::Indexed(Rc::new(Indexed::from_scalar(scalar)));
        }
        let Self::Indexed(values) = self else {
            unreachable!()
        };
        Rc::make_mut(values).insert(index, value);
    }
    /// Bytes a write must copy first because another owner shares the array.
    fn shared_bytes(old: Option<&Self>) -> usize {
        BindingUpdate::Element {
            index: 0,
            value: String::new(),
        }
        .copy_bytes(old)
    }
    /// Bytes `set_element` allocates besides the value: a copy of a shared
    /// array, a new tree slot, and the array header for an unset or scalar
    /// binding.
    fn element_write_bytes(old: Option<&Self>, index: i64) -> usize {
        let update = BindingUpdate::Element {
            index,
            value: String::new(),
        };
        update
            .copy_bytes(old)
            .saturating_add(update.growth_bytes(old))
    }
}

impl BindingUndo {
    fn supersede_steps(&self) -> usize {
        // Multiple matching inverses may share the last owners of one tree.
        let elements = match self {
            Self::Restore(Some(binding @ Binding::Indexed(_))) => binding.count(),
            Self::Append { kept, .. } => kept.len(),
            Self::Restore(_) | Self::Element { .. } | Self::Superseded => 0,
        };
        elements.saturating_add(1)
    }
    /// Storage and work needed before a synchronous inverse update.
    fn element_effect_cost(&self, index: i64, value_bytes: usize) -> ElementEffectCost {
        match self {
            Self::Restore(binding) => ElementEffectCost {
                storage: value_bytes
                    .saturating_add(Binding::element_write_bytes(binding.as_ref(), index)),
                steps: value_bytes.saturating_add(Binding::shared_bytes(binding.as_ref())),
            },
            Self::Element { index: slot, .. } if *slot == index => ElementEffectCost {
                storage: value_bytes,
                steps: value_bytes,
            },
            Self::Append { range, kept, .. } if index != 0 && appended(*range, index) => {
                ElementEffectCost {
                    storage: kept_insertion_bytes(kept, index),
                    steps: kept_insertion_steps(kept.len()),
                }
            }
            _ => ElementEffectCost::default(),
        }
    }
    /// Make rollback keep a durable `[index]=value`. The binding stays an
    /// array afterwards, as Bash leaves a scalar given an element.
    fn element_effect(&mut self, index: i64, value: &str) {
        match self {
            Self::Restore(Some(binding)) => binding.set_element(index, value.to_owned()),
            Self::Restore(binding) => {
                let mut values = Indexed::default();
                values.insert(index, value.to_owned());
                *binding = Some(Self::array(values));
            }
            Self::Element {
                index: slot,
                old,
                scalar,
            } => {
                *scalar = false;
                if *slot == index {
                    *old = Some(value.to_owned());
                }
            }
            Self::Append {
                range,
                scalar,
                keep_zero,
                kept,
            } => {
                *scalar = false;
                if appended(*range, index) {
                    keep_appended(index, keep_zero, kept);
                }
            }
            Self::Superseded => {}
        }
    }
    fn array(values: Indexed) -> Binding {
        Binding::Indexed(Rc::new(values))
    }
}

fn appended(range: Option<(i64, i64)>, index: i64) -> bool {
    range.is_some_and(|(first, last)| (first..=last).contains(&index))
}

fn kept_insertion_bytes(kept: &BTreeSet<i64>, index: i64) -> usize {
    if kept.contains(&index) {
        return 0;
    }
    tree_bytes::<()>(kept.len() + 1).saturating_sub(tree_bytes::<()>(kept.len()))
}

fn keep_appended(index: i64, keep_zero: &mut bool, kept: &mut BTreeSet<i64>) {
    if index == 0 {
        *keep_zero = true;
        return;
    }
    kept.insert(index);
}
