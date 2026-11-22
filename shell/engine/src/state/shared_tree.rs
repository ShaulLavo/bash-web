use std::collections::{BTreeMap, BTreeSet};
use std::ops::Deref;
use std::rc::Rc;

use crate::exec::{RESOURCE_STATUS, StorageAllocation, StorageBudget};

use super::{SnapshotValue, tree_node_bytes};

#[derive(Debug)]
pub(super) struct SharedTree<T>(Rc<Version<T>>);

#[derive(Debug)]
struct Version<T> {
    tree: T,
    bytes: usize,
    copy: Option<StorageAllocation>,
}

impl<T: Default> Version<T> {
    fn refund_shrunk_copy(&mut self) {
        let Some(copy) = &mut self.copy else {
            return;
        };
        if self.bytes == 0 {
            self.tree = T::default();
            self.copy = None;
            return;
        }
        let bytes = self.bytes + SharedTree::<T>::version_bytes();
        if bytes < copy.bytes() {
            copy.resize(bytes).expect("shrinking a tree ticket");
        }
    }
}

impl<T> Clone for SharedTree<T> {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}

impl<T: Default> Default for SharedTree<T> {
    fn default() -> Self {
        Self(Rc::new(Version {
            tree: T::default(),
            bytes: 0,
            copy: None,
        }))
    }
}

impl<T> Deref for SharedTree<T> {
    type Target = T;

    fn deref(&self) -> &T {
        &self.0.tree
    }
}

impl<T> SharedTree<T> {
    fn version_bytes() -> usize {
        std::mem::size_of::<Version<T>>() + 2 * std::mem::size_of::<usize>()
    }

    pub(super) fn bytes(&self) -> usize {
        self.0.bytes
    }

    #[cfg(test)]
    pub(super) fn copy_bytes(&self) -> usize {
        self.0.copy.as_ref().map_or(0, StorageAllocation::bytes)
    }

    pub(super) fn is_shared(&self) -> bool {
        Rc::strong_count(&self.0) > 1
    }

    pub(super) fn reserve_copy(
        &self,
        memory: Option<&StorageBudget>,
    ) -> Result<Option<StorageAllocation>, i32> {
        if !self.is_shared() {
            return Ok(None);
        }
        memory
            .map(|budget| budget.admit(self.bytes().checked_add(Self::version_bytes()).ok_or(2)?))
            .transpose()
            .map_err(|_| RESOURCE_STATUS)
    }

    fn version_mut(&mut self) -> &mut Version<T> {
        Rc::get_mut(&mut self.0).expect("tree mutation requires a private version")
    }

    fn install_copy(&mut self, tree: T, bytes: usize, copy: Option<StorageAllocation>) {
        self.0 = Rc::new(Version { tree, bytes, copy });
    }
}

impl<V: SnapshotValue> SharedTree<BTreeMap<String, V>> {
    pub(super) fn make_private(&mut self, copy: Option<StorageAllocation>) {
        if self.is_shared() {
            let mut tree = self.0.tree.clone();
            let bytes = tree
                .iter_mut()
                .map(|(name, value)| {
                    value.detach_snapshot_value();
                    name.len() + tree_node_bytes::<V>() + value.snapshot_bytes()
                })
                .sum();
            self.install_copy(tree, bytes, copy);
        }
    }

    pub(super) fn insert(&mut self, name: String, value: V) -> Option<V> {
        let version = self.version_mut();
        let new_bytes = value.snapshot_bytes();
        let key_bytes = name.len() + tree_node_bytes::<V>();
        let old = version.tree.insert(name, value);
        version.bytes += new_bytes;
        match &old {
            Some(old) => version.bytes -= old.snapshot_bytes(),
            None => version.bytes += key_bytes,
        }
        version.refund_shrunk_copy();
        old
    }

    pub(super) fn remove(&mut self, name: &str) -> Option<V> {
        if !self.contains_key(name) {
            return None;
        }
        let version = self.version_mut();
        let old = version.tree.remove(name).unwrap();
        version.bytes -= name.len() + tree_node_bytes::<V>() + old.snapshot_bytes();
        version.refund_shrunk_copy();
        Some(old)
    }

    pub(super) fn update(&mut self, name: &str, write: impl FnOnce(&mut V)) -> bool {
        let Some(version) = Rc::get_mut(&mut self.0) else {
            assert!(
                !self.contains_key(name),
                "tree mutation requires a private version"
            );
            return false;
        };
        let Some(value) = version.tree.get_mut(name) else {
            return false;
        };
        version.bytes -= value.snapshot_bytes();
        write(value);
        version.bytes += value.snapshot_bytes();
        version.refund_shrunk_copy();
        true
    }

    pub(super) fn replace_with<R>(
        &mut self,
        name: String,
        placeholder: V,
        write: impl FnOnce(Option<V>) -> (V, R),
    ) -> R {
        use std::collections::btree_map::Entry;

        let version = self.version_mut();
        let key_bytes = name.len() + tree_node_bytes::<V>();
        match version.tree.entry(name) {
            Entry::Occupied(mut entry) => {
                let previous = std::mem::replace(entry.get_mut(), placeholder);
                version.bytes -= previous.snapshot_bytes();
                let (value, result) = write(Some(previous));
                version.bytes += value.snapshot_bytes();
                *entry.get_mut() = value;
                version.refund_shrunk_copy();
                result
            }
            Entry::Vacant(entry) => {
                let (value, result) = write(None);
                version.bytes += key_bytes + value.snapshot_bytes();
                entry.insert(value);
                result
            }
        }
    }
}

impl SharedTree<BTreeSet<String>> {
    pub(super) fn make_private(&mut self, copy: Option<StorageAllocation>) {
        if self.is_shared() {
            self.install_copy(self.0.tree.clone(), self.bytes(), copy);
        }
    }

    pub(super) fn insert(&mut self, name: String) {
        if self.contains(&name) {
            return;
        }
        let version = self.version_mut();
        version.bytes += name.len() + tree_node_bytes::<()>();
        version.tree.insert(name);
    }

    pub(super) fn remove(&mut self, name: &str) {
        if !self.contains(name) {
            return;
        }
        let version = self.version_mut();
        version.bytes -= name.len() + tree_node_bytes::<()>();
        version.tree.remove(name);
        version.refund_shrunk_copy();
    }
}

impl<V: SnapshotValue> FromIterator<(String, V)> for SharedTree<BTreeMap<String, V>> {
    fn from_iter<I: IntoIterator<Item = (String, V)>>(items: I) -> Self {
        let mut tree = Self::default();
        for (name, value) in items {
            tree.insert(name, value);
        }
        tree
    }
}

impl FromIterator<String> for SharedTree<BTreeSet<String>> {
    fn from_iter<I: IntoIterator<Item = String>>(items: I) -> Self {
        let mut tree = Self::default();
        for name in items {
            tree.insert(name);
        }
        tree
    }
}
