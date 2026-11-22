use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, BTreeSet};
use std::ops::Deref;
use std::rc::Rc;

use crate::exec::{RESOURCE_STATUS, StorageAllocation, StorageBudget};

use super::{SnapshotValue, tree_node_bytes};

#[derive(Debug)]
pub(super) struct SharedTree<T>(Rc<Version<T>>, Cell<bool>);

#[derive(Debug)]
struct Version<T> {
    tree: T,
    bytes: usize,
    copy: RefCell<Option<CopyMembership>>,
    cleanup: RefCell<Option<StorageAllocation>>,
}

#[derive(Debug, Default)]
struct CopyMembership {
    cohort: Rc<RefCell<CopyCohort>>,
    version: u64,
}

#[derive(Debug, Default)]
struct CopyCohort {
    next_version: u64,
    tickets: BTreeMap<u64, StorageAllocation>,
}

impl Drop for CopyMembership {
    fn drop(&mut self) {
        let mut cohort = self.cohort.borrow_mut();
        // When the uncharged version drops, one survivor takes its place.
        if cohort.tickets.remove(&self.version).is_none() {
            cohort.tickets.pop_first();
        }
    }
}

impl<T> Version<T> {
    fn fork_copy(&self, ticket: StorageAllocation, writer_keeps_charge: bool) -> CopyMembership {
        let mut copy = self.copy.borrow_mut();
        let parent = copy.get_or_insert_with(CopyMembership::default);
        let mut cohort = parent.cohort.borrow_mut();
        cohort.next_version += 1;
        let mut version = cohort.next_version;
        cohort.tickets.insert(version, ticket);
        if writer_keeps_charge {
            std::mem::swap(&mut parent.version, &mut version);
        }
        CopyMembership {
            cohort: parent.cohort.clone(),
            version,
        }
    }
}

impl<T: Default> Version<T> {
    fn refund_shrunk_copy(&mut self) {
        let membership = self.copy.get_mut();
        let Some(copy) = membership else {
            return;
        };
        if Rc::strong_count(&copy.cohort) == 1 {
            *membership = None;
            return;
        }
        let mut cohort = copy.cohort.borrow_mut();
        let Some(ticket) = cohort.tickets.get_mut(&copy.version) else {
            return;
        };
        let bytes = if self.bytes == 0 {
            self.tree = T::default();
            // Keep the zero-byte ticket to identify the charged version.
            0
        } else {
            self.bytes + SharedTree::<T>::version_bytes()
        };
        if bytes < ticket.bytes() {
            ticket.resize(bytes).expect("shrinking a tree ticket");
        }
    }
}

impl<T> Clone for SharedTree<T> {
    fn clone(&self) -> Self {
        Self(self.0.clone(), Cell::new(false))
    }
}

impl<T: Default> Default for SharedTree<T> {
    fn default() -> Self {
        Self::new(T::default(), 0, None)
    }
}

impl<T> Deref for SharedTree<T> {
    type Target = T;

    fn deref(&self) -> &T {
        &self.0.tree
    }
}

impl<T> SharedTree<T> {
    fn new(tree: T, bytes: usize, copy: Option<CopyMembership>) -> Self {
        Self(
            Rc::new(Version {
                tree,
                bytes,
                copy: RefCell::new(copy),
                cleanup: RefCell::new(None),
            }),
            Cell::new(false),
        )
    }

    fn version_bytes() -> usize {
        std::mem::size_of::<Version<T>>() + 2 * std::mem::size_of::<usize>()
    }

    pub(super) fn bytes(&self) -> usize {
        self.0.bytes
    }

    #[cfg(test)]
    pub(super) fn copy_bytes(&self) -> usize {
        self.0.copy.borrow().as_ref().map_or(0, |copy| {
            copy.cohort
                .borrow()
                .tickets
                .get(&copy.version)
                .map_or(0, StorageAllocation::bytes)
        })
    }

    #[cfg(test)]
    pub(super) fn cleanup_bytes(&self) -> usize {
        self.0
            .cleanup
            .borrow()
            .as_ref()
            .map_or(0, StorageAllocation::bytes)
    }

    pub(super) fn is_shared(&self) -> bool {
        Rc::strong_count(&self.0) > 1
    }

    pub(super) fn reserve_copy(
        &self,
        memory: Option<&StorageBudget>,
    ) -> Result<Option<StorageAllocation>, i32> {
        if !self.is_shared() || self.has_cleanup_copy() {
            return Ok(None);
        }
        memory.map(|budget| self.admit_copy(budget)).transpose()
    }

    fn admit_copy(&self, memory: &StorageBudget) -> Result<StorageAllocation, i32> {
        memory
            .admit(
                self.bytes()
                    .checked_add(Self::version_bytes())
                    .ok_or(RESOURCE_STATUS)?,
            )
            .map_err(|_| RESOURCE_STATUS)
    }

    pub(super) fn reserve_cleanup(
        &self,
        memory: &StorageBudget,
    ) -> Result<Option<StorageAllocation>, i32> {
        if self.has_cleanup_copy() {
            return Ok(None);
        }
        // A scope can only leave a pending table edit after writing its own
        // version. Inherited scopes have no cleanup guards in the child.
        assert!(self.0.cleanup.borrow().is_none());
        self.admit_copy(memory).map(Some)
    }

    pub(super) fn install_cleanup(&self, ticket: Option<StorageAllocation>) {
        if let Some(ticket) = ticket {
            self.1.set(true);
            *self.0.cleanup.borrow_mut() = Some(ticket);
        }
    }

    pub(super) fn take_cleanup_copy(&self) -> Option<StorageAllocation> {
        self.1
            .replace(false)
            .then(|| self.0.cleanup.borrow_mut().take())
            .flatten()
    }

    pub(super) fn has_cleanup_copy(&self) -> bool {
        self.1.get() && self.0.cleanup.borrow().is_some()
    }

    pub(super) fn require_cleanup_copy(&self, budgeted: bool) {
        assert!(
            !budgeted || !self.is_shared() || self.has_cleanup_copy(),
            "shared scope restoration requires a copy ticket"
        );
    }

    fn version_mut(&mut self) -> &mut Version<T> {
        Rc::get_mut(&mut self.0).expect("tree mutation requires a private version")
    }

    fn install_copy(&mut self, tree: T, bytes: usize, copy: Option<StorageAllocation>) {
        let cleanup = self.take_cleanup_copy();
        // A cleanup reservation pays for the version retained by snapshots.
        let writer_keeps_charge = cleanup.is_some();
        let membership = cleanup
            .or(copy)
            .map(|ticket| self.0.fork_copy(ticket, writer_keeps_charge));
        *self = Self::new(tree, bytes, membership);
    }
}

impl<T> Drop for SharedTree<T> {
    fn drop(&mut self) {
        self.take_cleanup_copy();
        if Rc::strong_count(&self.0) == 2 {
            self.0.cleanup.borrow_mut().take();
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn three_tree_versions_hold_one_copy_after_any_version_drops() {
        for first_drop in 0..3 {
            let memory = StorageBudget::new(128 * 1024);
            let root: SharedTree<BTreeMap<String, String>> =
                [("payload".into(), "x".repeat(8192))].into_iter().collect();
            let mut left = root.clone();
            let mut right = root.clone();
            left.make_private(left.reserve_copy(Some(&memory)).unwrap());
            let one_copy = memory.observation().0;
            assert!(one_copy >= 8192);
            right.make_private(right.reserve_copy(Some(&memory)).unwrap());
            assert_eq!(memory.observation().0, 2 * one_copy);

            let mut versions = vec![root, left, right];
            drop(versions.remove(first_drop));
            assert_eq!(memory.observation().0, one_copy);
            drop(versions.pop());
            assert_eq!(memory.observation().0, 0);
        }
    }

    #[test]
    fn shrunk_tree_refunds_its_own_copy_and_admits_a_new_fork_after_growth() {
        let memory = StorageBudget::new(128 * 1024);
        let root: SharedTree<BTreeMap<String, String>> =
            [("payload".into(), "x".repeat(8192))].into_iter().collect();
        let mut edited = root.clone();
        edited.make_private(edited.reserve_copy(Some(&memory)).unwrap());
        let first_copy = edited.copy_bytes();
        edited.insert("payload".into(), "short".into());
        assert_eq!(memory.observation().0, first_copy - 8192 + 5);
        edited.remove("payload");
        assert_eq!(memory.observation().0, 0);

        edited.insert("payload".into(), "y".repeat(16384));
        let mut fork = edited.clone();
        fork.make_private(fork.reserve_copy(Some(&memory)).unwrap());
        let second_copy = first_copy + 8192;
        assert_eq!(memory.observation().0, second_copy);
        drop(root);
        assert_eq!(memory.observation().0, second_copy);
        drop(edited);
        assert_eq!(memory.observation().0, 0);
        assert_eq!(fork["payload"].len(), 16384);
    }
}
