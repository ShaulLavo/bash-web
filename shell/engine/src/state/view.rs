//! Borrowed public values never expose the engine's shared array handles.
use super::Binding;
use std::{
    collections::BTreeMap,
    fmt,
    ops::{Deref, Index},
};

#[repr(transparent)]
#[derive(Debug, PartialEq, Eq)]
pub struct BindingValue(str);
impl BindingValue {
    fn borrowed(value: &str) -> &Self {
        // The transparent wrapper has str's layout and retains the source lifetime.
        unsafe { &*(value as *const str as *const Self) }
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
impl Deref for BindingValue {
    type Target = str;
    fn deref(&self) -> &str {
        &self.0
    }
}
impl fmt::Display for BindingValue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}
impl PartialEq<&str> for BindingValue {
    fn eq(&self, other: &&str) -> bool {
        &self.0 == *other
    }
}
impl PartialEq<str> for BindingValue {
    fn eq(&self, other: &str) -> bool {
        &self.0 == other
    }
}
impl PartialEq<String> for BindingValue {
    fn eq(&self, other: &String) -> bool {
        &self.0 == other
    }
}
#[derive(Clone, Copy)]
pub struct Bindings<'a>(&'a BTreeMap<String, Binding>);
impl<'a> Bindings<'a> {
    pub(super) fn new(values: &'a BTreeMap<String, Binding>) -> Self {
        Self(values)
    }
    pub fn get(&self, name: &str) -> Option<&'a BindingValue> {
        self.0
            .get(name)
            .map(|binding| BindingValue::borrowed(binding.as_str()))
    }
    pub fn contains_key(&self, name: &str) -> bool {
        self.0.contains_key(name)
    }
    pub fn len(&self) -> usize {
        self.0.len()
    }
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
    pub fn keys(&self) -> impl Iterator<Item = &'a String> {
        self.0.keys()
    }
    pub fn iter(&self) -> impl Iterator<Item = (&'a String, &'a BindingValue)> {
        self.0
            .iter()
            .map(|(name, value)| (name, BindingValue::borrowed(value.as_str())))
    }
}
impl Index<&str> for Bindings<'_> {
    type Output = BindingValue;
    fn index(&self, name: &str) -> &BindingValue {
        self.get(name).expect("binding exists")
    }
}
impl Index<&String> for Bindings<'_> {
    type Output = BindingValue;
    fn index(&self, name: &String) -> &BindingValue {
        &self[name.as_str()]
    }
}
