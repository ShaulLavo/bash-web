use std::{collections::BTreeMap, ops::Deref, rc::Rc};

/// Original binding model. Indexed values are ordered and sparse; a scalar
/// assignment to an existing array replaces only element zero.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Binding {
    Associative(Rc<super::Associative>),
    Scalar(String),
    Indexed(Rc<Indexed>),
}
impl Binding {
    pub(crate) fn is_array(&self) -> bool {
        !matches!(self, Self::Scalar(_))
    }
    pub fn as_str(&self) -> &str {
        self.scalar().map(String::as_str).unwrap_or("")
    }
    pub fn scalar(&self) -> Option<&String> {
        match self {
            Self::Scalar(value) => Some(value),
            Self::Associative(values) => values.get("0"),
            Self::Indexed(values) => values.values.get(&0),
        }
    }
    pub(crate) fn storage_bytes(&self) -> usize {
        match self {
            Self::Scalar(value) => value.capacity(),
            Self::Associative(values) => values.storage_bytes(),
            Self::Indexed(values) => values.storage_bytes() + Self::indexed_header_bytes(),
        }
    }
    pub(crate) fn local_storage_bytes(&self) -> usize {
        if matches!(self, Self::Associative(_)) {
            return 0;
        }
        self.storage_bytes()
    }
    pub(crate) fn scalar_copy_bytes(&self) -> usize {
        if let Self::Associative(values) = self {
            return values.scalar_copy_bytes();
        }
        self.storage_bytes().saturating_add(Self::node_bytes())
    }

    pub(crate) fn value_bytes(&self) -> usize {
        match self {
            Self::Scalar(value) => value.len(),
            Self::Associative(values) => values.value_bytes(),
            Self::Indexed(values) => values.value_bytes,
        }
    }
    pub(crate) fn node_bytes() -> usize {
        Indexed::tree_bytes(1) + 12 * std::mem::size_of::<usize>()
    }
    fn indexed_header_bytes() -> usize {
        std::mem::size_of::<Indexed>() + 2 * std::mem::size_of::<usize>()
    }
    pub(crate) fn count(&self) -> usize {
        match self {
            Self::Scalar(_) => 1,
            Self::Associative(values) => values.count(),
            Self::Indexed(values) => values.values.len(),
        }
    }
    pub(crate) fn last_index(&self) -> Option<i64> {
        match self {
            Self::Scalar(_) => Some(0),
            Self::Associative(_) => None,
            Self::Indexed(values) => values.values.last_key_value().map(|(index, _)| *index),
        }
    }
    pub(crate) fn slot(&self, index: i64) -> Option<&String> {
        match self {
            Self::Scalar(value) => (index == 0).then_some(value),
            Self::Associative(_) => None,
            Self::Indexed(values) => values.get(index),
        }
    }
    pub(crate) fn element(&self, index: i64) -> Option<&str> {
        let index = self.resolve_index(index)?;
        match self {
            Self::Scalar(value) => (index == 0).then_some(value.as_str()),
            Self::Associative(_) => None,
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
            Self::Associative(_) => None,
            Self::Indexed(values) => values
                .values
                .range(start..)
                .next()
                .map(|(index, value)| (*index, value.as_str())),
        }
    }
    pub(crate) fn prepare_scalar(&self, value: &str) -> Result<Option<Self>, i32> {
        let Self::Associative(values) = self else {
            return Ok(None);
        };
        let mut next = values.copy()?;
        next.insert_copied("0", value)?;
        Ok(Some(Self::Associative(Rc::new(next))))
    }
    pub(crate) fn set_scalar(&mut self, value: String) -> Result<(), i32> {
        match self {
            Self::Scalar(current) => *current = value,
            Self::Associative(values) => {
                let mut next = values.copy()?;
                next.insert("0".into(), value)?;
                *values = Rc::new(next);
            }
            Self::Indexed(values) => Rc::make_mut(values).insert(0, value),
        }
        Ok(())
    }
    pub(crate) fn into_indexed(self) -> Indexed {
        match self {
            Self::Scalar(value) => Indexed::from_scalar(value),
            Self::Associative(_) => unreachable!("indexed update to associative binding"),
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
    fn from_scalar(value: String) -> Self {
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
    fn undo_append(&mut self, first: Option<i64>, keep_zero: bool) {
        while first.is_some_and(|first| {
            self.values
                .last_key_value()
                .is_some_and(|(i, _)| *i >= first)
        }) {
            let index = *self.values.last_key_value().unwrap().0;
            if index == 0 && keep_zero {
                break;
            }
            self.remove(index);
        }
    }
    fn tree_bytes(count: usize) -> usize {
        if count == 0 {
            return 0;
        }
        // Rust 1.98.1 B-tree nodes hold 11 entries, with >=5 per nonroot.
        // Root has >=2 children, other internal nodes >=6. See indexed docs.
        let pointer = std::mem::size_of::<usize>();
        let alignment = std::mem::align_of::<i64>().max(pointer);
        let leaf =
            (pointer + 4 + 11 * (8 + std::mem::size_of::<String>())).next_multiple_of(alignment);
        let nodes = 1 + (count - 1) / 5;
        nodes
            .saturating_mul(leaf)
            .saturating_add(((nodes + 3) / 6).saturating_mul(12 * pointer))
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
    AssociativeElement { key: String, value: Option<String> },
    AssociativeInitialize,
}
impl BindingUpdate {
    pub(crate) fn value_bytes(&self) -> usize {
        match self {
            Self::Replace(value) => value.value_bytes(),
            Self::Element { value, .. } => value.len(),
            Self::Append(values) => values.value_bytes,
            Self::AssociativeElement { value, .. } => value.as_ref().map_or(0, String::len),
            Self::AssociativeInitialize => 0,
        }
    }
    pub(crate) fn staged_bytes(&self) -> usize {
        match self {
            Self::Replace(Binding::Associative(_)) => 0,
            Self::Replace(value) => value.storage_bytes(),
            Self::AssociativeInitialize => 0,
            Self::Element { value, .. } => value.capacity(),
            Self::Append(values) => values.storage_bytes() + Binding::indexed_header_bytes(),
            Self::AssociativeElement { key, value } => {
                key.capacity() + value.as_ref().map_or(0, String::capacity)
            }
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
            Some(Binding::Associative(_)) => super::Associative::default_storage_bytes(),
            _ => 0,
        }
    }
    fn dimensions(old: Option<&Binding>) -> (usize, usize) {
        match old {
            Some(Binding::Indexed(values)) => (values.values.len(), values.bytes),
            Some(Binding::Scalar(value)) => (1, value.capacity()),
            Some(Binding::Associative(_)) => (0, 0),
            None => (0, 0),
        }
    }
    pub(crate) fn storage_after(&self, old: Option<&Binding>) -> usize {
        if matches!(self, Self::AssociativeInitialize) {
            return old.unwrap().storage_bytes();
        }
        if let Self::AssociativeElement { key, value } = self {
            let Some(Binding::Associative(values)) = old else {
                unreachable!()
            };
            return values.storage_after(key, value.as_ref());
        }
        let (mut count, mut bytes) = Self::dimensions(old);
        match self {
            Self::Replace(value) => return value.storage_bytes(),
            Self::Element { index, value } => {
                let prior = old.and_then(|old| old.slot(*index));
                count += usize::from(prior.is_none());
                bytes = bytes
                    .saturating_sub(prior.map_or(0, String::capacity))
                    .saturating_add(value.capacity());
            }
            Self::AssociativeElement { .. } | Self::AssociativeInitialize => unreachable!(),
            Self::Append(values) => {
                count += values.values.len();
                bytes = bytes.saturating_add(values.bytes);
            }
        }
        Binding::indexed_header_bytes() + Indexed::tree_bytes(count) + bytes
    }
    pub(crate) fn growth_bytes(&self, old: Option<&Binding>) -> usize {
        if matches!(self, Self::Replace(_) | Self::AssociativeInitialize) {
            return 0;
        }
        if let Self::AssociativeElement { key, value } = self {
            let Some(Binding::Associative(values)) = old else {
                unreachable!()
            };
            return value.as_ref().map_or(0, |_| values.growth_bytes(key));
        }
        let (count, _) = Self::dimensions(old);
        let next_count = match self {
            Self::Element { index, .. } => {
                count + usize::from(old.and_then(|v| v.element(*index)).is_none())
            }
            Self::Append(values) => count + values.values.len(),
            Self::Replace(_) | Self::AssociativeElement { .. } | Self::AssociativeInitialize => {
                unreachable!()
            }
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
#[derive(Debug)]
pub(crate) enum BindingUndo {
    Restore(Option<Binding>),
    Element {
        index: i64,
        old: Option<String>,
        scalar: bool,
    },
    Append {
        first: Option<i64>,
        scalar: bool,
        keep_zero: bool,
    },
}
impl BindingUndo {
    pub(crate) fn scalar_effect_bytes(&self, value_bytes: usize) -> usize {
        match self {
            Self::Restore(Some(binding @ (Binding::Indexed(_) | Binding::Associative(_)))) => {
                value_bytes.saturating_add(binding.scalar_copy_bytes())
            }
            Self::Restore(_) | Self::Element { index: 0, .. } => value_bytes,
            _ => 0,
        }
    }
    pub(crate) fn prepare_scalar_effect(&self, value: &str) -> Result<Option<Binding>, i32> {
        let Self::Restore(Some(binding)) = self else {
            return Ok(None);
        };
        binding.prepare_scalar(value)
    }
    pub(crate) fn scalar_effect(&mut self, value: &str, prepared: Option<Binding>) {
        if let Some(binding) = prepared {
            *self = Self::Restore(Some(binding));
            return;
        }
        match self {
            Self::Restore(binding) => binding
                .get_or_insert_with(|| "".into())
                .set_scalar(value.to_owned())
                .expect("scalar effect prepared before publication"),
            Self::Element { index: 0, old, .. } => *old = Some(value.to_owned()),
            Self::Append { keep_zero, .. } => *keep_zero = true,
            _ => {}
        }
    }
    pub(crate) fn restore(self, live: Option<Binding>) -> Option<Binding> {
        if let Self::Restore(old) = self {
            return old;
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
                first,
                scalar,
                keep_zero,
            } => {
                values_mut.undo_append(first, keep_zero);
                scalar
            }
            Self::Restore(_) => {
                unreachable!()
            }
        };
        if scalar {
            return values_mut.remove(0).map(Binding::Scalar);
        }
        Some(Binding::Indexed(values))
    }
}
impl BindingUpdate {
    pub(crate) fn prepare_associative(
        &self,
        old: Option<&mut Binding>,
    ) -> Result<Option<Binding>, i32> {
        if let Self::Replace(Binding::Associative(values)) = self {
            debug_assert!(values.memory_is_admitted());
            return Ok(None);
        }
        if !matches!(
            self,
            Self::AssociativeElement { .. } | Self::AssociativeInitialize
        ) {
            return Ok(None);
        }
        let Some(Binding::Associative(values)) = old else {
            unreachable!()
        };
        let mut next = values.copy()?;
        match self {
            Self::AssociativeElement {
                key,
                value: Some(value),
            } => next.insert_copied(key, value)?,
            Self::AssociativeElement { key, value: None } => next.remove(key)?,
            Self::AssociativeInitialize => next.initialize(),
            _ => unreachable!(),
        }
        Ok(Some(Binding::Associative(Rc::new(next))))
    }
    pub(crate) fn mutation_steps(&self, old: Option<&Binding>) -> usize {
        let Self::AssociativeElement { key, value } = self else {
            return 0;
        };
        let Some(Binding::Associative(values)) = old else {
            unreachable!()
        };
        values.mutation_steps(key, value.is_some())
    }
    pub(crate) fn apply_prepared(
        self,
        old: Option<Binding>,
        prepared: Option<Binding>,
    ) -> (Binding, BindingUndo) {
        let Some(prepared) = prepared else {
            return self.apply_with_undo(old);
        };
        (prepared, BindingUndo::Restore(old))
    }
    pub(crate) fn undo_bytes(&self, old: Option<&Binding>) -> usize {
        // Associative roots and payloads retain their own allocation tickets.
        if matches!(old, Some(Binding::Associative(_))) {
            return 0;
        }
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
                for (index, value) in append.values {
                    values.insert(index, value);
                }
                BindingUndo::Append {
                    first,
                    scalar,
                    keep_zero: false,
                }
            }
            Self::Replace(_) | Self::AssociativeElement { .. } | Self::AssociativeInitialize => {
                unreachable!()
            }
        };
        (binding, restore.unwrap_or(undo))
    }
}
