use std::{
    collections::{BTreeMap, BTreeSet},
    ops::Deref,
    rc::Rc,
};

/// Original binding model. Indexed values are ordered and sparse; a scalar
/// assignment to an existing array replaces only element zero.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Binding {
    Scalar(String),
    Indexed(Rc<Indexed>),
}
impl Binding {
    pub(super) fn detached(&self) -> Self {
        match self {
            Self::Scalar(value) => Self::Scalar(value.clone()),
            Self::Indexed(values) => Self::Indexed(Rc::new((**values).clone())),
        }
    }
    pub fn as_str(&self) -> &str {
        self.scalar().map(String::as_str).unwrap_or("")
    }
    pub fn scalar(&self) -> Option<&String> {
        match self {
            Self::Scalar(value) => Some(value),
            Self::Indexed(values) => values.values.get(&0),
        }
    }
    pub(crate) fn storage_bytes(&self) -> usize {
        match self {
            Self::Scalar(value) => value.capacity(),
            Self::Indexed(values) => values.storage_bytes() + Self::indexed_header_bytes(),
        }
    }
    pub(crate) fn value_bytes(&self) -> usize {
        match self {
            Self::Scalar(value) => value.len(),
            Self::Indexed(values) => values.value_bytes,
        }
    }
    pub(crate) fn node_bytes() -> usize {
        Indexed::tree_bytes(1) + 12 * std::mem::size_of::<usize>()
    }
    pub(crate) fn indexed_header_bytes() -> usize {
        std::mem::size_of::<Indexed>() + 2 * std::mem::size_of::<usize>()
    }
    pub(crate) fn count(&self) -> usize {
        match self {
            Self::Scalar(_) => 1,
            Self::Indexed(values) => values.values.len(),
        }
    }
    pub(crate) fn last_index(&self) -> Option<i64> {
        match self {
            Self::Scalar(_) => Some(0),
            Self::Indexed(values) => values.values.last_key_value().map(|(index, _)| *index),
        }
    }
    pub(crate) fn slot(&self, index: i64) -> Option<&String> {
        match self {
            Self::Scalar(value) => (index == 0).then_some(value),
            Self::Indexed(values) => values.get(index),
        }
    }
    pub(crate) fn element(&self, index: i64) -> Option<&str> {
        let index = self.resolve_index(index)?;
        match self {
            Self::Scalar(value) => (index == 0).then_some(value.as_str()),
            Self::Indexed(values) => values.values.get(&index).map(String::as_str),
        }
    }
    pub(crate) fn resolve_index(&self, index: i64) -> Option<i64> {
        if index >= 0 {
            return Some(index);
        }
        self.last_index()?
            .checked_add(index)?
            .checked_add(1)
            .filter(|index| *index >= 0)
    }
    pub(crate) fn next(&self, previous: Option<i64>) -> Option<(i64, &str)> {
        let start = previous.map_or(Some(0), |index| index.checked_add(1))?;
        match self {
            Self::Scalar(value) => (start == 0).then_some((0, value.as_str())),
            Self::Indexed(values) => values
                .values
                .range(start..)
                .next()
                .map(|(index, value)| (*index, value.as_str())),
        }
    }
    pub(crate) fn set_scalar(&mut self, value: String) {
        match self {
            Self::Scalar(current) => *current = value,
            Self::Indexed(values) => {
                Rc::make_mut(values).insert(0, value);
            }
        }
    }
    /// Exact storage after `name[index]=value`, given the value's capacity.
    pub(crate) fn element_storage_after(old: Option<&Self>, index: i64, capacity: usize) -> usize {
        let (mut count, bytes) = BindingUpdate::dimensions(old);
        let prior = old.and_then(|old| old.slot(index));
        count += usize::from(prior.is_none());
        let bytes = bytes
            .saturating_sub(prior.map_or(0, String::capacity))
            .saturating_add(capacity);
        Self::indexed_header_bytes() + Indexed::tree_bytes(count) + bytes
    }
    pub(crate) fn into_indexed(self) -> Indexed {
        match self {
            Self::Scalar(value) => Indexed::from_scalar(value),
            Self::Indexed(values) => Rc::unwrap_or_clone(values),
        }
    }
}
impl From<String> for Binding {
    fn from(value: String) -> Self {
        Self::Scalar(value)
    }
}
impl From<&str> for Binding {
    fn from(value: &str) -> Self {
        Self::Scalar(value.to_owned())
    }
}
impl Deref for Binding {
    type Target = str;
    fn deref(&self) -> &str {
        self.as_str()
    }
}
impl PartialEq<str> for Binding {
    fn eq(&self, other: &str) -> bool {
        self.as_str() == other
    }
}
impl PartialEq<String> for Binding {
    fn eq(&self, other: &String) -> bool {
        self.as_str() == other
    }
}

impl PartialEq<&str> for Binding {
    fn eq(&self, other: &&str) -> bool {
        self.as_str() == *other
    }
}

/// Persistent sparse elements with cached storage accounting. Clones share the
/// immutable tree until an admitted write copies it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Indexed {
    values: BTreeMap<i64, String>,
    bytes: usize,
    value_bytes: usize,
}
impl Indexed {
    pub(crate) fn from_scalar(value: String) -> Self {
        let mut values = Self::default();
        values.insert(0, value);
        values
    }
    pub(crate) fn insert(&mut self, index: i64, value: String) {
        self.replace(index, value);
    }
    fn replace(&mut self, index: i64, value: String) -> Option<String> {
        self.bytes = self.bytes.saturating_add(value.capacity());
        self.value_bytes = self.value_bytes.saturating_add(value.len());
        let old = self.values.insert(index, value);
        if let Some(old) = &old {
            self.bytes -= old.capacity();
            self.value_bytes -= old.len();
        }
        old
    }
    fn remove(&mut self, index: i64) -> Option<String> {
        let old = self.values.remove(&index)?;
        if self.values.is_empty() {
            self.values = BTreeMap::new();
        }
        self.bytes -= old.capacity();
        self.value_bytes -= old.len();
        Some(old)
    }
    /// Remove the appended run except slots a durable write has since set.
    /// Each step is one lookup; nothing is allocated.
    fn undo_append(&mut self, (first, last): (i64, i64), keep_zero: bool, kept: &BTreeSet<i64>) {
        let mut cursor = Some(first);
        while let Some(start) = cursor.filter(|start| *start <= last) {
            let Some(index) = self.values.range(start..=last).next().map(|(i, _)| *i) else {
                return;
            };
            cursor = index.checked_add(1);
            if (index == 0 && keep_zero) || kept.contains(&index) {
                continue;
            }
            self.remove(index);
        }
    }
    fn tree_bytes(count: usize) -> usize {
        tree_bytes::<String>(count)
    }
    fn storage_bytes(&self) -> usize {
        self.bytes
            .saturating_add(Self::tree_bytes(self.values.len()))
    }
    pub(crate) fn insertion_bytes(&self, index: i64) -> usize {
        let count = self.values.len();
        Self::tree_bytes(count + usize::from(!self.values.contains_key(&index)))
            .saturating_sub(Self::tree_bytes(count))
    }
    pub(crate) fn get(&self, index: i64) -> Option<&String> {
        self.values.get(&index)
    }
}

/// Staged assignment-only changes. No old binding is cloned during expansion.
pub(crate) enum BindingUpdate {
    Replace(Binding),
    Element { index: i64, value: String },
    Append(Indexed),
    Remove { index: i64 },
}
impl BindingUpdate {
    pub(crate) fn value_bytes(&self) -> usize {
        match self {
            Self::Replace(value) => value.value_bytes(),
            Self::Element { value, .. } => value.len(),
            Self::Append(values) => values.value_bytes,
            Self::Remove { .. } => 0,
        }
    }
    pub(crate) fn staged_bytes(&self) -> usize {
        match self {
            Self::Replace(value) => value.storage_bytes(),
            Self::Element { value, .. } => value.capacity(),
            Self::Append(values) => values.storage_bytes() + Binding::indexed_header_bytes(),
            Self::Remove { .. } => 0,
        }
    }
    pub(crate) fn copy_bytes(&self, old: Option<&Binding>) -> usize {
        if matches!(self, Self::Replace(_)) {
            return 0;
        }
        match old {
            Some(binding @ Binding::Indexed(values)) if Rc::strong_count(values) > 1 => {
                binding.storage_bytes()
            }
            _ => 0,
        }
    }
    fn dimensions(old: Option<&Binding>) -> (usize, usize) {
        match old {
            Some(Binding::Indexed(values)) => (values.values.len(), values.bytes),
            Some(Binding::Scalar(value)) => (1, value.capacity()),
            None => (0, 0),
        }
    }
    pub(crate) fn storage_after(&self, old: Option<&Binding>) -> usize {
        let (count, bytes) = Self::dimensions(old);
        match self {
            Self::Replace(value) => value.storage_bytes(),
            Self::Element { index, value } => {
                Binding::element_storage_after(old, *index, value.capacity())
            }
            Self::Append(values) => {
                Binding::indexed_header_bytes()
                    + Indexed::tree_bytes(count + values.values.len())
                    + bytes.saturating_add(values.bytes)
            }
            Self::Remove { index } => Self::storage_after_remove(old, *index),
        }
    }
    fn storage_after_remove(old: Option<&Binding>, index: i64) -> usize {
        match old {
            None => 0,
            Some(Binding::Scalar(_)) if index == 0 => 0,
            Some(Binding::Scalar(value)) => value.capacity(),
            Some(Binding::Indexed(values)) => {
                let prior = values.get(index);
                let count = values
                    .values
                    .len()
                    .saturating_sub(usize::from(prior.is_some()));
                let bytes = values
                    .bytes
                    .saturating_sub(prior.map_or(0, String::capacity));
                Binding::indexed_header_bytes() + Indexed::tree_bytes(count) + bytes
            }
        }
    }
    pub(crate) fn growth_bytes(&self, old: Option<&Binding>) -> usize {
        if matches!(self, Self::Replace(_)) {
            return 0;
        }
        let (count, _) = Self::dimensions(old);
        let next_count = match self {
            Self::Element { index, .. } => {
                count + usize::from(old.and_then(|v| v.element(*index)).is_none())
            }
            Self::Append(values) => count + values.values.len(),
            Self::Remove { .. } => count,
            Self::Replace(_) => unreachable!(),
        };
        let prior_tree = if matches!(old, Some(Binding::Indexed(_))) {
            Indexed::tree_bytes(count)
        } else {
            0
        };
        Indexed::tree_bytes(next_count).saturating_sub(prior_tree)
            + usize::from(!matches!(old, Some(Binding::Indexed(_))))
                * Binding::indexed_header_bytes()
    }
}

/// Inverse changes retain only overwritten elements for uniquely owned arrays.
#[derive(Clone, Debug)]
pub(crate) enum BindingUndo {
    Restore(Option<Binding>),
    Element {
        index: i64,
        old: Option<String>,
        scalar: bool,
    },
    /// Removes the appended run `range`, keeping slots set durably since.
    Append {
        range: Option<(i64, i64)>,
        scalar: bool,
        keep_zero: bool,
        kept: BTreeSet<i64>,
    },
    /// A durable replacement made this inverse obsolete; rollback keeps it.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "constructed by durable indexed writes")
    )]
    Superseded,
}
impl BindingUndo {
    pub(super) fn storage_bytes(&self) -> usize {
        match self {
            Self::Restore(old) => old.as_ref().map_or(0, Binding::storage_bytes),
            Self::Element { old, .. } => old.as_ref().map_or(0, String::capacity),
            Self::Append { kept, .. } => tree_bytes::<()>(kept.len()),
            Self::Superseded => 0,
        }
    }
    pub(crate) fn scalar_effect_bytes(&self, value_bytes: usize) -> usize {
        match self {
            Self::Restore(Some(binding @ Binding::Indexed(_))) => value_bytes
                .saturating_add(binding.storage_bytes())
                .saturating_add(Binding::node_bytes()),
            Self::Restore(_) | Self::Element { index: 0, .. } => value_bytes,
            _ => 0,
        }
    }
    pub(crate) fn scalar_effect(&mut self, value: &str) {
        match self {
            Self::Restore(binding) => binding
                .get_or_insert_with(|| "".into())
                .set_scalar(value.to_owned()),
            Self::Element { index: 0, old, .. } => *old = Some(value.to_owned()),
            Self::Append { keep_zero, .. } => *keep_zero = true,
            _ => {}
        }
    }
    pub(crate) fn restore(self, live: Option<Binding>) -> Option<Binding> {
        match self {
            Self::Restore(old) => return old,
            Self::Superseded => return live,
            _ => {}
        }
        let Binding::Indexed(mut values) = live.expect("committed array exists") else {
            unreachable!()
        };
        let values_mut = Rc::make_mut(&mut values);
        let scalar = match self {
            Self::Element { index, old, scalar } => {
                match old {
                    Some(old) => values_mut.insert(index, old),
                    None => {
                        values_mut.remove(index);
                    }
                }
                scalar
            }
            Self::Append {
                range,
                scalar,
                keep_zero,
                kept,
            } => {
                if let Some(range) = range {
                    values_mut.undo_append(range, keep_zero, &kept);
                }
                scalar
            }
            Self::Restore(_) | Self::Superseded => unreachable!(),
        };
        if scalar {
            return values_mut.remove(0).map(Binding::Scalar);
        }
        Some(Binding::Indexed(values))
    }
}
impl BindingUpdate {
    pub(crate) fn undo_bytes(&self, old: Option<&Binding>) -> usize {
        if matches!(self, Self::Replace(_)) || self.copy_bytes(old) > 0 {
            return old.map_or(0, Binding::storage_bytes);
        }
        match self {
            Self::Element { index, .. } => {
                old.and_then(|v| v.slot(*index)).map_or(0, String::capacity)
            }
            _ => 0,
        }
    }
    pub(crate) fn apply_with_undo(self, old: Option<Binding>) -> (Binding, BindingUndo) {
        if let Self::Replace(value) = self {
            return (value, BindingUndo::Restore(old));
        }
        let restore = match &old {
            None => Some(BindingUndo::Restore(None)),
            Some(Binding::Indexed(values)) if Rc::strong_count(values) > 1 => {
                Some(BindingUndo::Restore(old.clone()))
            }
            _ => None,
        };
        let scalar = matches!(old, Some(Binding::Scalar(_)));
        let mut binding = match old {
            Some(binding @ Binding::Indexed(_)) => binding,
            old => Binding::Indexed(Rc::new(old.map(Binding::into_indexed).unwrap_or_default())),
        };
        let Binding::Indexed(values) = &mut binding else {
            unreachable!()
        };
        let values = Rc::make_mut(values);
        let undo = match self {
            Self::Element { index, value } => BindingUndo::Element {
                index,
                old: values.replace(index, value),
                scalar,
            },
            Self::Append(append) => {
                let first = append.values.first_key_value().map(|(i, _)| *i);
                let last = append.values.last_key_value().map(|(i, _)| *i);
                for (index, value) in append.values {
                    values.insert(index, value);
                }
                BindingUndo::Append {
                    range: first.zip(last),
                    scalar,
                    keep_zero: false,
                    kept: BTreeSet::new(),
                }
            }
            Self::Remove { index } => BindingUndo::Element {
                index,
                old: values.remove(index),
                scalar,
            },
            Self::Replace(_) => unreachable!(),
        };
        (binding, restore.unwrap_or(undo))
    }
}

// Rust 1.98.1 B-trees hold 11 entries per node, at least 5 per nonroot.
// Count-based bounds include spare capacity admitted before a later split.
fn tree_leaf_bytes<T>() -> usize {
    let pointer = std::mem::size_of::<usize>();
    let alignment = std::mem::align_of::<i64>().max(pointer);
    (pointer + 4 + 11 * (8 + std::mem::size_of::<T>())).next_multiple_of(alignment)
}

pub(super) fn tree_bytes<T>(count: usize) -> usize {
    if count == 0 {
        return 0;
    }
    let nodes = 1 + (count - 1) / 5;
    tree_leaf_bytes::<T>()
        .saturating_mul(nodes)
        .saturating_add(((nodes + 3) / 6).saturating_mul(12 * std::mem::size_of::<usize>()))
}

pub(super) fn kept_insertion_steps(count: usize) -> usize {
    let path = count.checked_ilog(6).unwrap_or(0) as usize + 1;
    let node = tree_leaf_bytes::<()>() + 12 * std::mem::size_of::<usize>();
    // Two cost lookups and publication each visit a path. A split moves at
    // most one node per level and can add one root, never the whole set.
    3 * (path + 1) * node
}

impl BindingUpdate {
    /// Preparation uses detached images. The commit itself only moves them.
    pub(crate) fn image(&self, binding: Option<&Binding>) -> Option<Binding> {
        let mut binding = binding.cloned();
        match self {
            Self::Element { index, value } => {
                let target =
                    binding.get_or_insert_with(|| Binding::Indexed(Rc::new(Indexed::default())));
                if let Binding::Scalar(old) = target {
                    *target = Binding::Indexed(Rc::new(Indexed::from_scalar(std::mem::take(old))));
                }
                let Binding::Indexed(values) = target else {
                    unreachable!()
                };
                Rc::make_mut(values).insert(*index, value.clone());
            }
            Self::Remove { index } => match &mut binding {
                Some(Binding::Scalar(_)) if *index == 0 => binding = None,
                Some(Binding::Indexed(values)) => {
                    Rc::make_mut(values).remove(*index);
                }
                _ => {}
            },
            _ => unreachable!("durable element effect"),
        }
        binding
    }
}
