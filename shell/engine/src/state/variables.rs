use std::collections::BTreeMap;
use std::ops::{Bound, Index};

use crate::exec::{StorageAllocation, StorageBudget};

use super::{Binding, SharedTree, SnapshotValue, tree_node_bytes};

#[derive(Debug, Default)]
pub(crate) struct Variables {
    pub(super) ordinary: SharedTree<BTreeMap<String, Binding>>,
    // Simple commands publish $_ even in a child that only reads variables.
    // Its own slot keeps that publication from copying the inherited tree.
    last_argument: Option<(String, Binding)>,
}

impl Variables {
    pub(super) fn reserve_copy(
        &self,
        name: &str,
        memory: Option<&StorageBudget>,
    ) -> Result<Option<StorageAllocation>, i32> {
        if name == "_" {
            return Ok(None);
        }
        self.ordinary.reserve_copy(memory)
    }

    pub(super) fn make_private(&mut self, name: &str, copy: Option<StorageAllocation>) {
        if name != "_" {
            self.ordinary.make_private(copy);
        }
    }

    pub(super) fn snapshot(&self) -> Self {
        Self {
            ordinary: self.ordinary.clone(),
            last_argument: self
                .last_argument
                .as_ref()
                .map(|(name, value)| (name.clone(), value.detached())),
        }
    }

    pub(super) fn last_argument_bytes(&self) -> usize {
        self.get("_").map_or(0, Binding::storage_bytes)
    }

    pub(super) fn bytes(&self) -> usize {
        self.ordinary.bytes()
            + self.last_argument.as_ref().map_or(0, |(name, value)| {
                name.len() + tree_node_bytes::<Binding>() + value.storage_bytes()
            })
    }

    pub(crate) fn get(&self, name: &str) -> Option<&Binding> {
        if name == "_" {
            return self.last_argument.as_ref().map(|(_, value)| value);
        }
        self.ordinary.get(name)
    }

    pub(crate) fn contains_key(&self, name: &str) -> bool {
        self.get(name).is_some()
    }

    pub(super) fn insert(&mut self, name: String, value: Binding) -> Option<Binding> {
        if name == "_" {
            return self
                .last_argument
                .replace((name, value))
                .map(|(_, old)| old);
        }
        self.ordinary.insert(name, value)
    }

    pub(super) fn remove(&mut self, name: &str) -> Option<Binding> {
        if name == "_" {
            return self.last_argument.take().map(|(_, old)| old);
        }
        self.ordinary.remove(name)
    }

    pub(super) fn update(&mut self, name: &str, write: impl FnOnce(&mut Binding)) -> bool {
        if name != "_" {
            return self.ordinary.update(name, write);
        }
        let Some((_, value)) = &mut self.last_argument else {
            return false;
        };
        write(value);
        true
    }

    pub(super) fn replace_with<R>(
        &mut self,
        name: String,
        write: impl FnOnce(Option<Binding>) -> (Binding, R),
    ) -> R {
        if name != "_" {
            return self
                .ordinary
                .replace_with(name, String::new().into(), write);
        }
        let previous = self.last_argument.take().map(|(_, value)| value);
        let (value, result) = write(previous);
        self.last_argument = Some((name, value));
        result
    }

    pub(super) fn len(&self) -> usize {
        self.ordinary.len() + usize::from(self.last_argument.is_some())
    }

    pub(crate) fn keys(&self) -> impl Iterator<Item = &String> {
        self.iter().map(|(name, _)| name)
    }

    pub(crate) fn iter(&self) -> impl Iterator<Item = (&String, &Binding)> {
        let before = self
            .ordinary
            .range::<str, _>((Bound::Unbounded, Bound::Excluded("_")));
        let after = self
            .ordinary
            .range::<str, _>((Bound::Excluded("_"), Bound::Unbounded));
        before
            .chain(self.last_argument.iter().map(|(name, value)| (name, value)))
            .chain(after)
    }

    pub(crate) fn name_from(&self, lower: Bound<&str>) -> Option<&String> {
        let ordinary = self
            .ordinary
            .range::<str, _>((lower, Bound::Unbounded))
            .next()
            .map(|(name, _)| name);
        self.last_argument
            .iter()
            .map(|(name, _)| name)
            .filter(|_| match lower {
                Bound::Included(name) => name <= "_",
                Bound::Excluded(name) => name < "_",
                Bound::Unbounded => true,
            })
            .chain(ordinary)
            .min()
    }
}

impl Index<&str> for Variables {
    type Output = Binding;

    fn index(&self, name: &str) -> &Binding {
        self.get(name).expect("binding exists")
    }
}

impl FromIterator<(String, Binding)> for Variables {
    fn from_iter<I: IntoIterator<Item = (String, Binding)>>(items: I) -> Self {
        let mut variables = Self::default();
        for (name, value) in items {
            variables.insert(name, value);
        }
        variables
    }
}

impl SnapshotValue for Binding {
    fn snapshot_clone(&self) -> Result<Self, super::Error> {
        Ok(self.detached())
    }

    fn snapshot_bytes(&self) -> usize {
        self.storage_bytes()
    }

    fn detach_snapshot_value(&mut self) {
        if matches!(self, Binding::Indexed(_)) {
            *self = self.detached();
        }
    }
}
