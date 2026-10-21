use std::{collections::BTreeMap, ops::Deref, rc::Rc};

/// Original binding model. Indexed values are ordered and sparse; a scalar
/// assignment to an existing array replaces only element zero.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Binding {
    Scalar(String),
    Indexed(Rc<Indexed>),
}
impl Binding {
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
            Self::Scalar(value) => value.len(),
            Self::Indexed(values) => {
                values.bytes + std::mem::size_of::<Indexed>() + 2 * std::mem::size_of::<usize>()
            }
        }
    }
    pub(crate) fn value_bytes(&self) -> usize {
        match self {
            Self::Scalar(value) => value.len(),
            Self::Indexed(values) => values.bytes - values.values.len() * Self::node_bytes(),
        }
    }
    pub(crate) fn node_bytes() -> usize {
        (std::mem::size_of::<(i64, String)>() + std::mem::size_of::<usize>()) * 16
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
            .checked_add(1)?
            .checked_add(index)
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
}
impl Indexed {
    fn from_scalar(value: String) -> Self {
        let mut values = Self::default();
        values.insert(0, value);
        values
    }
    pub(crate) fn insert(&mut self, index: i64, value: String) {
        self.bytes = self
            .bytes
            .saturating_add(value.len())
            .saturating_add(Binding::node_bytes());
        if let Some(old) = self.values.insert(index, value) {
            self.bytes -= old.len() + Binding::node_bytes();
        }
    }
    pub(crate) fn get(&self, index: i64) -> Option<&String> {
        self.values.get(&index)
    }
    pub(crate) fn next_index(&self) -> Option<i64> {
        self.values
            .last_key_value()
            .map_or(Some(0), |(index, _)| index.checked_add(1))
    }
}
