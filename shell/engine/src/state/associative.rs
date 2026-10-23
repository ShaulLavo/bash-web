//! Bash's FNV-1 buckets own associative order; indexed storage stays separate.
use super::{Binding, SharedState, State};
use crate::{
    exec::{Error, Work},
    executor::Cancel,
};
use std::{collections::BTreeMap, rc::Rc};

type Entry = (String, String);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Associative {
    buckets: BTreeMap<usize, Vec<Entry>>,
    bucket_count: usize,
    count: usize,
    bytes: usize,
    key_bytes: usize,
    value_bytes: usize,
    initialized: bool,
}
impl Default for Associative {
    fn default() -> Self {
        Self::with_buckets(1024, false)
    }
}

#[derive(Debug)]
pub(crate) struct AssociativeUndo {
    key: String,
    old: Option<(usize, String)>,
    layout: Option<(usize, Vec<String>)>,
    initialized: bool,
}

impl Associative {
    fn with_buckets(count: usize, initialized: bool) -> Self {
        Self {
            buckets: BTreeMap::new(),
            bucket_count: count,
            count: 0,
            bytes: 0,
            key_bytes: 0,
            value_bytes: 0,
            initialized,
        }
    }
    fn hash(key: &str) -> usize {
        key.bytes().fold(2166136261u32, |hash, byte| {
            hash.wrapping_mul(16777619) ^ (byte as i8 as i32 as u32)
        }) as usize
    }
    fn bucket(&self, key: &str) -> usize {
        Self::hash(key) & (self.bucket_count - 1)
    }
    fn position(&self, key: &str) -> Option<usize> {
        self.buckets
            .get(&self.bucket(key))?
            .iter()
            .position(|(k, _)| k == key)
    }
    pub(crate) fn get(&self, key: &str) -> Option<&String> {
        self.position(key)
            .map(|i| &self.buckets[&self.bucket(key)][i].1)
    }
    pub(crate) fn count(&self) -> usize {
        self.count
    }
    pub(crate) fn initialized(&self) -> bool {
        self.initialized
    }
    pub(crate) fn empty_replacement(&self) -> Self {
        Self::with_buckets(self.bucket_count, true)
    }
    pub(crate) fn next(&self, cursor: &mut (usize, usize)) -> Option<(&str, &str)> {
        for (&bucket, chain) in self.buckets.range(cursor.0..) {
            let index = if bucket == cursor.0 { cursor.1 } else { 0 };
            if let Some((key, value)) = chain.get(index) {
                *cursor = (bucket, index + 1);
                return Some((key, value));
            }
        }
        None
    }
    fn bucket_storage(count: usize) -> usize {
        if count == 0 {
            return 0;
        }
        let pointer = std::mem::size_of::<usize>();
        let leaf = (pointer + 4 + 11 * (pointer + std::mem::size_of::<Vec<Entry>>()))
            .next_multiple_of(pointer);
        let nodes = 1 + (count - 1) / 5;
        nodes * leaf + ((nodes + 3) / 6) * 12 * pointer
    }
    pub(crate) fn storage_bytes(&self) -> usize {
        Self::default_storage_bytes()
            + Self::bucket_storage(self.buckets.len())
            + self.bytes
            + self.count * 4 * std::mem::size_of::<Entry>()
    }
    pub(crate) fn default_storage_bytes() -> usize {
        std::mem::size_of::<Self>() + 2 * std::mem::size_of::<usize>()
    }
    pub(crate) fn node_bytes() -> usize {
        4 * std::mem::size_of::<Entry>() + Self::bucket_storage(1)
    }
    pub(crate) fn value_bytes(&self) -> usize {
        self.value_bytes
    }
    fn grows(&self, key: &str) -> bool {
        self.count >= self.bucket_count * 2 && self.get(key).is_none()
    }
    pub(crate) fn growth_bytes(&self, key: &str) -> usize {
        if self.get(key).is_some() {
            return 0;
        }
        let resize = if self.grows(key) {
            self.count * (4 * std::mem::size_of::<Entry>() + std::mem::size_of::<String>())
                + Self::bucket_storage(self.count)
                + self.key_bytes
        } else {
            0
        };
        Self::node_bytes() + key.len() + resize
    }
    pub(crate) fn storage_after(&self, key: &str, value: Option<&String>) -> usize {
        let old = self.get(key);
        let inserted = value.is_some() && old.is_none();
        let removed = value.is_none() && old.is_some();
        self.storage_bytes()
            .saturating_sub(old.map_or(0, String::capacity))
            .saturating_sub(usize::from(removed) * (key.len() + 4 * std::mem::size_of::<Entry>()))
            + value.map_or(0, String::capacity)
            + usize::from(inserted) * (key.len() + Self::node_bytes())
            + usize::from(inserted && self.grows(key)) * Self::bucket_storage(self.count)
    }
    fn resize(&mut self) {
        self.bucket_count *= 4;
        for chain in std::mem::take(&mut self.buckets).into_values() {
            for entry in chain {
                self.prepend(entry);
            }
        }
    }
    fn prepend(&mut self, entry: Entry) {
        let bucket = self.bucket(&entry.0);
        self.buckets.entry(bucket).or_default().insert(0, entry);
    }
    pub(crate) fn insert(&mut self, key: String, value: String) {
        self.replace(key, value);
    }
    fn replace(&mut self, key: String, value: String) -> Option<(usize, String)> {
        self.initialized = true;
        self.value_bytes += value.len();
        self.bytes += value.capacity();
        if let Some(index) = self.position(&key) {
            let bucket = self.bucket(&key);
            let old =
                std::mem::replace(&mut self.buckets.get_mut(&bucket).unwrap()[index].1, value);
            self.bytes -= old.capacity();
            self.value_bytes -= old.len();
            return Some((index, old));
        }
        if self.grows(&key) {
            self.resize();
        }
        self.bytes += key.capacity();
        self.key_bytes += key.capacity();
        self.count += 1;
        self.prepend((key, value));
        None
    }
    fn take(&mut self, key: &str) -> Option<(usize, Entry)> {
        let index = self.position(key)?;
        let bucket = self.bucket(key);
        let chain = self.buckets.get_mut(&bucket).unwrap();
        let entry = chain.remove(index);
        if chain.is_empty() {
            self.buckets.remove(&bucket);
        }
        self.bytes -= entry.0.capacity() + entry.1.capacity();
        self.key_bytes -= entry.0.capacity();
        self.value_bytes -= entry.1.len();
        self.count -= 1;
        Some((index, entry))
    }
    fn layout(&self) -> Vec<String> {
        self.buckets
            .values()
            .flatten()
            .map(|(key, _)| key.clone())
            .collect()
    }
    pub(crate) fn undo_bytes(&self, key: &str, insert: bool) -> usize {
        let layout = if insert && self.grows(key) {
            self.count * std::mem::size_of::<String>() + self.key_bytes
        } else {
            0
        };
        key.len() + self.get(key).map_or(0, String::capacity) + layout
    }
    pub(crate) fn initialize(&mut self) {
        self.initialized = true;
    }
    pub(crate) fn change(&mut self, key: String, value: Option<String>) -> AssociativeUndo {
        let initialized = self.initialized;
        let layout =
            (value.is_some() && self.grows(&key)).then(|| (self.bucket_count, self.layout()));
        let old = match value {
            Some(value) => self.replace(key.clone(), value),
            None => self.take(&key).map(|(index, (_, value))| (index, value)),
        };
        AssociativeUndo {
            key,
            old,
            layout,
            initialized,
        }
    }
    pub(crate) fn restore(&mut self, undo: AssociativeUndo) {
        let entry = self.take(&undo.key);
        if let Some((index, value)) = undo.old {
            let key = entry.map_or(undo.key, |(_, (key, _))| key);
            self.bytes += key.capacity() + value.capacity();
            self.key_bytes += key.capacity();
            self.value_bytes += value.len();
            self.count += 1;
            let bucket = self.bucket(&key);
            self.buckets
                .entry(bucket)
                .or_default()
                .insert(index, (key, value));
        }
        if let Some((count, order)) = undo.layout {
            self.restore_layout(count, order);
        }
        self.initialized = undo.initialized;
    }
    fn restore_layout(&mut self, count: usize, order: Vec<String>) {
        let mut previous = Self::with_buckets(count, self.initialized);
        for key in order {
            let (_, entry) = self.take(&key).expect("resized entry retained");
            let bucket = previous.bucket(&key);
            previous.bytes += entry.0.capacity() + entry.1.capacity();
            previous.key_bytes += entry.0.capacity();
            previous.value_bytes += entry.1.len();
            previous.count += 1;
            previous.buckets.entry(bucket).or_default().push(entry);
        }
        if let Some((_, (key, value))) = self.take("0") {
            previous.insert(key, value);
        }
        *self = previous;
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
        for _ in 0..source.storage_bytes() {
            work.checkpoint(cancel).await?;
        }
        Ok((*source).clone())
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
        cursor: &mut (usize, usize),
    ) -> Option<(&str, &str)> {
        let Binding::Associative(values) = self.binding(name)? else {
            return None;
        };
        values.next(cursor)
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

impl AssociativeUndo {
    pub(crate) fn scalar_effect_bytes(&self, bytes: usize) -> usize {
        usize::from(self.key == "0") * bytes
    }
    pub(crate) fn scalar_effect(&mut self, value: &str) {
        self.initialized = true;
        if self.key != "0" {
            return;
        }
        let index = self.old.as_ref().map_or(0, |(index, _)| *index);
        self.old = Some((index, value.to_owned()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn order(values: &Associative) -> Vec<String> {
        let mut cursor = (0, 0);
        std::iter::from_fn(|| values.next(&mut cursor).map(|(key, _)| key.to_owned())).collect()
    }
    #[test]
    fn single_key_undo_restores_growth_and_collision_order() {
        let mut values = Associative::default();
        for i in 0..2048 {
            values.insert(format!("k{i}"), i.to_string());
        }
        let previous = values.clone();
        let undo = values.change("grows".into(), Some("new".into()));
        assert_eq!(values.bucket_count, 4096);
        values.restore(undo);
        assert_eq!(values, previous);
        let before = order(&values);
        let undo = values.change("k0".into(), None);
        values.restore(undo);
        assert_eq!(order(&values), before);
        assert_eq!(values, previous);
    }
    #[test]
    fn growth_undo_keeps_durable_scalar_effect() {
        let mut values = Associative::default();
        for i in 0..2048 {
            values.insert(format!("k{i}"), i.to_string());
        }
        let mut expected = values.clone();
        expected.insert("0".into(), "durable".into());
        let mut undo = values.change("grows".into(), Some("new".into()));
        undo.scalar_effect("durable");
        values.insert("0".into(), "durable".into());
        values.restore(undo);
        assert_eq!(values, expected);
        assert_eq!(values.count(), 2049);
        assert_eq!(values.get("0").unwrap(), "durable");
        assert!(values.get("grows").is_none());
    }
    #[test]
    fn unique_update_does_not_copy_but_snapshot_update_does() {
        let mut values = Associative::default();
        values.insert("key".into(), "old".into());
        let mut live = Binding::Associative(Rc::new(values));
        let update = || super::super::BindingUpdate::AssociativeElement {
            key: "key".into(),
            value: Some("new".into()),
        };
        let address = match &live {
            Binding::Associative(values) => Rc::as_ptr(values),
            _ => unreachable!(),
        };
        assert_eq!(update().copy_bytes(Some(&live)), 0);
        let (next, undo) = update().apply_with_undo(Some(live));
        live = undo.restore(Some(next)).unwrap();
        let Binding::Associative(values) = &live else {
            unreachable!()
        };
        assert_eq!(Rc::as_ptr(values), address);
        let snapshot = live.clone();
        assert!(update().copy_bytes(Some(&live)) > 0);
        let (next, _) = update().apply_with_undo(Some(live));
        let Binding::Associative(next) = next else {
            unreachable!()
        };
        assert_ne!(Rc::as_ptr(&next), address);
        let Binding::Associative(snapshot) = snapshot else {
            unreachable!()
        };
        assert_eq!(snapshot.get("key").unwrap(), "old");
    }
}
