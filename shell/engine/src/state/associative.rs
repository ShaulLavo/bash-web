//! Bash bucket order over shared, ticket-owned balanced nodes.
use super::{Binding, State};
use crate::exec::{RESOURCE_STATUS, StorageAllocation, StorageBudget};
use std::rc::Rc;
mod tree;

type Position = (usize, i64);
pub(crate) type AssociativeCursor = Option<Position>;
#[derive(Debug)]
struct Entry {
    key: String,
    value: String,
    _memory: Option<StorageAllocation>,
}
impl Entry {
    fn bytes() -> usize {
        std::mem::size_of::<Self>() + 2 * std::mem::size_of::<usize>()
    }
    fn new(key: String, value: String, budget: &Option<StorageBudget>) -> Result<Rc<Self>, i32> {
        let bytes = Self::bytes() + key.capacity() + value.capacity();
        let memory = budget
            .as_ref()
            .map(|budget| budget.admit(bytes))
            .transpose()
            .map_err(|_| RESOURCE_STATUS)?;
        Ok(Rc::new(Self {
            key,
            value,
            _memory: memory,
        }))
    }
}
#[derive(Debug)]
pub struct Associative {
    entries: tree::Link,
    count: usize,
    bucket_count: usize,
    serial: i64,
    bytes: usize,
    key_bytes: usize,
    value_bytes: usize,
    initialized: bool,
    budget: Option<StorageBudget>,
    memory: Option<StorageAllocation>,
}
impl Default for Associative {
    fn default() -> Self {
        Self::with_buckets(1024, false, None)
    }
}
impl PartialEq for Associative {
    fn eq(&self, other: &Self) -> bool {
        if self.count != other.count
            || self.bucket_count != other.bucket_count
            || self.initialized != other.initialized
        {
            return false;
        }
        let mut first = None;
        let mut second = None;
        while let Some(entry) = self.next(&mut first) {
            if Some(entry) != other.next(&mut second) {
                return false;
            }
        }
        true
    }
}
impl Eq for Associative {}
impl Associative {
    fn with_buckets(count: usize, initialized: bool, budget: Option<StorageBudget>) -> Self {
        Self {
            entries: None,
            count: 0,
            bucket_count: count,
            serial: 0,
            bytes: 0,
            key_bytes: 0,
            value_bytes: 0,
            initialized,
            budget,
            memory: None,
        }
    }
    fn hash(key: &str) -> usize {
        key.bytes().fold(2166136261u32, |hash, byte| {
            hash.wrapping_mul(16777619) ^ (byte as i8 as i32 as u32)
        }) as usize
    }
    fn bucket(&self, key: &str) -> usize {
        Self::hash(key) & (self.bucket_count - 1)
    }
    fn find(&self, key: &str) -> Option<&tree::Node> {
        let bucket = self.bucket(key);
        let mut cursor = Some((bucket, i64::MIN));
        while let Some(node) = tree::next(&self.entries, cursor) {
            if node.position.0 != bucket {
                return None;
            }
            if node.entry.key == key {
                return Some(node);
            }
            cursor = Some(node.position);
        }
        None
    }
    pub(crate) fn get(&self, key: &str) -> Option<&String> {
        self.find(key).map(|node| &node.entry.value)
    }
    pub(crate) fn count(&self) -> usize {
        self.count
    }
    pub(crate) fn initialized(&self) -> bool {
        self.initialized
    }
    pub(crate) fn empty_replacement(&self) -> Self {
        Self::with_buckets(self.bucket_count, true, self.budget.clone())
    }
    pub(crate) fn next(&self, cursor: &mut AssociativeCursor) -> Option<(&str, &str)> {
        let node = tree::next(&self.entries, *cursor)?;
        *cursor = Some(node.position);
        Some((&node.entry.key, &node.entry.value))
    }
    pub(crate) fn storage_bytes(&self) -> usize {
        Self::default_storage_bytes() + self.count * (tree::bytes() + Entry::bytes()) + self.bytes
    }
    pub(crate) fn default_storage_bytes() -> usize {
        std::mem::size_of::<Self>() + 2 * std::mem::size_of::<usize>()
    }
    pub(crate) fn node_bytes() -> usize {
        tree::bytes() + Entry::bytes()
    }
    pub(crate) fn value_bytes(&self) -> usize {
        self.value_bytes
    }
    fn grows(&self, key: &str) -> bool {
        self.count >= self.bucket_count.saturating_mul(2) && self.get(key).is_none()
    }
    pub(crate) fn growth_bytes(&self, key: &str) -> usize {
        // Rewritten paths and rehash topology own live-memory tickets. Only
        // new retained entries consume the command's expansion-storage budget.
        let node = usize::from(self.get(key).is_none()) * tree::bytes();
        node + Entry::bytes() + key.len()
    }
    pub(crate) fn scalar_copy_bytes(&self) -> usize {
        Self::default_storage_bytes() + self.growth_bytes("0")
    }
    pub(crate) fn storage_after(&self, key: &str, value: Option<&String>) -> usize {
        let old = self.find(key).map(|node| &node.entry);
        let count = self.count + usize::from(value.is_some() && old.is_none())
            - usize::from(value.is_none() && old.is_some());
        let bytes = self.bytes
            - old.map_or(0, |entry| entry.key.capacity() + entry.value.capacity())
            + value.map_or(0, |value| key.len() + value.capacity());
        Self::default_storage_bytes() + count * Self::node_bytes() + bytes
    }
    pub(crate) fn mutation_steps(&self, key: &str, insert: bool) -> usize {
        let bucket = self.bucket(key);
        let mut cursor = Some((bucket, i64::MIN));
        let mut scan = 0usize;
        while let Some(node) = tree::next(&self.entries, cursor) {
            if node.position.0 != bucket {
                break;
            }
            scan += node.entry.key.len() + 1;
            cursor = Some(node.position);
        }
        let height = tree::height(&self.entries) + 1;
        let steps = key.len() * 4 + (scan * 6 + 16) * height;
        if !insert || !self.grows(key) {
            return steps;
        }
        steps + self.key_bytes * 2 + self.count * 24 + self.bucket_count * 4
    }
    pub(crate) fn admit_header(&mut self) -> Result<(), i32> {
        if self.memory.is_none() {
            self.memory = self
                .budget
                .as_ref()
                .map(|budget| budget.admit(Self::default_storage_bytes()))
                .transpose()
                .map_err(|_| RESOURCE_STATUS)?;
        }
        Ok(())
    }
    pub(crate) fn memory_is_admitted(&self) -> bool {
        self.budget.is_none() || self.memory.is_some()
    }
    pub(crate) fn copy(&self) -> Result<Self, i32> {
        let mut copy = Self::with_buckets(self.bucket_count, self.initialized, self.budget.clone());
        copy.admit_header()?;
        copy.entries = self.entries.clone();
        copy.count = self.count;
        copy.serial = self.serial;
        copy.bytes = self.bytes;
        copy.key_bytes = self.key_bytes;
        copy.value_bytes = self.value_bytes;
        Ok(copy)
    }
    fn rehash(&self, buckets: usize) -> Result<tree::Link, i32> {
        type Slot = (Position, Rc<Entry>, usize);
        let bytes = buckets * std::mem::size_of::<usize>()
            + self.count
                * (std::mem::size_of::<Slot>() + std::mem::size_of::<(Position, Rc<Entry>)>());
        let _temporary = self
            .budget
            .as_ref()
            .map(|budget| budget.admit(bytes))
            .transpose()
            .map_err(|_| RESOURCE_STATUS)?;
        let mut heads = Vec::new();
        heads
            .try_reserve_exact(buckets)
            .map_err(|_| RESOURCE_STATUS)?;
        heads.resize(buckets, usize::MAX);
        let mut slots: Vec<Slot> = Vec::new();
        slots
            .try_reserve_exact(self.count)
            .map_err(|_| RESOURCE_STATUS)?;
        tree::visit(&self.entries, &mut |node| {
            let bucket = Self::hash(&node.entry.key) & (buckets - 1);
            slots.push((
                (bucket, -node.position.1),
                node.entry.clone(),
                heads[bucket],
            ));
            heads[bucket] = slots.len() - 1;
        });
        let mut ordered = Vec::new();
        ordered
            .try_reserve_exact(self.count)
            .map_err(|_| RESOURCE_STATUS)?;
        for mut index in heads {
            while index != usize::MAX {
                let (position, entry, next) = &slots[index];
                ordered.push((*position, entry.clone()));
                index = *next;
            }
        }
        tree::build(&ordered, &self.budget)
    }
    pub(crate) fn insert(&mut self, key: String, value: String) -> Result<(), i32> {
        let entry = Entry::new(key, value, &self.budget)?;
        self.insert_entry(entry)
    }
    pub(crate) fn insert_copied(&mut self, key: &str, value: &str) -> Result<(), i32> {
        let bytes = Entry::bytes() + key.len() + value.len();
        let memory = self
            .budget
            .as_ref()
            .map(|budget| budget.admit(bytes))
            .transpose()
            .map_err(|_| RESOURCE_STATUS)?;
        let entry = Rc::new(Entry {
            key: key.to_owned(),
            value: value.to_owned(),
            _memory: memory,
        });
        self.insert_entry(entry)
    }
    fn insert_entry(&mut self, entry: Rc<Entry>) -> Result<(), i32> {
        let key = &entry.key;
        let old = self
            .find(key)
            .map(|node| (node.position, node.entry.clone()));
        let buckets = if self.grows(key) {
            self.bucket_count.checked_mul(4).ok_or(RESOURCE_STATUS)?
        } else {
            self.bucket_count
        };
        let serial = if old.is_none() {
            self.serial.checked_add(1).ok_or(RESOURCE_STATUS)?
        } else {
            self.serial
        };
        let position = old.as_ref().map_or(
            (Self::hash(key) & (buckets - 1), -serial),
            |(position, _)| *position,
        );
        let entries = if buckets != self.bucket_count {
            self.rehash(buckets)?
        } else {
            self.entries.clone()
        };
        let entries = tree::insert(&entries, position, entry.clone(), &self.budget)?;
        self.bytes = self.bytes + entry.key.capacity() + entry.value.capacity()
            - old.as_ref().map_or(0, |(_, entry)| {
                entry.key.capacity() + entry.value.capacity()
            });
        self.key_bytes =
            self.key_bytes + entry.key.len() - old.as_ref().map_or(0, |(_, entry)| entry.key.len());
        self.value_bytes = self.value_bytes + entry.value.len()
            - old.as_ref().map_or(0, |(_, entry)| entry.value.len());
        self.count += usize::from(old.is_none());
        self.entries = entries;
        self.bucket_count = buckets;
        self.serial = serial;
        self.initialized = true;
        Ok(())
    }
    pub(crate) fn remove(&mut self, key: &str) -> Result<(), i32> {
        let Some(node) = self.find(key) else {
            return Ok(());
        };
        let entry = node.entry.clone();
        let entries = tree::remove(&self.entries, node.position, &self.budget)?;
        self.entries = entries;
        self.count -= 1;
        self.bytes -= entry.key.capacity() + entry.value.capacity();
        self.key_bytes -= entry.key.len();
        self.value_bytes -= entry.value.len();
        Ok(())
    }
    pub(crate) fn initialize(&mut self) {
        self.initialized = true;
    }
}
impl State {
    pub(crate) fn is_associative(&self, name: &str) -> bool {
        matches!(self.binding(name), Some(Binding::Associative(_)))
    }
    pub(crate) fn associative_element(&self, name: &str, key: &str) -> Option<&str> {
        let Binding::Associative(values) = self.binding(name)? else {
            return None;
        };
        values.get(key).map(String::as_str)
    }
    pub(crate) fn associative_next(
        &self,
        name: &str,
        cursor: &mut AssociativeCursor,
    ) -> Option<(&str, &str)> {
        let Binding::Associative(values) = self.binding(name)? else {
            return None;
        };
        values.next(cursor)
    }
    fn prepare_associative_declaration(
        &self,
        name: &str,
        local: bool,
    ) -> Result<Option<Associative>, i32> {
        if local
            && (self.locals.is_empty()
                || self.readonly.contains(name)
                || self.current_local_readonly(name))
        {
            return Err(1);
        }
        if !local && self.is_associative(name) {
            return Ok(None);
        }
        let retained = !local || self.is_current_local(name) || self.function_prefix(name);
        let binding = self.variables.get(name).filter(|_| retained);
        if matches!(binding, Some(Binding::Associative(_))) {
            return Ok(None);
        }
        if (!local && self.is_readonly(name)) || matches!(binding, Some(Binding::Indexed(_))) {
            return Err(1);
        }
        let mut values = Associative::with_buckets(1024, false, self.memory.clone());
        if let Some(Binding::Scalar(value)) = binding {
            values.insert_copied("0", value)?;
        }
        values.admit_header()?;
        Ok(Some(values))
    }
    pub(crate) fn declare_associative(&mut self, name: String, local: bool) -> Result<(), i32> {
        let values = self.prepare_associative_declaration(&name, local)?;
        if local {
            self.declare_local(name.clone(), None)?;
        }
        let Some(values) = values else {
            return Ok(());
        };
        self.reserve_local_value(&name, 0)?;
        self.variables
            .insert(name, Binding::Associative(Rc::new(values)));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::super::{AssignmentFrame, BindingUpdate, PrefixFrame, SharedState};
    use super::*;
    fn order(values: &Associative) -> Vec<String> {
        let mut cursor = None;
        std::iter::from_fn(|| values.next(&mut cursor).map(|(key, _)| key.to_owned())).collect()
    }
    fn element(key: &str, value: Option<String>) -> BindingUpdate {
        BindingUpdate::AssociativeElement {
            key: key.into(),
            value,
        }
    }
    fn commit(state: &SharedState, update: BindingUpdate) -> Result<(), i32> {
        let mut work = crate::exec::Work::new(2_000_000, 1_048_576, 1);
        let (_, storage) = state
            .borrow()
            .admit_binding_update("h", &update, &mut work)
            .map_err(|_| 2)?;
        let mut journal = AssignmentFrame::enter(state.clone()).map_err(|_| 2)?;
        journal
            .reserve("h", update.undo_bytes(state.borrow().binding("h")))
            .map_err(|_| 2)?;
        let frame = PrefixFrame::enter(state.clone());
        frame.reserve("h", storage)?;
        frame
            .commit_update("h".into(), update, &mut journal)
            .map_err(|_| 2)?;
        journal.keep();
        Ok(())
    }
    fn state(memory: &StorageBudget) -> SharedState {
        let state = State::with_memory(memory.clone()).shared();
        state
            .borrow_mut()
            .declare_associative("h".into(), false)
            .unwrap();
        state
    }
    fn populated(memory: &StorageBudget, count: usize) -> SharedState {
        let state = state(memory);
        for i in 0..count {
            commit(&state, element(&format!("k{i}"), Some(i.to_string()))).unwrap();
        }
        state
    }
    fn original(memory: &StorageBudget) -> (SharedState, usize) {
        let state = state(memory);
        commit(&state, element("key", Some("old".into()))).unwrap();
        let before = memory.observation().0;
        (state, before)
    }
    fn pending_update(memory: &StorageBudget) -> (SharedState, usize, AssignmentFrame) {
        let (state, before) = original(memory);
        let mut journal = AssignmentFrame::enter(state.clone()).ok().unwrap();
        journal.reserve("h", 0).ok().unwrap();
        PrefixFrame::enter(state.clone())
            .commit_update("h".into(), element("key", Some("new".into())), &mut journal)
            .ok()
            .unwrap();
        (state, before, journal)
    }
    #[test]
    fn local_declaration_charges_shared_metadata_not_the_outer_map() {
        let memory = StorageBudget::new(8_000_000);
        let state = state(&memory);
        let empty = state.borrow().declaration_storage("h", true).ok().unwrap();
        for i in 0..9000 {
            commit(&state, element(&format!("k{i}"), Some(i.to_string()))).unwrap();
        }
        assert_eq!(
            state.borrow().declaration_storage("h", true).ok().unwrap(),
            empty
        );
    }
    #[test]
    fn failed_local_type_admission_does_not_publish_a_shadow() {
        let memory = StorageBudget::new(1_000_000);
        let (state, before) = original(&memory);
        let frame = super::super::FunctionFrame::enter(state.clone(), Vec::new(), 100).unwrap();
        let local_bytes = state.borrow().declaration_storage("h", true).ok().unwrap() + 1;
        for remaining in [0, Associative::default_storage_bytes(), local_bytes] {
            let pressure = memory.admit(1_000_000 - before - remaining).unwrap();
            assert_eq!(
                state.borrow_mut().declare_associative("h".into(), true),
                Err(RESOURCE_STATUS)
            );
            assert_eq!(state.borrow().associative_element("h", "key"), Some("old"));
            assert!(!state.borrow().locals.last().unwrap().contains_key("h"));
            drop(pressure);
            assert_eq!(memory.observation().0, before);
        }
        drop(frame);
        assert_eq!(memory.observation().0, before);
        drop(state);
        assert_eq!(memory.observation().0, 0);
    }
    #[test]
    fn local_type_preparation_preserves_prefix_redeclaration_and_readonly_rules() {
        let memory = StorageBudget::new(1_000_000);
        let (state, before) = original(&memory);
        let mut frame = super::super::FunctionFrame::enter(state.clone(), Vec::new(), 100).unwrap();
        frame.prefixes(vec![("h".into(), "prefix".into())]).unwrap();
        state
            .borrow_mut()
            .declare_associative("h".into(), true)
            .unwrap();
        assert_eq!(state.borrow().associative_element("h", "0"), Some("prefix"));
        commit(&state, element("local", Some("value".into()))).unwrap();
        state
            .borrow_mut()
            .declare_associative("h".into(), true)
            .unwrap();
        assert_eq!(
            state.borrow().associative_element("h", "local"),
            Some("value")
        );
        state.borrow_mut().readonly("h".into(), None).unwrap();
        assert_eq!(
            state.borrow_mut().declare_associative("h".into(), true),
            Err(1)
        );
        drop(frame);
        assert_eq!(state.borrow().associative_element("h", "key"), Some("old"));
        assert_eq!(memory.observation().0, before);
    }
    #[test]
    fn growth_undo_is_constant_size() {
        let mut values = Associative::default();
        for i in 0..8192 {
            values.insert(format!("k{i}"), i.to_string()).unwrap();
        }
        let binding = Binding::Associative(Rc::new(values));
        assert_eq!(
            element("growth", Some("v".into())).undo_bytes(Some(&binding)),
            0
        );
    }
    #[test]
    fn collision_removal_accounts_for_retained_storage() {
        let memory = StorageBudget::new(1_000_000);
        let mut values = Associative::with_buckets(1024, false, Some(memory.clone()));
        values.admit_header().unwrap();
        let keys: Vec<_> = (0..1_000_000)
            .map(|i| format!("collision{i}"))
            .filter(|key| Associative::hash(key) & 1023 == 0)
            .take(512)
            .collect();
        for key in &keys {
            values.insert(key.clone(), "v".into()).unwrap();
        }
        for key in keys.iter().skip(1) {
            values.remove(key).unwrap();
        }
        assert_eq!(values.count(), 1);
        assert_eq!(memory.observation().0, values.storage_bytes());
        assert!(values.storage_bytes() < 4096);
        values.remove(&keys[0]).unwrap();
        assert_eq!(memory.observation().0, Associative::default_storage_bytes());
        drop(values);
        assert_eq!(memory.observation().0, 0);
    }
    #[test]
    fn associative_globals_own_and_refund_live_storage() {
        let memory = StorageBudget::new(100_000);
        let state = state(&memory);
        assert_eq!(memory.observation().0, Associative::default_storage_bytes());
        drop(state);
        assert_eq!(memory.observation().0, 0);
    }
    #[test]
    fn persistent_storage_tracks_unique_shared_and_unset_owners() {
        let memory = StorageBudget::new(1_000_000);
        let (state, before) = original(&memory);
        assert_eq!(before, state.borrow().binding("h").unwrap().storage_bytes());
        let snapshot = state.borrow().binding("h").unwrap().clone();
        commit(&state, element("key", Some("new".into()))).unwrap();
        assert_eq!(memory.observation().0, before * 2);
        assert_eq!(snapshot.as_str(), "");
        let Binding::Associative(saved) = snapshot else {
            unreachable!()
        };
        assert_eq!(saved.get("key").unwrap(), "old");
        drop(saved);
        assert_eq!(memory.observation().0, before);
        commit(&state, element("key", None)).unwrap();
        assert_eq!(memory.observation().0, Associative::default_storage_bytes());
        drop(state);
        assert_eq!(memory.observation().0, 0);
    }
    #[test]
    fn growth_admission_failure_is_atomic_and_refunds_all_tickets() {
        let memory = StorageBudget::new(8_000_000);
        let state = populated(&memory, 2048);
        let before = memory.observation().0;
        let original = {
            let state = state.borrow();
            let Some(Binding::Associative(values)) = state.binding("h") else {
                unreachable!()
            };
            order(values)
        };
        let pressure = memory.admit(8_000_000 - before - 1024).unwrap();
        assert!(commit(&state, element("growth", Some("new".into()))).is_err());
        assert_eq!(memory.observation().0, 8_000_000 - 1024);
        drop(pressure);
        assert_eq!(memory.observation().0, before);
        let state_ref = state.borrow();
        let Some(Binding::Associative(values)) = state_ref.binding("h") else {
            unreachable!()
        };
        assert_eq!(order(values), original);
        assert_eq!(values.bucket_count, 1024);
        drop(state_ref);
        commit(&state, element("growth", Some("new".into()))).unwrap();
        drop(state);
        assert_eq!(memory.observation().0, 0);
    }
    #[test]
    fn rollback_after_a_retained_postwrite_snapshot_needs_no_allocation() {
        let memory = StorageBudget::new(1_000_000);
        let (state, before, journal) = pending_update(&memory);
        let snapshot = state.borrow().binding("h").unwrap().clone();
        let pressure = memory.admit(1_000_000 - memory.observation().0).unwrap();
        drop(journal);
        let Binding::Associative(saved) = snapshot else {
            unreachable!()
        };
        assert_eq!(saved.get("key").unwrap(), "new");
        assert_eq!(state.borrow().associative_element("h", "key"), Some("old"));
        drop(pressure);
        drop(saved);
        assert_eq!(memory.observation().0, before);
        drop(state);
        assert_eq!(memory.observation().0, 0);
    }
    #[test]
    fn shared_update_copies_a_bounded_path_not_the_whole_map() {
        let memory = StorageBudget::new(8_000_000);
        let state = populated(&memory, 4500);
        let snapshot = state.borrow().binding("h").unwrap().clone();
        let before = memory.observation().0;
        commit(&state, element("new", Some("value".into()))).unwrap();
        assert!(memory.observation().0 - before < 10_000);
        let Binding::Associative(saved) = snapshot else {
            unreachable!()
        };
        assert!(saved.get("new").is_none());
        drop(saved);
        assert_eq!(
            memory.observation().0,
            state.borrow().binding("h").unwrap().storage_bytes()
        );
        drop(state);
        assert_eq!(memory.observation().0, 0);
    }
    #[test]
    fn deterministic_incremental_update_cost_is_near_linear() {
        let mut values = Associative::default();
        let mut steps = 0usize;
        let mut storage = 0usize;
        for i in 0usize..33_000 {
            let key = format!("k{i}");
            let next_steps = values.mutation_steps(&key, true);
            assert!(
                next_steps < 262_144 + 1_048_576 + 65_536,
                "i={i} steps={next_steps}"
            );
            steps += next_steps;
            storage += values.growth_bytes(&key);
            values.insert(key, i.to_string()).unwrap();
            if [250, 500, 1000, 2000, 8193, 33_000].contains(&(i + 1)) {
                assert!(steps < (i + 1) * (i + 1).ilog2() as usize * 160);
                assert!(storage < (i + 1) * (Associative::node_bytes() + 16));
                println!("assoc-cost n={} steps={steps} new_storage={storage}", i + 1);
            }
        }
    }
    #[test]
    fn snapshots_restore_growth_and_collision_order() {
        let mut values = Associative::default();
        for i in 0..2048 {
            values.insert(format!("k{i}"), i.to_string()).unwrap();
        }
        let previous = values.copy().unwrap();
        values.insert("grows".into(), "new".into()).unwrap();
        assert_eq!(values.bucket_count, 4096);
        assert_eq!(previous.bucket_count, 1024);
        values = previous;
        let before = order(&values);
        let previous = values.copy().unwrap();
        values.remove("k0").unwrap();
        values = previous;
        assert_eq!(order(&values), before);
    }
    fn scalar_failure(slack: usize) {
        let memory = StorageBudget::new(1_000_000);
        let (state, before, journal) = pending_update(&memory);
        let pressure = memory
            .admit(1_000_000 - memory.observation().0 - slack)
            .unwrap();
        let result = state
            .borrow_mut()
            .assign_parameter("h".into(), "scalar".into());
        if result.is_err() {
            assert_eq!(state.borrow().associative_element("h", "0"), None);
        }
        drop(journal);
        assert_eq!(state.borrow().associative_element("h", "key"), Some("old"));
        let value = if result.is_ok() { Some("scalar") } else { None };
        assert_eq!(state.borrow().associative_element("h", "0"), value);
        drop(pressure);
        if result.is_err() {
            assert_eq!(memory.observation().0, before);
        }
        drop(state);
        assert_eq!(memory.observation().0, 0);
    }
    #[test]
    fn scalar_effect_preparation_is_atomic_under_memory_pressure() {
        for slack in [0, 256, 512, 768, 1024, 2048, 4096] {
            scalar_failure(slack);
        }
    }
    #[test]
    fn growth_failure_halfway_through_new_topology_refunds_every_node() {
        let memory = StorageBudget::new(8_000_000);
        let state = populated(&memory, 2048);
        let before = memory.observation().0;
        let slack = 2048
            * (std::mem::size_of::<(Position, Rc<Entry>, usize)>()
                + std::mem::size_of::<(Position, Rc<Entry>)>())
            + 4096 * std::mem::size_of::<usize>()
            + 1024 * tree::bytes();
        let pressure = memory.admit(8_000_000 - before - slack).unwrap();
        assert!(commit(&state, element("growth", Some("new".into()))).is_err());
        assert_eq!(memory.observation().0, 8_000_000 - slack);
        assert!(memory.observation().1 > 8_000_000 - slack + 100_000);
        drop(pressure);
        assert_eq!(memory.observation().0, before);
        assert_eq!(state.borrow().array_count("h"), 2048);
        drop(state);
        assert_eq!(memory.observation().0, 0);
    }
    fn count_allocation(
        node: &tree::Node,
        nodes: &mut std::collections::BTreeSet<*const tree::Node>,
        entries: &mut std::collections::BTreeSet<*const Entry>,
    ) -> usize {
        let bytes = usize::from(nodes.insert(node as *const tree::Node)) * tree::bytes();
        if !entries.insert(Rc::as_ptr(&node.entry)) {
            return bytes;
        }
        bytes + Entry::bytes() + node.entry.key.capacity() + node.entry.value.capacity()
    }
    fn forest_bytes(values: &[&Associative]) -> usize {
        let mut nodes = std::collections::BTreeSet::new();
        let mut entries = std::collections::BTreeSet::new();
        let mut bytes = values.len() * Associative::default_storage_bytes();
        for values in values {
            tree::visit(&values.entries, &mut |node| {
                bytes += count_allocation(node, &mut nodes, &mut entries);
            });
        }
        bytes
    }
    #[test]
    fn every_shared_node_and_payload_has_exactly_one_live_ticket() {
        let memory = StorageBudget::new(1_000_000);
        let mut values = Associative::with_buckets(1024, false, Some(memory.clone()));
        values.admit_header().unwrap();
        for i in 0..100 {
            values.insert(format!("k{i}"), i.to_string()).unwrap();
        }
        let saved = values.copy().unwrap();
        for i in 0..50 {
            values.remove(&format!("k{i}")).unwrap();
        }
        let second = values.copy().unwrap();
        for i in 100..200 {
            values.insert(format!("k{i}"), i.to_string()).unwrap();
        }
        assert_eq!(
            memory.observation().0,
            forest_bytes(&[&values, &saved, &second])
        );
        drop(saved);
        assert_eq!(memory.observation().0, forest_bytes(&[&values, &second]));
        drop(second);
        assert_eq!(memory.observation().0, values.storage_bytes());
        drop(values);
        assert_eq!(memory.observation().0, 0);
    }
}
