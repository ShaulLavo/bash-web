use super::State;
use crate::exec::{RESOURCE_STATUS, StorageAllocation};
use std::{collections::HashMap, mem::size_of, rc::Rc, sync::Arc};

#[derive(Clone, Debug, Default)]
pub(crate) struct Aliases(Option<Rc<Version>>);

#[derive(Debug)]
struct Version {
    values: Arc<HashMap<String, String>>,
    bytes: usize,
    _memory: Option<StorageAllocation>,
}

impl Aliases {
    pub(crate) fn values(&self) -> Option<&HashMap<String, String>> {
        self.0.as_ref().map(|version| version.values.as_ref())
    }

    pub(crate) fn parser_values(&self) -> Option<Arc<HashMap<String, String>>> {
        self.0.as_ref().map(|version| version.values.clone())
    }

    pub(crate) fn same(&self, other: &Self) -> bool {
        match (&self.0, &other.0) {
            (None, None) => true,
            (Some(left), Some(right)) => Rc::ptr_eq(left, right),
            _ => false,
        }
    }

    pub(crate) fn bytes(&self) -> usize {
        self.0.as_ref().map_or(0, |version| version.bytes)
    }
}

impl State {
    pub(crate) fn aliases(&self) -> Aliases {
        self.aliases.clone()
    }

    pub(crate) fn clear_aliases(&mut self) {
        self.aliases = Aliases::default();
    }

    pub(crate) fn update_alias(&mut self, name: &str, value: Option<&str>) -> Result<(), i32> {
        let old = self.aliases.values();
        let previous = old.and_then(|values| values.get(name));
        if previous.map(String::as_str) == value {
            return Ok(());
        }
        let count = old.map_or(0, HashMap::len)
            - usize::from(old.is_some_and(|values| values.contains_key(name)))
            + usize::from(value.is_some());
        if count == 0 {
            self.clear_aliases();
            return Ok(());
        }
        let removed = previous.map_or(0, |value| name.len() + value.len());
        let incoming = value.map_or(0, |value| name.len() + value.len());
        let text = self
            .aliases
            .bytes()
            .checked_sub(removed)
            .and_then(|bytes| bytes.checked_add(incoming))
            .ok_or(RESOURCE_STATUS)?;
        // HashMap uses power-of-two buckets, with at least four buckets and
        // spare capacity for its seven-eighths load factor and control bytes.
        let buckets = count
            .checked_mul(8)
            .and_then(|count| count.checked_div(7))
            .and_then(|count| count.checked_add(1))
            .and_then(usize::checked_next_power_of_two)
            .ok_or(RESOURCE_STATUS)?
            .max(4);
        let slots = buckets
            .checked_mul(size_of::<(String, String)>() + 1)
            .ok_or(RESOURCE_STATUS)?;
        let bytes = text
            .checked_add(slots)
            .and_then(|bytes| {
                bytes.checked_add(size_of::<Version>() + size_of::<HashMap<String, String>>() + 64)
            })
            .ok_or(RESOURCE_STATUS)?;
        let memory = self
            .memory
            .as_ref()
            .map(|budget| budget.admit(bytes))
            .transpose()
            .map_err(|_| RESOURCE_STATUS)?;
        let mut values = HashMap::new();
        values.try_reserve(count).map_err(|_| RESOURCE_STATUS)?;
        for (key, value) in old.into_iter().flatten() {
            if key != name {
                values.insert(key.clone(), value.clone());
            }
        }
        if let Some(value) = value {
            values.insert(name.to_owned(), value.to_owned());
        }
        self.aliases = Aliases(Some(Rc::new(Version {
            values: Arc::new(values),
            bytes: text,
            _memory: memory,
        })));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exec::StorageBudget;

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
        state.clear_aliases();
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
        assert!(old.same(&state.aliases()));
        assert_eq!(
            state.update_alias("x", Some(&"a".repeat(2048))),
            Err(RESOURCE_STATUS)
        );
        assert!(old.same(&state.aliases()));
        assert_eq!(memory.observation().0, charged);
    }
    #[test]
    fn unique_alias_updates_do_not_copy_existing_string_buffers() {
        let mut state = State::with_memory(StorageBudget::new(1_000_000));
        state.update_alias("anchor", Some("unchanged")).unwrap();
        let value = state.aliases.values().unwrap()["anchor"].as_ptr();
        for n in 0..1024 {
            state.update_alias(&format!("b{n}"), Some(":" )).unwrap();
            assert_eq!(state.aliases.values().unwrap()["anchor"].as_ptr(), value);
        }
        for n in 0..1024 {
            state.update_alias(&format!("b{n}"), Some("new")).unwrap();
            state.update_alias(&format!("b{n}"), None).unwrap();
            assert_eq!(state.aliases.values().unwrap()["anchor"].as_ptr(), value);
        }
    }

}
