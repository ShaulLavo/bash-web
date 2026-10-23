//! Explicit literal command paths. Snapshots share one immutable, admitted
//! AVL tree keyed by Bash bucket and name: lookups follow a single root path,
//! and updates copy only the nodes on it.
use super::{SharedState, State};
use crate::{
    exec::{Error, RESOURCE_STATUS, StorageAllocation, Work},
    executor::Cancel,
};
use std::{cmp::Ordering, mem::size_of, rc::Rc};

#[derive(Debug)]
pub(crate) struct Entry {
    pub(crate) name: String,
    pub(crate) path: String,
    bucket: u32,
    /// Insertion order; Bash lists the newest entry of a bucket first.
    serial: u64,
    _ticket: Option<StorageAllocation>,
}
type Link = Option<Rc<Node>>;
#[derive(Debug)]
struct Node {
    entry: Rc<Entry>,
    left: Link,
    right: Link,
    height: u8,
    _ticket: Option<StorageAllocation>,
}
#[derive(Clone, Debug, Default)]
pub(crate) struct CommandHash {
    root: Link,
    len: usize,
    serial: u64,
}
/// Entries in Bash listing order, holding their admitted pointer buffer.
pub(crate) struct Listing {
    entries: Vec<Rc<Entry>>,
    _ticket: Option<StorageAllocation>,
}
#[derive(Clone, Copy, Default, PartialEq)]
enum Side {
    #[default]
    Left,
    Right,
}
/// AVL height stays below 1.45 log2(n + 2), far under this for any address space.
const DEPTH: usize = 128;
/// The turns from the root to `name`'s node, or to the empty link it belongs in.
struct Path {
    turns: [Side; DEPTH],
    len: usize,
    found: Option<Rc<Entry>>,
}
/// Synchronous node construction once all charged work has completed.
struct Builder<'a>(&'a State);

const fn boxed<T>() -> usize {
    size_of::<T>() + 2 * size_of::<usize>()
}
async fn bucket(name: &str, cancel: &Cancel, work: &mut Work) -> Result<u32, Error> {
    let mut hash = 2166136261u32;
    work.checkpoint(cancel).await?;
    for byte in name.bytes() {
        work.checkpoint(cancel).await?;
        hash = hash.wrapping_mul(16777619) ^ u32::from(byte);
    }
    Ok(hash % 128)
}
fn height(link: &Link) -> u8 {
    link.as_ref().map_or(0, |node| node.height)
}
impl Side {
    fn other(self) -> Self {
        match self {
            Self::Left => Self::Right,
            Self::Right => Self::Left,
        }
    }
}
impl Node {
    fn child(&self, side: Side) -> &Link {
        match side {
            Side::Left => &self.left,
            Side::Right => &self.right,
        }
    }
    fn collect(&self, entries: &mut Vec<Rc<Entry>>) {
        if let Some(left) = &self.left {
            left.collect(entries);
        }
        entries.push(self.entry.clone());
        if let Some(right) = &self.right {
            right.collect(entries);
        }
    }
}
impl Listing {
    pub(crate) fn entries(&self) -> &[Rc<Entry>] {
        &self.entries
    }
}
impl CommandHash {
    pub(crate) fn is_empty(&self) -> bool {
        self.root.is_none()
    }
    #[cfg(test)]
    fn clear(&mut self) {
        *self = Self::default();
    }
    #[cfg(test)]
    pub(crate) fn entries(&self) -> Vec<Rc<Entry>> {
        let mut entries = Vec::new();
        self.ordered(&mut entries);
        entries
    }
    fn ordered(&self, entries: &mut Vec<Rc<Entry>>) {
        if let Some(root) = &self.root {
            root.collect(entries);
        }
        entries.sort_unstable_by(|a, b| a.bucket.cmp(&b.bucket).then(b.serial.cmp(&a.serial)));
    }
    pub(crate) async fn cleared(&self, cancel: &Cancel, work: &mut Work) -> Result<Self, Error> {
        work.checkpoint(cancel).await?;
        for _ in 0..self.len {
            work.checkpoint(cancel).await?;
        }
        Ok(Self::default())
    }
    /// Snapshot the entries in Bash's bucket, newest-first order.
    pub(crate) async fn listed(
        &self,
        state: &SharedState,
        cancel: &Cancel,
        work: &mut Work,
    ) -> Result<Listing, Error> {
        let count = self.len;
        let bytes = count
            .checked_mul(size_of::<Rc<Entry>>())
            .ok_or(RESOURCE_STATUS)?;
        let mut listing = Listing {
            entries: Vec::new(),
            _ticket: state.borrow().admit_temporary(bytes)?,
        };
        listing
            .entries
            .try_reserve_exact(count)
            .map_err(|_| Error::Status(RESOURCE_STATUS))?;
        if let Some(ticket) = listing._ticket.as_mut() {
            let excess = listing.entries.capacity() - count;
            ticket
                .grow(excess * size_of::<Rc<Entry>>())
                .map_err(|_| Error::Status(RESOURCE_STATUS))?;
        }
        // Reserve the traversal and comparison sort before their synchronous run.
        let comparisons = count.saturating_mul(count.checked_ilog2().unwrap_or(0) as usize + 2);
        for _ in 0..comparisons {
            work.checkpoint(cancel).await?;
        }
        self.ordered(&mut listing.entries);
        Ok(listing)
    }
    pub(crate) async fn find(
        &self,
        name: &str,
        cancel: &Cancel,
        work: &mut Work,
    ) -> Result<Option<Rc<Entry>>, Error> {
        let slot = bucket(name, cancel, work).await?;
        Ok(self.locate(name, slot, cancel, work).await?.found)
    }
    async fn locate(
        &self,
        name: &str,
        slot: u32,
        cancel: &Cancel,
        work: &mut Work,
    ) -> Result<Path, Error> {
        let mut path = Path {
            turns: [Side::Left; DEPTH],
            len: 0,
            found: None,
        };
        let mut link = &self.root;
        while let Some(node) = link {
            work.checkpoint(cancel).await?;
            let side = match node.entry.order(name, slot, cancel, work).await? {
                Ordering::Equal => {
                    path.found = Some(node.entry.clone());
                    return Ok(path);
                }
                Ordering::Less => Side::Left,
                Ordering::Greater => Side::Right,
            };
            *path.turns.get_mut(path.len).ok_or(RESOURCE_STATUS)? = side;
            path.len += 1;
            link = node.child(side);
        }
        Ok(path)
    }
    pub(crate) async fn updated(
        &self,
        name: &str,
        path: Option<&str>,
        state: &SharedState,
        cancel: &Cancel,
        work: &mut Work,
    ) -> Result<Self, Error> {
        let slot = bucket(name, cancel, work).await?;
        let located = self.locate(name, slot, cancel, work).await?;
        let turns = &located.turns[..located.len];
        let Some(path) = path else {
            if located.found.is_none() {
                return Ok(self.clone());
            }
            reserve_rebuild(&self.root, cancel, work).await?;
            let root = Builder(&state.borrow()).removed(&self.root, turns)?;
            return Ok(Self {
                root,
                len: self.len - 1,
                serial: self.serial,
            });
        };
        let (serial, next) = match &located.found {
            Some(old) => (old.serial, self.serial),
            None => (
                self.serial,
                self.serial.checked_add(1).ok_or(RESOURCE_STATUS)?,
            ),
        };
        let entry = Entry::retain(name, path, slot, serial, state, cancel, work).await?;
        reserve_rebuild(&self.root, cancel, work).await?;
        let root = Builder(&state.borrow()).inserted(&self.root, turns, entry)?;
        Ok(Self {
            root: Some(root),
            len: self.len + usize::from(located.found.is_none()),
            serial: next,
        })
    }
}
/// Each level of a rebuild creates at most three nodes, rotations included.
async fn reserve_rebuild(root: &Link, cancel: &Cancel, work: &mut Work) -> Result<(), Error> {
    for _ in 0..3 * (usize::from(height(root)) + 1) {
        work.checkpoint(cancel).await?;
    }
    Ok(())
}
impl Builder<'_> {
    fn node(&self, entry: Rc<Entry>, left: Link, right: Link) -> Result<Rc<Node>, Error> {
        let ticket = self.0.admit_temporary(boxed::<Node>())?;
        let height = 1 + height(&left).max(height(&right));
        Ok(Rc::new(Node {
            entry,
            left,
            right,
            height,
            _ticket: ticket,
        }))
    }
    /// A node with `near` on `side` and `far` on the other side.
    fn sided(
        &self,
        side: Side,
        entry: Rc<Entry>,
        near: Link,
        far: Link,
    ) -> Result<Rc<Node>, Error> {
        match side {
            Side::Left => self.node(entry, near, far),
            Side::Right => self.node(entry, far, near),
        }
    }
    fn balanced(&self, entry: Rc<Entry>, left: Link, right: Link) -> Result<Rc<Node>, Error> {
        let (low, high) = (height(&left), height(&right));
        if low > high + 1 {
            return self.rotated(Side::Left, entry, left, right);
        }
        if high > low + 1 {
            return self.rotated(Side::Right, entry, right, left);
        }
        self.node(entry, left, right)
    }
    /// Rebalance a node whose `side` subtree `heavy` is two levels taller.
    fn rotated(
        &self,
        side: Side,
        entry: Rc<Entry>,
        heavy: Link,
        light: Link,
    ) -> Result<Rc<Node>, Error> {
        let heavy = heavy.ok_or(RESOURCE_STATUS)?;
        let (outer, inner) = (heavy.child(side), heavy.child(side.other()));
        if height(outer) >= height(inner) {
            let lowered = self.sided(side, entry, inner.clone(), light)?;
            return self.sided(side, heavy.entry.clone(), outer.clone(), Some(lowered));
        }
        let pivot = inner.as_ref().ok_or(RESOURCE_STATUS)?;
        let near = self.sided(
            side,
            heavy.entry.clone(),
            outer.clone(),
            pivot.child(side).clone(),
        )?;
        let far = self.sided(side, entry, pivot.child(side.other()).clone(), light)?;
        self.sided(side, pivot.entry.clone(), Some(near), Some(far))
    }
    /// Rebuild `node` after its `side` child became `child`.
    fn joined(&self, side: Side, node: &Node, child: Link) -> Result<Rc<Node>, Error> {
        let other = node.child(side.other()).clone();
        match side {
            Side::Left => self.balanced(node.entry.clone(), child, other),
            Side::Right => self.balanced(node.entry.clone(), other, child),
        }
    }
    fn inserted(&self, link: &Link, turns: &[Side], entry: Rc<Entry>) -> Result<Rc<Node>, Error> {
        let Some(node) = link else {
            return self.node(entry, None, None);
        };
        let Some((&side, rest)) = turns.split_first() else {
            return self.node(entry, node.left.clone(), node.right.clone());
        };
        let child = self.inserted(node.child(side), rest, entry)?;
        self.joined(side, node, Some(child))
    }
    fn removed(&self, link: &Link, turns: &[Side]) -> Result<Link, Error> {
        let node = link.as_ref().ok_or(RESOURCE_STATUS)?;
        let Some((&side, rest)) = turns.split_first() else {
            return self.unlinked(node);
        };
        let child = self.removed(node.child(side), rest)?;
        Ok(Some(self.joined(side, node, child)?))
    }
    fn unlinked(&self, node: &Node) -> Result<Link, Error> {
        let (Some(_), Some(right)) = (&node.left, &node.right) else {
            return Ok(node.left.clone().or_else(|| node.right.clone()));
        };
        let (successor, rest) = self.without_first(right)?;
        Ok(Some(self.balanced(successor, node.left.clone(), rest)?))
    }
    fn without_first(&self, node: &Node) -> Result<(Rc<Entry>, Link), Error> {
        let Some(left) = &node.left else {
            return Ok((node.entry.clone(), node.right.clone()));
        };
        let (first, rest) = self.without_first(left)?;
        let rebuilt = self.balanced(node.entry.clone(), rest, node.right.clone())?;
        Ok((first, Some(rebuilt)))
    }
}
impl Entry {
    /// Order `name` against this entry by bucket, length, then charged bytes.
    async fn order(
        &self,
        name: &str,
        slot: u32,
        cancel: &Cancel,
        work: &mut Work,
    ) -> Result<Ordering, Error> {
        let order = slot
            .cmp(&self.bucket)
            .then(name.len().cmp(&self.name.len()));
        if order != Ordering::Equal {
            return Ok(order);
        }
        for (left, right) in name.bytes().zip(self.name.bytes()) {
            work.checkpoint(cancel).await?;
            if left != right {
                return Ok(left.cmp(&right));
            }
        }
        Ok(Ordering::Equal)
    }
    async fn retain(
        name: &str,
        path: &str,
        bucket: u32,
        serial: u64,
        state: &SharedState,
        cancel: &Cancel,
        work: &mut Work,
    ) -> Result<Rc<Self>, Error> {
        for _ in path.bytes() {
            work.checkpoint(cancel).await?;
        }
        let bytes = boxed::<Self>()
            .checked_add(name.len())
            .and_then(|n| n.checked_add(path.len()))
            .ok_or(RESOURCE_STATUS)?;
        let mut ticket = state.borrow().admit_temporary(bytes)?;
        let name = copy(name)?;
        let path = copy(path)?;
        if let Some(ticket) = &mut ticket {
            ticket
                .grow(name.capacity() + path.capacity() + boxed::<Self>() - bytes)
                .map_err(|_| Error::Status(RESOURCE_STATUS))?;
        }
        Ok(Rc::new(Self {
            name,
            path,
            bucket,
            serial,
            _ticket: ticket,
        }))
    }
}
fn copy(value: &str) -> Result<String, Error> {
    let mut text = String::new();
    text.try_reserve_exact(value.len())
        .map_err(|_| Error::Status(RESOURCE_STATUS))?;
    text.push_str(value);
    Ok(text)
}

#[cfg(test)]
mod tests;
