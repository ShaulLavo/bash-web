//! Incremental publication owns neither a staged array nor a drop-time commit.
use super::{
    Binding, CaseLocale, CaseMapping, Indexed, Reference, ScalarResolution, SharedState, State,
    references::Owner, snapshot_node_bytes, snapshot_steps,
};
use crate::{
    exec::{Allocation, Error, RESOURCE_STATUS, Work},
    executor::Cancel,
};
use std::rc::Rc;

#[derive(Clone, Copy, Default, PartialEq, Eq)]
pub(crate) enum IndexedMode {
    #[default]
    Replace,
    Overlay,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Rejection {
    InvalidTarget,
    Readonly,
    NoAssign,
    Unsupported,
}

pub(crate) enum ProducerError {
    Rejected(Rejection),
    Exec(Error),
}
impl From<Error> for ProducerError {
    fn from(error: Error) -> Self {
        Self::Exec(error)
    }
}
impl From<i32> for ProducerError {
    fn from(status: i32) -> Self {
        Self::Exec(status.into())
    }
}

pub(crate) struct IndexedProducer {
    target: String,
    owner: Owner,
    local: bool,
    next: i64,
}

impl State {
    pub(crate) async fn begin_indexed_producer(
        state: &SharedState,
        operand: &str,
        mode: IndexedMode,
        origin: i64,
        cancel: &Cancel,
        work: &mut Work,
    ) -> Result<IndexedProducer, ProducerError> {
        let bytes = state.borrow().reference_work(operand)?;
        snapshot_steps(bytes, cancel, work).await?;
        let (target, owner) = {
            let state = state.borrow();
            let target = producer_target(&state, operand)?;
            work.admit_storage(target.len().checked_mul(2).ok_or(2)?)?;
            (target.to_owned(), state.reference_owner(target))
        };
        Self::admit_scalar_access(state, operand, cancel, work).await?;
        let mut state = state.borrow_mut();
        if producer_target(&state, operand)? != target || state.reference_owner(&target) != owner {
            return Err(1.into());
        }
        state.begin_producer_binding(&target, mode, work)?;
        let local = state
            .locals
            .iter()
            .rev()
            .find_map(|frame| frame.get(&target))
            .is_some_and(|local| local.memory.is_some());
        debug_assert!(state.assignment_undo.0.upgrade().is_none());
        Ok(IndexedProducer {
            target,
            owner,
            local,
            next: if mode == IndexedMode::Overlay {
                origin
            } else {
                0
            },
        })
    }

    fn begin_producer_binding(
        &mut self,
        target: &str,
        mode: IndexedMode,
        work: &mut Work,
    ) -> Result<(), ProducerError> {
        let old = self.variables.get(target);
        let scalar = mode == IndexedMode::Overlay && matches!(old, Some(Binding::Scalar(_)));
        let tree = if scalar { Indexed::tree_bytes(1) } else { 0 };
        let node = if old.is_none() {
            snapshot_node_bytes::<Binding>()?
        } else {
            0
        };
        work.admit_storage(
            node.checked_add(Binding::indexed_header_bytes())
                .ok_or(2)?
                .checked_add(tree)
                .ok_or(2)?,
        )?;
        let storage = match (mode, old) {
            (IndexedMode::Replace, _) | (_, None) => Binding::indexed_header_bytes(),
            (_, Some(Binding::Scalar(value))) => Binding::indexed_header_bytes()
                .checked_add(tree)
                .ok_or(2)?
                .checked_add(value.capacity())
                .ok_or(2)?,
            (_, Some(binding)) => binding.storage_bytes(),
        };
        self.reserve_local_value(target, storage.max(self.held_local_value(target)))?;
        match (mode, self.variables.get_mut(target)) {
            (IndexedMode::Overlay, Some(Binding::Indexed(_))) => {}
            (IndexedMode::Overlay, Some(binding @ Binding::Scalar(_))) => {
                let scalar = std::mem::replace(binding, String::new().into());
                *binding = Binding::Indexed(Rc::new(scalar.into_indexed()));
            }
            _ => {
                self.variables.insert(
                    target.to_owned(),
                    Binding::Indexed(Rc::new(Indexed::default())),
                );
            }
        }
        if target == "IFS" {
            self.refresh_star_separator();
        }
        Ok(())
    }
}

fn producer_target<'a>(state: &'a State, operand: &'a str) -> Result<&'a str, ProducerError> {
    let ScalarResolution::Target(target) = state.resolve_scalar_target(operand) else {
        return Err(ProducerError::Rejected(Rejection::InvalidTarget));
    };
    if !Reference::parse(target).is_some_and(|r| r.name == target && r.subscript.is_none()) {
        return Err(ProducerError::Rejected(Rejection::InvalidTarget));
    }
    if state.special_stack_array(target) {
        return Err(ProducerError::Rejected(Rejection::NoAssign));
    }
    if target == "PIPESTATUS" {
        return Err(ProducerError::Rejected(Rejection::Unsupported));
    }
    if state.is_readonly(target) {
        return Err(ProducerError::Rejected(Rejection::Readonly));
    }
    Ok(target)
}

impl IndexedProducer {
    pub(crate) async fn push(
        &mut self,
        state: &SharedState,
        value: &str,
        admit_live: impl Fn(usize) -> Result<Allocation, i32>,
        cancel: &Cancel,
        work: &mut Work,
    ) -> Result<(), ProducerError> {
        if cancel.is_cancelled() {
            return Err(130.into());
        }
        let next = self.next.checked_add(1).ok_or(2)?;
        let mapping = RecordCase::new(&state.borrow(), &self.target)?;
        let len = mapping.length(value, cancel, work).await?;
        loop {
            let (node, copy) = self.write_cost(&state.borrow())?;
            let admitted = len.checked_add(node).ok_or(2)?.checked_add(copy).ok_or(2)?;
            work.admit_storage(admitted)?;
            if let Err(error) = snapshot_steps(copy, cancel, work).await {
                work.release_storage(admitted);
                return Err(error.into());
            }
            let mut state = state.borrow_mut();
            if copy == 0 && self.write_cost(&state)?.1 != 0 {
                work.release_storage(admitted);
                continue;
            }
            let result = self.publish(&mut state, value, len, node, mapping, &admit_live);
            if result.is_err() {
                work.release_storage(admitted);
            }
            result?;
            self.next = next;
            return Ok(());
        }
    }

    fn write_cost(&self, state: &State) -> Result<(usize, usize), ProducerError> {
        let Some(binding @ Binding::Indexed(values)) = state.variables.get(&self.target) else {
            return Err(1.into());
        };
        let copy = if Rc::strong_count(values) > 1 {
            binding.storage_bytes()
        } else {
            0
        };
        Ok((values.insertion_bytes(self.next), copy))
    }

    fn publish(
        &self,
        state: &mut State,
        value: &str,
        len: usize,
        node: usize,
        mapping: RecordCase,
        admit_live: &impl Fn(usize) -> Result<Allocation, i32>,
    ) -> Result<(), ProducerError> {
        if state.is_readonly(&self.target) {
            return Err(ProducerError::Rejected(Rejection::Readonly));
        }
        if state.reference_owner(&self.target) != self.owner {
            return Err(1.into());
        }
        let binding = &state.variables[&self.target];
        let storage = binding
            .storage_bytes()
            .checked_add(len)
            .ok_or(2)?
            .checked_add(node)
            .ok_or(2)?
            .checked_sub(binding.slot(self.next).map_or(0, String::capacity))
            .ok_or(2)?;
        let previous = state.held_local_value(&self.target);
        let _live = if self.local {
            state.reserve_local_value(&self.target, storage.max(previous))?;
            None
        } else {
            Some(admit_live(len)?)
        };
        let mut record = String::new();
        if record.try_reserve_exact(len).is_err() {
            state
                .reserve_local_value(&self.target, previous)
                .unwrap_or_else(|_| unreachable!("shrinking a local ticket"));
            return Err(RESOURCE_STATUS.into());
        }
        mapping.fill(value, &mut record);
        let Some(Binding::Indexed(values)) = state.variables.get_mut(&self.target) else {
            unreachable!("producer owns an indexed target")
        };
        Rc::make_mut(values).insert(self.next, record);
        if self.target == "IFS" {
            state.refresh_star_separator();
        }
        Ok(())
    }
}

#[derive(Clone, Copy)]
enum RecordCase {
    Unchanged,
    Mapped { locale: CaseLocale, upper: bool },
}
impl RecordCase {
    fn new(state: &State, target: &str) -> Result<Self, Error> {
        let mapping = state.case_mapping(target);
        if mapping == CaseMapping::Unchanged || state.is_readonly(target) {
            return Ok(Self::Unchanged);
        }
        Ok(Self::Mapped {
            locale: CaseLocale::from_state(state)?,
            upper: mapping == CaseMapping::Upper,
        })
    }

    async fn length(self, value: &str, cancel: &Cancel, work: &mut Work) -> Result<usize, Error> {
        let Self::Mapped { locale, upper } = self else {
            return Ok(value.len());
        };
        if value.is_ascii() {
            return Ok(value.len());
        }
        snapshot_steps(value.len(), cancel, work).await?;
        value.chars().try_fold(0usize, |len, ch| {
            len.checked_add(locale.map(ch, upper)?.len_utf8())
                .ok_or_else(|| 2.into())
        })
    }

    fn fill(self, value: &str, record: &mut String) {
        let Self::Mapped { locale, upper } = self else {
            record.push_str(value);
            return;
        };
        if value.is_ascii() {
            record.push_str(value);
            if upper {
                record.make_ascii_uppercase();
            } else {
                record.make_ascii_lowercase();
            }
            return;
        }
        for ch in value.chars() {
            record.push(
                locale
                    .map(ch, upper)
                    .unwrap_or_else(|_| unreachable!("validated mapping")),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        exec::{Scope, StorageBudget},
        state::{FunctionFrame, StarSeparator, bindings_tests::finish},
    };
    use futures::task::noop_waker;
    use std::{
        future::Future,
        task::{Context, Poll},
    };

    fn work() -> Work {
        Work::new(4_000_000, 4_000_000, 0)
    }
    fn begin(
        state: &SharedState,
        mode: IndexedMode,
        origin: i64,
        work: &mut Work,
    ) -> IndexedProducer {
        finish(State::begin_indexed_producer(
            state,
            "a",
            mode,
            origin,
            &Cancel::new(),
            work,
        ))
        .unwrap_or_else(|_| panic!("producer fits"))
    }
    fn scope(memory: StorageBudget) -> Scope {
        Scope::new(0, StorageBudget::new(1_000_000), memory)
    }
    fn push(
        producer: &mut IndexedProducer,
        state: &SharedState,
        value: &str,
        work: &mut Work,
    ) -> Result<(), ProducerError> {
        let scope = scope(StorageBudget::new(1_000_000));
        finish(producer.push(
            state,
            value,
            |bytes| scope.admit_execution(bytes),
            &Cancel::new(),
            work,
        ))
    }
    fn values(state: &SharedState) -> Vec<String> {
        let state = state.borrow();
        let mut previous = None;
        let mut values = Vec::new();
        while let Some((index, value)) = state.array_next("a", previous) {
            values.push(value.to_owned());
            previous = Some(index);
        }
        values
    }

    #[test]
    fn prefix_is_visible_before_cancel_and_no_commit_is_needed_on_drop() {
        let state = State::default().shared();
        let mut work = work();
        let mut producer = begin(&state, IndexedMode::Replace, 0, &mut work);
        push(&mut producer, &state, "first", &mut work).unwrap_or_else(|_| panic!("first"));
        push(&mut producer, &state, "second", &mut work).unwrap_or_else(|_| panic!("second"));
        assert_eq!(values(&state), ["first", "second"]);
        let cancel = Cancel::new();
        cancel.cancel();
        let scope = scope(StorageBudget::new(100));
        let result = finish(producer.push(
            &state,
            "third",
            |n| scope.admit_execution(n),
            &cancel,
            &mut work,
        ));
        assert!(matches!(
            result,
            Err(ProducerError::Exec(Error::Status(130)))
        ));
        drop(producer);
        assert_eq!(values(&state), ["first", "second"]);
    }

    #[test]
    fn unique_tree_stays_unique_and_shared_overlay_copies_once() {
        let state = State::default().shared();
        let mut work = work();
        let mut producer = begin(&state, IndexedMode::Replace, 0, &mut work);
        push(&mut producer, &state, "old", &mut work).unwrap_or_else(|_| panic!("old"));
        let ptr = match &state.borrow().variables["a"] {
            Binding::Indexed(v) => Rc::as_ptr(v),
            _ => unreachable!(),
        };
        push(&mut producer, &state, "keep", &mut work).unwrap_or_else(|_| panic!("keep"));
        assert!(
            matches!(&state.borrow().variables["a"], Binding::Indexed(v) if Rc::as_ptr(v) == ptr)
        );
        let saved = state.borrow().variables["a"].clone();
        let copy = saved.storage_bytes();
        let mut producer = begin(&state, IndexedMode::Overlay, 0, &mut work);
        let before = work.storage_left();
        push(&mut producer, &state, "new", &mut work).unwrap_or_else(|_| panic!("new"));
        assert_eq!(before - work.storage_left(), copy + 3);
        assert_eq!(saved.element(0), Some("old"));
        let before = work.storage_left();
        push(&mut producer, &state, "next", &mut work).unwrap_or_else(|_| panic!("next"));
        assert_eq!(before - work.storage_left(), 4);
    }

    #[test]
    fn record_admission_failure_refunds_work_and_keeps_prefix() {
        let state = State::default().shared();
        let mut work = work();
        let mut producer = begin(&state, IndexedMode::Replace, 0, &mut work);
        push(&mut producer, &state, "a", &mut work).unwrap_or_else(|_| panic!("a"));
        push(&mut producer, &state, "b", &mut work).unwrap_or_else(|_| panic!("b"));
        let mut short = Work::new(100, 2, 0);
        assert!(matches!(
            push(&mut producer, &state, "abc", &mut short),
            Err(ProducerError::Exec(Error::Status(2)))
        ));
        assert_eq!(short.storage_left(), 2);
        assert_eq!(values(&state), ["a", "b"]);
        let memory = StorageBudget::new(2);
        let scope = scope(memory.clone());
        let before = work.storage_left();
        let result = finish(producer.push(
            &state,
            "abc",
            |n| scope.admit_execution(n),
            &Cancel::new(),
            &mut work,
        ));
        assert!(matches!(
            result,
            Err(ProducerError::Exec(Error::Status(RESOURCE_STATUS)))
        ));
        assert_eq!(work.storage_left(), before);
        assert_eq!(memory.observation().0, 0);
        assert_eq!(values(&state), ["a", "b"]);
    }

    #[test]
    fn local_ticket_rejection_keeps_exact_previous_charge_and_unwinds() {
        let memory = StorageBudget::new(16_384);
        let state = State::with_memory(memory.clone()).shared();
        let frame = FunctionFrame::enter(state.clone(), Vec::new(), 100).unwrap();
        state.borrow_mut().local("a".into(), "old".into()).unwrap();
        let mut work = work();
        let mut producer = begin(&state, IndexedMode::Replace, 0, &mut work);
        push(&mut producer, &state, "a", &mut work).unwrap_or_else(|_| panic!("a"));
        push(&mut producer, &state, "b", &mut work).unwrap_or_else(|_| panic!("b"));
        let used = memory.observation().0;
        let held = state.borrow().held_local_value("a");
        let pressure = memory.admit(16_384 - used - 2).unwrap();
        assert!(matches!(
            push(&mut producer, &state, "abc", &mut work),
            Err(ProducerError::Exec(Error::Status(RESOURCE_STATUS)))
        ));
        assert_eq!(state.borrow().held_local_value("a"), held);
        assert_eq!(values(&state), ["a", "b"]);
        drop(pressure);
        drop(producer);
        drop(frame);
        assert_eq!(memory.observation().0, 0);
    }

    #[test]
    fn rejected_targets_do_not_initialize_pending_dynamic_state() {
        for (target, expected) in [
            ("BASH_ARGC", Rejection::NoAssign),
            ("BASH_ARGV", Rejection::NoAssign),
            ("FUNCNAME", Rejection::NoAssign),
            ("BASH_SOURCE", Rejection::NoAssign),
            ("BASH_LINENO", Rejection::NoAssign),
            ("PIPESTATUS", Rejection::Unsupported),
            ("locked", Rejection::Readonly),
            ("a[1]", Rejection::InvalidTarget),
        ] {
            rejected_target(target, expected);
        }
    }

    fn rejected_target(target: &str, expected: Rejection) {
        let memory = StorageBudget::new(32_768);
        let state = State::with_memory(memory.clone()).shared();
        state
            .borrow_mut()
            .declare_nameref("alias".into(), target.into(), false)
            .unwrap();
        state
            .borrow_mut()
            .readonly("locked".into(), Some("old".into()))
            .unwrap();
        state
            .borrow_mut()
            .declare_nameref("IFS".into(), "separator".into(), false)
            .unwrap();
        state
            .borrow_mut()
            .assign_parameter("separator".into(), " ".repeat(10_000))
            .unwrap();
        assert!(matches!(
            state.borrow().star_separator,
            StarSeparator::Snapshot { .. }
        ));
        assert!(state.borrow().ifs_members.is_none());
        assert_eq!(state.borrow().array_count("BASH_ARGC"), 0);
        let before = state.borrow().variables.clone();
        let pressure = memory.admit(32_768).unwrap();
        let mut work = Work::new(1000, 0, 0);
        let result = finish(State::begin_indexed_producer(
            &state,
            "alias",
            IndexedMode::Replace,
            0,
            &Cancel::new(),
            &mut work,
        ));
        assert!(matches!(result, Err(ProducerError::Rejected(actual)) if actual == expected));
        assert_eq!(state.borrow().variables, before);
        assert!(state.borrow().ifs_members.is_none());
        assert_eq!(state.borrow().array_count("BASH_ARGC"), 0);
        assert_eq!(memory.observation().0, 32_768);
        drop(pressure);
    }

    #[test]
    fn dropping_pending_copy_leaves_published_prefix_and_execution_budget_untouched() {
        let state = State::default().shared();
        let mut work = work();
        let mut producer = begin(&state, IndexedMode::Replace, 0, &mut work);
        push(&mut producer, &state, &"a".repeat(5000), &mut work).unwrap_or_else(|_| panic!("a"));
        let saved = state.borrow().variables["a"].clone();
        let mut producer = begin(&state, IndexedMode::Overlay, 1, &mut work);
        let memory = StorageBudget::new(100);
        let scope = scope(memory.clone());
        let cancel = Cancel::new();
        let future = producer.push(
            &state,
            "second",
            |n| scope.admit_execution(n),
            &cancel,
            &mut work,
        );
        let mut future = Box::pin(future);
        let waker = noop_waker();
        let mut cx = Context::from_waker(&waker);
        assert!(matches!(future.as_mut().poll(&mut cx), Poll::Pending));
        drop(future);
        assert_eq!(memory.observation().0, 0);
        assert_eq!(state.borrow().variables["a"], saved);
    }

    #[test]
    fn readonly_alias_does_not_block_a_writable_resolved_target() {
        let state = State::default().shared();
        state
            .borrow_mut()
            .declare_nameref("alias".into(), "a".into(), false)
            .unwrap();
        state.borrow_mut().readonly.insert("alias".into());
        let mut work = work();
        let mut producer = finish(State::begin_indexed_producer(
            &state,
            "alias",
            IndexedMode::Replace,
            0,
            &Cancel::new(),
            &mut work,
        ))
        .unwrap_or_else(|_| panic!("resolved target is writable"));
        push(&mut producer, &state, "value", &mut work).unwrap_or_else(|_| panic!("writable"));
        assert_eq!(values(&state), ["value"]);
        state.borrow_mut().readonly.insert("a".into());
        assert!(matches!(
            push(&mut producer, &state, "rejected", &mut work),
            Err(ProducerError::Rejected(Rejection::Readonly))
        ));
        assert_eq!(values(&state), ["value"]);
    }

    #[test]
    fn exact_unicode_capacity_and_unmappable_failure_keep_previous_elements() {
        let state = State::default().shared();
        state
            .borrow_mut()
            .case_attributes
            .insert("a".into(), CaseMapping::Upper);
        state
            .borrow_mut()
            .assign_parameter("LC_ALL".into(), "C.UTF-8".into())
            .unwrap();
        let mut work = work();
        let mut producer = begin(&state, IndexedMode::Replace, 0, &mut work);
        push(&mut producer, &state, "µ", &mut work).unwrap_or_else(|_| panic!("mapped Latin-1"));
        assert_eq!(
            state.borrow().variables["a"].slot(0).map(String::capacity),
            Some("Μ".len())
        );
        assert!(matches!(
            push(&mut producer, &state, "中", &mut work),
            Err(ProducerError::Exec(Error::Status(2)))
        ));
        assert_eq!(values(&state), ["Μ"]);
    }

    #[test]
    fn cursor_overflow_is_rejected_before_mutation() {
        let state = State::default().shared();
        let mut work = work();
        let mut producer = begin(&state, IndexedMode::Overlay, i64::MAX, &mut work);
        assert!(matches!(
            push(&mut producer, &state, "absent", &mut work),
            Err(ProducerError::Exec(Error::Status(2)))
        ));
        assert!(values(&state).is_empty());
    }

    #[test]
    fn rejected_direct_targets_leave_dynamic_views_and_local_tickets_unchanged() {
        let memory = StorageBudget::new(32_768);
        let state = State::with_memory(memory.clone()).shared();
        let frame = FunctionFrame::enter(state.clone(), Vec::new(), 100).unwrap();
        state.borrow_mut().local("a".into(), "keep".into()).unwrap();
        state.borrow_mut().readonly("a".into(), None).unwrap();
        state.borrow_mut().star_separator = StarSeparator::Snapshot {
            separator: Some(' '),
            scope: 0,
        };
        state.borrow_mut().ifs_members = None;
        let used = memory.observation().0;
        let held = state.borrow().held_local_value("a");
        let pressure = memory.admit(32_768 - used).unwrap();
        let mut work = Work::new(0, 0, 0);
        let result = finish(State::begin_indexed_producer(
            &state,
            "a",
            IndexedMode::Replace,
            0,
            &Cancel::new(),
            &mut work,
        ));
        assert!(matches!(
            result,
            Err(ProducerError::Rejected(Rejection::Readonly))
        ));
        assert_eq!(state.borrow().held_local_value("a"), held);
        assert!(state.borrow().ifs_members.is_none());
        assert_eq!(values(&state), ["keep"]);
        drop(pressure);
        drop(frame);
        assert_eq!(memory.observation().0, 0);
    }
}
