use super::{Entry, Position};
use crate::exec::{RESOURCE_STATUS, StorageAllocation, StorageBudget};
use std::rc::Rc;

pub(super) type Link = Option<Rc<Node>>;
#[derive(Debug)]
pub(super) struct Node {
    pub position: Position,
    pub entry: Rc<Entry>,
    pub left: Link,
    pub right: Link,
    height: usize,
    _memory: Option<StorageAllocation>,
}

pub(super) fn height(tree: &Link) -> usize {
    tree.as_ref().map_or(0, |node| node.height)
}
pub(super) fn bytes() -> usize {
    std::mem::size_of::<Node>() + 2 * std::mem::size_of::<usize>()
}
fn node(
    position: Position,
    entry: Rc<Entry>,
    left: Link,
    right: Link,
    budget: &Option<StorageBudget>,
) -> Result<Link, i32> {
    let memory = budget
        .as_ref()
        .map(|budget| budget.admit(bytes()))
        .transpose()
        .map_err(|_| RESOURCE_STATUS)?;
    let height = height(&left).max(height(&right)) + 1;
    Ok(Some(Rc::new(Node {
        position,
        entry,
        left,
        right,
        height,
        _memory: memory,
    })))
}
fn balance(
    position: Position,
    entry: Rc<Entry>,
    left: Link,
    right: Link,
    budget: &Option<StorageBudget>,
) -> Result<Link, i32> {
    if height(&left) > height(&right) + 1 {
        return rotate_left_heavy(position, entry, left.unwrap(), right, budget);
    }
    if height(&right) > height(&left) + 1 {
        return rotate_right_heavy(position, entry, left, right.unwrap(), budget);
    }
    node(position, entry, left, right, budget)
}
fn rotate_left_heavy(
    position: Position,
    entry: Rc<Entry>,
    left: Rc<Node>,
    right: Link,
    budget: &Option<StorageBudget>,
) -> Result<Link, i32> {
    if height(&left.left) >= height(&left.right) {
        let right = node(position, entry, left.right.clone(), right, budget)?;
        return node(
            left.position,
            left.entry.clone(),
            left.left.clone(),
            right,
            budget,
        );
    }
    let middle = left.right.as_ref().unwrap();
    let first = node(
        left.position,
        left.entry.clone(),
        left.left.clone(),
        middle.left.clone(),
        budget,
    )?;
    let last = node(position, entry, middle.right.clone(), right, budget)?;
    node(middle.position, middle.entry.clone(), first, last, budget)
}
fn rotate_right_heavy(
    position: Position,
    entry: Rc<Entry>,
    left: Link,
    right: Rc<Node>,
    budget: &Option<StorageBudget>,
) -> Result<Link, i32> {
    if height(&right.right) >= height(&right.left) {
        let left = node(position, entry, left, right.left.clone(), budget)?;
        return node(
            right.position,
            right.entry.clone(),
            left,
            right.right.clone(),
            budget,
        );
    }
    let middle = right.left.as_ref().unwrap();
    let first = node(position, entry, left, middle.left.clone(), budget)?;
    let last = node(
        right.position,
        right.entry.clone(),
        middle.right.clone(),
        right.right.clone(),
        budget,
    )?;
    node(middle.position, middle.entry.clone(), first, last, budget)
}
pub(super) fn insert(
    tree: &Link,
    position: Position,
    entry: Rc<Entry>,
    budget: &Option<StorageBudget>,
) -> Result<Link, i32> {
    let Some(root) = tree else {
        return node(position, entry, None, None, budget);
    };
    match position.cmp(&root.position) {
        std::cmp::Ordering::Less => balance(
            root.position,
            root.entry.clone(),
            insert(&root.left, position, entry, budget)?,
            root.right.clone(),
            budget,
        ),
        std::cmp::Ordering::Greater => balance(
            root.position,
            root.entry.clone(),
            root.left.clone(),
            insert(&root.right, position, entry, budget)?,
            budget,
        ),
        std::cmp::Ordering::Equal => node(
            position,
            entry,
            root.left.clone(),
            root.right.clone(),
            budget,
        ),
    }
}
pub(super) fn remove(
    tree: &Link,
    position: Position,
    budget: &Option<StorageBudget>,
) -> Result<Link, i32> {
    let Some(root) = tree else {
        return Ok(None);
    };
    if position < root.position {
        return balance(
            root.position,
            root.entry.clone(),
            remove(&root.left, position, budget)?,
            root.right.clone(),
            budget,
        );
    }
    if position > root.position {
        return balance(
            root.position,
            root.entry.clone(),
            root.left.clone(),
            remove(&root.right, position, budget)?,
            budget,
        );
    }
    let Some(mut next) = root.right.as_deref() else {
        return Ok(root.left.clone());
    };
    if root.left.is_none() {
        return Ok(root.right.clone());
    }
    while let Some(left) = next.left.as_deref() {
        next = left;
    }
    balance(
        next.position,
        next.entry.clone(),
        root.left.clone(),
        remove(&root.right, next.position, budget)?,
        budget,
    )
}
pub(super) fn next(tree: &Link, after: Option<Position>) -> Option<&Node> {
    let mut current = tree.as_deref();
    let mut found = None;
    while let Some(node) = current {
        if after.is_none_or(|after| node.position > after) {
            found = Some(node);
            current = node.left.as_deref();
            continue;
        }
        current = node.right.as_deref();
    }
    found
}
pub(super) fn visit(tree: &Link, visitor: &mut impl FnMut(&Node)) {
    let Some(node) = tree else {
        return;
    };
    visit(&node.left, visitor);
    visitor(node);
    visit(&node.right, visitor);
}
pub(super) fn build(
    entries: &[(Position, Rc<Entry>)],
    budget: &Option<StorageBudget>,
) -> Result<Link, i32> {
    if entries.is_empty() {
        return Ok(None);
    }
    let middle = entries.len() / 2;
    let left = build(&entries[..middle], budget)?;
    let right = build(&entries[middle + 1..], budget)?;
    node(
        entries[middle].0,
        entries[middle].1.clone(),
        left,
        right,
        budget,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn check(tree: &Link) -> usize {
        let Some(node) = tree else {
            return 0;
        };
        let left = check(&node.left);
        let right = check(&node.right);
        assert!(left.abs_diff(right) <= 1);
        assert_eq!(node.height, 1 + left.max(right));
        node.height
    }
    fn positions(tree: &Link) -> Vec<Position> {
        let mut positions = Vec::new();
        visit(tree, &mut |node| positions.push(node.position));
        positions
    }
    #[test]
    fn persistent_rotations_and_deletions_preserve_balance_and_old_roots() {
        let mut tree = None;
        let mut ordered = std::collections::BTreeSet::new();
        for i in 0..1000 {
            let position = (i * 137 % 1000, 0);
            let saved = tree.clone();
            tree = insert(
                &tree,
                position,
                Entry::new(i.to_string(), "v".into(), &None).unwrap(),
                &None,
            )
            .unwrap();
            ordered.insert(position);
            check(&tree);
            check(&saved);
        }
        for i in 0..1000 {
            let position = (i * 313 % 1000, 0);
            let saved = tree.clone();
            let previous = positions(&saved);
            tree = remove(&tree, position, &None).unwrap();
            ordered.remove(&position);
            check(&tree);
            check(&saved);
            assert_eq!(positions(&saved), previous);
            assert_eq!(
                positions(&tree),
                ordered.iter().copied().collect::<Vec<_>>()
            );
        }
        assert!(tree.is_none());
    }
}
