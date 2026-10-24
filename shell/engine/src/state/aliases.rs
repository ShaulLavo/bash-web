use super::State;
use crate::exec::{RESOURCE_STATUS, StorageAllocation, StorageBudget};
use std::{collections::HashMap, mem::size_of, rc::Rc, sync::Arc};

#[derive(Clone, Debug, Default)]
pub(crate) struct Aliases {
    version: Option<Rc<Version>>,
    revision: u64,
}

#[derive(Debug)]
struct Version {
    values: Arc<HashMap<String, String>>,
    bytes: usize,
    slots: usize,
    memory: Option<StorageAllocation>,
}

struct Change {
    count: usize,
    text: usize,
    slots: usize,
    incoming: usize,
    grow: bool,
}

impl Change {
    fn storage(&self) -> Result<usize, i32> {
        self.text
            .checked_add(self.slots)
            .and_then(|bytes| {
                bytes.checked_add(size_of::<Version>() + size_of::<HashMap<String, String>>() + 64)
            })
            .ok_or(RESOURCE_STATUS)
    }
}

impl Aliases {
    pub(crate) fn values(&self) -> Option<&HashMap<String, String>> {
        self.version.as_ref().map(|version| version.values.as_ref())
    }

    pub(crate) fn parser_values(&self) -> Option<Arc<HashMap<String, String>>> {
        self.version.as_ref().map(|version| version.values.clone())
    }

    pub(crate) fn revision(&self) -> u64 {
        self.revision
    }

    pub(crate) fn bytes(&self) -> usize {
        self.version.as_ref().map_or(0, |version| version.bytes)
    }

    fn unique(&self) -> bool {
        self.version.as_ref().is_some_and(|version| {
            Rc::strong_count(version) == 1 && Arc::strong_count(&version.values) == 1
        })
    }

    fn change(&self, name: &str, value: Option<&str>) -> Result<Option<Change>, i32> {
        let old = self.values();
        let previous = old.and_then(|values| values.get(name));
        if previous.map(String::as_str) == value {
            return Ok(None);
        }
        let count = old.map_or(0, HashMap::len) - usize::from(previous.is_some())
            + usize::from(value.is_some());
        let removed = previous.map_or(0, |value| name.len() + value.len());
        let incoming = value.map_or(0, |value| name.len() + value.len());
        let text = self
            .bytes()
            .checked_sub(removed)
            .and_then(|bytes| bytes.checked_add(incoming))
            .ok_or(RESOURCE_STATUS)?;
        let grow = count > old.map_or(0, HashMap::capacity);
        let slots = table_slots(count)?;
        let slots = if self.unique() {
            let retained = self.version.as_ref().unwrap().slots;
            if grow {
                retained.checked_mul(2).ok_or(RESOURCE_STATUS)?.max(slots)
            } else {
                retained
            }
        } else {
            slots
        };
        Ok(Some(Change {
            count,
            text,
            slots,
            incoming,
            grow,
        }))
    }
}

impl State {
    pub(crate) fn aliases(&self) -> Aliases {
        self.aliases.clone()
    }

    pub(crate) fn clear_aliases(&mut self) -> Result<(), i32> {
        if self.aliases.version.is_none() {
            return Ok(());
        }
        let revision = self
            .aliases
            .revision
            .checked_add(1)
            .ok_or(RESOURCE_STATUS)?;
        self.aliases = Aliases {
            version: None,
            revision,
        };
        Ok(())
    }

    pub(crate) fn alias_update_work(
        &self,
        name: &str,
        value: Option<&str>,
    ) -> Result<(u64, usize), i32> {
        let revision = self.aliases.revision;
        let Some(change) = self.aliases.change(name, value)? else {
            return Ok((revision, 0));
        };
        if self.aliases.unique() && !change.grow {
            return Ok((revision, 0));
        }
        // Only a real snapshot copy or a table rehash visits existing entries.
        let Some(version) = &self.aliases.version else {
            return Ok((revision, 0));
        };
        let buckets = version.slots / (size_of::<(String, String)>() + 1);
        let copied_text = if self.aliases.unique() {
            0
        } else {
            version.bytes
        };
        let work = buckets.checked_add(copied_text).ok_or(RESOURCE_STATUS)?;
        Ok((revision, work))
    }

    pub(crate) fn update_alias(&mut self, name: &str, value: Option<&str>) -> Result<(), i32> {
        let Some(change) = self.aliases.change(name, value)? else {
            return Ok(());
        };
        let revision = self
            .aliases
            .revision
            .checked_add(1)
            .ok_or(RESOURCE_STATUS)?;
        if change.count == 0 {
            return self.clear_aliases();
        }
        if self.aliases.unique() {
            let version = Rc::get_mut(self.aliases.version.as_mut().unwrap()).unwrap();
            version.update(name, value, change)?;
            self.aliases.revision = revision;
            return Ok(());
        }
        let version = Version::copy(
            self.aliases.values(),
            name,
            value,
            change,
            self.memory.as_ref(),
        )?;
        self.aliases = Aliases {
            version: Some(Rc::new(version)),
            revision,
        };
        Ok(())
    }
}

impl Version {
    fn copy(
        old: Option<&HashMap<String, String>>,
        name: &str,
        value: Option<&str>,
        change: Change,
        budget: Option<&StorageBudget>,
    ) -> Result<Self, i32> {
        let memory = budget
            .map(|budget| budget.admit(change.storage()?))
            .transpose()
            .map_err(|_| RESOURCE_STATUS)?;
        let mut values = HashMap::new();
        values
            .try_reserve(change.count)
            .map_err(|_| RESOURCE_STATUS)?;
        for (key, value) in old
            .into_iter()
            .flatten()
            .filter(|(key, _)| key.as_str() != name)
        {
            values.insert(copy_string(key)?, copy_string(value)?);
        }
        if let Some(value) = value {
            values.insert(copy_string(name)?, copy_string(value)?);
        }
        Ok(Self {
            values: Arc::new(values),
            bytes: change.text,
            slots: change.slots,
            memory,
        })
    }

    fn update(&mut self, name: &str, value: Option<&str>, mut change: Change) -> Result<(), i32> {
        change.storage()?;
        let old_charge = self.memory.as_ref().map_or(0, StorageAllocation::bytes);
        let temporary = old_charge
            .checked_add(change.incoming)
            .and_then(|bytes| bytes.checked_add(if change.grow { change.slots } else { 0 }))
            .ok_or(RESOURCE_STATUS)?;
        if let Some(memory) = &mut self.memory {
            memory.resize(temporary).map_err(|_| RESOURCE_STATUS)?;
        }
        let result = self.prepare_update(name, value, &change);
        if let Err(error) = result {
            self.resize(old_charge);
            return Err(error);
        }
        if change.grow {
            change.slots =
                table_slots(self.values.capacity()).expect("admitted alias table layout");
        }
        self.bytes = change.text;
        self.slots = change.slots;
        self.resize(change.storage().expect("admitted alias update layout"));
        Ok(())
    }

    fn prepare_update(
        &mut self,
        name: &str,
        value: Option<&str>,
        change: &Change,
    ) -> Result<(), i32> {
        let values = Arc::get_mut(&mut self.values).unwrap();
        let Some(value) = value else {
            values.remove(name);
            return Ok(());
        };
        let incoming = (copy_string(name)?, copy_string(value)?);
        values
            .try_reserve(change.count.saturating_sub(values.len()))
            .map_err(|_| RESOURCE_STATUS)?;
        values.insert(incoming.0, incoming.1);
        Ok(())
    }

    fn resize(&mut self, bytes: usize) {
        if let Some(memory) = &mut self.memory {
            // Admission preceded every allocation; publication only refunds.
            memory
                .resize(bytes)
                .expect("alias update exceeded its admitted storage");
        }
    }
}

fn copy_string(value: &str) -> Result<String, i32> {
    let mut copy = String::new();
    copy.try_reserve_exact(value.len())
        .map_err(|_| RESOURCE_STATUS)?;
    copy.push_str(value);
    Ok(copy)
}

fn table_slots(count: usize) -> Result<usize, i32> {
    // Cover power-of-two buckets, the seven-eighths load factor and control bytes.
    count
        .checked_mul(8)
        .and_then(|count| count.checked_add(6))
        .and_then(|count| count.checked_div(7))
        .and_then(usize::checked_next_power_of_two)
        .map(|buckets| buckets.max(4))
        .and_then(|buckets| buckets.checked_mul(size_of::<(String, String)>() + 1))
        .ok_or(RESOURCE_STATUS)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exec::StorageBudget;

    fn assert_same_version(state: &State, snapshot: &Aliases) {
        assert!(Rc::ptr_eq(
            snapshot.version.as_ref().unwrap(),
            state.aliases.version.as_ref().unwrap()
        ));
        assert_eq!(snapshot.revision(), state.aliases.revision());
    }

    #[test]
    fn alias_versions_keep_their_charge_until_the_last_reader_drops() {
        let memory = StorageBudget::new(4096);
        let mut state = State::with_memory(memory.clone());
        state.update_alias("x", Some("echo old")).unwrap();
        let reader = state.aliases();
        let charged = memory.observation().0;
        state.update_alias("x", Some("echo new")).unwrap();
        assert!(memory.observation().0 > charged);
        assert_eq!(reader.values().unwrap()["x"], "echo old");
        state.clear_aliases().unwrap();
        assert_eq!(memory.observation().0, charged);
        drop(reader);
        assert_eq!(memory.observation().0, 0);
    }

    #[test]
    fn alias_replacement_rejects_growth_atomically_and_unchanged_bindings_share() {
        let memory = StorageBudget::new(2048);
        let mut state = State::with_memory(memory.clone());
        state.update_alias("x", Some("echo old")).unwrap();
        let old = state.aliases();
        let charged = memory.observation().0;
        state.update_alias("x", Some("echo old")).unwrap();
        assert_same_version(&state, &old);
        assert_eq!(
            state.update_alias("x", Some(&"a".repeat(2048))),
            Err(RESOURCE_STATUS)
        );
        assert_same_version(&state, &old);
        assert_eq!(memory.observation().0, charged);
    }
    #[test]
    fn unique_alias_updates_do_not_copy_existing_string_buffers() {
        let mut state = State::with_memory(StorageBudget::new(1_000_000));
        state.update_alias("anchor", Some("unchanged")).unwrap();
        let value = state.aliases.values().unwrap()["anchor"].as_ptr();
        for n in 0..1024 {
            state.update_alias(&format!("b{n}"), Some(":")).unwrap();
            assert_eq!(state.aliases.values().unwrap()["anchor"].as_ptr(), value);
        }
        for n in 0..1024 {
            state.update_alias(&format!("b{n}"), Some("new")).unwrap();
            state.update_alias(&format!("b{n}"), None).unwrap();
            assert_eq!(state.aliases.values().unwrap()["anchor"].as_ptr(), value);
        }
    }

    #[test]
    fn alias_table_work_is_amortized_across_unique_definitions_and_redefinitions() {
        let mut state = State::with_memory(StorageBudget::new(20_000_000));
        let mut work = 0;
        for n in 0..32_000 {
            let name = format!("b{n}");
            work += state.alias_update_work(&name, Some(":")).unwrap().1;
            state.update_alias(&name, Some(":")).unwrap();
        }
        assert!(work < 32_000 * 4, "unique definition work: {work}");
        let revision = state.aliases.revision();
        for n in 0..32_000 {
            let name = format!("b{n}");
            assert_eq!(state.alias_update_work(&name, Some("new")).unwrap().1, 0);
            state.update_alias(&name, Some("new")).unwrap();
            assert_eq!(state.alias_update_work(&name, None).unwrap().1, 0);
            state.update_alias(&name, None).unwrap();
        }
        assert_eq!(state.aliases.revision(), revision + 64_000);
        assert!(state.aliases.values().is_none());
    }

    #[test]
    fn alias_work_plan_detects_new_snapshots_without_a_revision_change() {
        let mut state = State::with_memory(StorageBudget::new(4096));
        state.update_alias("x", Some("old")).unwrap();
        let unique = state.alias_update_work("x", Some("new")).unwrap();
        assert_eq!(unique.1, 0);
        let snapshot = state.aliases();
        let shared = state.alias_update_work("x", Some("new")).unwrap();
        assert_eq!(unique.0, shared.0);
        assert!(shared.1 > unique.1);
        drop(snapshot);
        assert_eq!(state.alias_update_work("x", Some("new")).unwrap(), unique);
    }

    #[test]
    fn unique_alias_growth_rejection_preserves_contents_revision_and_charge() {
        let memory = StorageBudget::new(4096);
        let mut state = State::with_memory(memory.clone());
        state.update_alias("x", Some("old")).unwrap();
        let revision = state.aliases.revision();
        let charged = memory.observation().0;
        let blocker = memory.admit(4096 - charged - 1).unwrap();
        assert_eq!(
            state.update_alias("x", Some("a longer value")),
            Err(RESOURCE_STATUS)
        );
        assert_eq!(
            state.update_alias("new", Some("value")),
            Err(RESOURCE_STATUS)
        );
        assert_eq!(state.aliases.revision(), revision);
        assert_eq!(state.aliases.values().unwrap().len(), 1);
        assert_eq!(state.aliases.values().unwrap()["x"], "old");
        drop(blocker);
        assert_eq!(memory.observation().0, charged);
        state.clear_aliases().unwrap();
        assert_eq!(memory.observation().0, 0);
    }

    #[test]
    fn alias_rehash_rejects_before_mutation_and_refunds_after_replacement() {
        let memory = StorageBudget::new(4096);
        let mut state = State::with_memory(memory.clone());
        for name in ["x", "y", "z"] {
            state.update_alias(name, Some("long value")).unwrap();
        }
        let charged = memory.observation().0;
        let revision = state.aliases.revision();
        let blocker = memory.admit(4096 - charged - 8).unwrap();
        assert_eq!(state.update_alias("n", Some(":")), Err(RESOURCE_STATUS));
        assert_eq!(state.aliases.revision(), revision);
        assert_eq!(state.aliases.values().unwrap().len(), 3);
        drop(blocker);
        state.update_alias("x", Some(":")).unwrap();
        assert_eq!(memory.observation().0, charged - 9);
        let slots = state.aliases.version.as_ref().unwrap().slots;
        state.update_alias("y", None).unwrap();
        assert_eq!(state.aliases.version.as_ref().unwrap().slots, slots);
        state.clear_aliases().unwrap();
        assert_eq!(memory.observation().0, 0);
    }

    #[test]
    fn genuine_alias_snapshots_copy_only_after_full_admission() {
        let memory = StorageBudget::new(4096);
        let mut state = State::with_memory(memory.clone());
        state.update_alias("x", Some("old")).unwrap();
        let snapshot = state.aliases();
        let charged = memory.observation().0;
        let blocker = memory.admit(4096 - charged - 8).unwrap();
        assert!(state.alias_update_work("x", Some("new")).unwrap().1 > 0);
        assert_eq!(state.update_alias("x", Some("new")), Err(RESOURCE_STATUS));
        assert_eq!(state.aliases.revision(), snapshot.revision());
        drop(blocker);
        state.update_alias("x", Some("new")).unwrap();
        assert_eq!(snapshot.values().unwrap()["x"], "old");
        assert_eq!(state.aliases.values().unwrap()["x"], "new");
        assert_eq!(memory.observation().0, 2 * charged);
        drop(snapshot);
        assert_eq!(memory.observation().0, charged);
        state.clear_aliases().unwrap();
        let revision = state.aliases.revision();
        state.clear_aliases().unwrap();
        state.update_alias("absent", None).unwrap();
        assert_eq!(state.aliases.revision(), revision);
        assert_eq!(memory.observation().0, 0);
    }
    #[test]
    fn alias_delete_insert_churn_keeps_actual_capacity_charged_without_inflation() {
        let memory = StorageBudget::new(20_000_000);
        let mut state = State::with_memory(memory.clone());
        for n in 0..1024 {
            state
                .update_alias(&format!("anchor{n}"), Some(":"))
                .unwrap();
        }
        let charged = memory.observation().0;
        for n in 0..10_000 {
            let name = format!("temporary{n}");
            state.update_alias(&name, Some(":")).unwrap();
            state.update_alias(&name, None).unwrap();
            assert!(memory.observation().0 <= charged * 4);
        }
        assert_eq!(state.aliases.values().unwrap().len(), 1024);
        state.clear_aliases().unwrap();
        assert_eq!(memory.observation().0, 0);
    }
}
