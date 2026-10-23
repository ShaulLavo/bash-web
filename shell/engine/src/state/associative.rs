//! String-keyed bindings. Indexed assignment and its sparse integer API stay separate.
use super::{Binding, SharedState, State};
use crate::{
    exec::{Error, Work},
    executor::Cancel,
};
use std::{collections::BTreeMap, ops::Bound, rc::Rc};

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Associative {
    values: BTreeMap<String, String>,
    bytes: usize,
    value_bytes: usize,
}

impl Associative {
    pub(crate) fn get(&self, key: &str) -> Option<&String> {
        self.values.get(key)
    }
    pub(crate) fn count(&self) -> usize {
        self.values.len()
    }
    pub(crate) fn next(&self, previous: Option<&str>) -> Option<(&str, &str)> {
        let bounds = (
            previous.map_or(Bound::Unbounded, Bound::Excluded),
            Bound::Unbounded,
        );
        self.values
            .range::<str, _>(bounds)
            .next()
            .map(|(key, value)| (key.as_str(), value.as_str()))
    }
    pub(crate) fn storage_bytes(&self) -> usize {
        // One full 11-entry B-tree node per entry conservatively covers internal
        // pointers, partially occupied nodes, and the Rc/map headers.
        std::mem::size_of::<Self>()
            + 2 * std::mem::size_of::<usize>()
            + self.bytes
            + self.values.len() * Self::node_bytes()
    }
    pub(crate) fn node_bytes() -> usize {
        11 * 2 * std::mem::size_of::<String>() + 16 * std::mem::size_of::<usize>()
    }
    pub(crate) fn value_bytes(&self) -> usize {
        self.value_bytes
    }
    pub(crate) fn insert(&mut self, key: String, value: String) {
        if let Some(previous) = self.values.get_mut(&key) {
            self.bytes = self.bytes - previous.capacity() + value.capacity();
            self.value_bytes = self.value_bytes - previous.len() + value.len();
            *previous = value;
            return;
        }
        self.bytes += key.capacity() + value.capacity();
        self.value_bytes += value.len();
        self.values.insert(key, value);
    }
    pub(crate) fn remove(&mut self, key: &str) {
        let Some((key, value)) = self.values.remove_entry(key) else {
            return;
        };
        self.bytes -= key.capacity() + value.capacity();
        self.value_bytes -= value.len();
        if self.values.is_empty() {
            self.values = BTreeMap::new();
        }
    }
    pub(crate) async fn snapshot(
        state: &SharedState,
        name: &str,
        cancel: &Cancel,
        work: &mut Work,
    ) -> Result<Self, Error> {
        let source = match state.borrow().binding(name) {
            Some(Binding::Associative(values)) => Some(values.clone()),
            _ => None,
        };
        let Some(source) = source else {
            return Ok(Self::default());
        };
        work.admit_storage(source.storage_bytes())?;
        let mut result = Self::default();
        for (key, value) in &source.values {
            for _ in 0..key.len().saturating_add(value.len()).saturating_add(1) {
                work.checkpoint(cancel).await?;
            }
            result.insert(key.clone(), value.clone());
        }
        Ok(result)
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
        previous: Option<&str>,
    ) -> Option<(&str, &str)> {
        let Binding::Associative(values) = self.binding(name)? else {
            return None;
        };
        values.next(previous)
    }
    pub(crate) fn declare_associative(&mut self, name: String, local: bool) -> Result<(), i32> {
        if local {
            self.declare_local(name.clone(), None)?;
        }
        if self.is_associative(&name) {
            return Ok(());
        }
        if self.is_readonly(&name) || matches!(self.variables.get(&name), Some(Binding::Indexed(_)))
        {
            return Err(1);
        }
        let mut values = Associative::default();
        if let Some(Binding::Scalar(value)) = self.variables.get(&name) {
            values.insert("0".into(), value.clone());
        }
        self.reserve_local_value(&name, values.storage_bytes())?;
        self.variables
            .insert(name, Binding::Associative(Rc::new(values)));
        Ok(())
    }
}
