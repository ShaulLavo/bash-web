//! Explicit literal command paths. Snapshots share immutable, admitted versions.
use super::SharedState;
use crate::{
    exec::{Error, RESOURCE_STATUS, StorageAllocation, Work},
    executor::Cancel,
};
use std::{mem::size_of, rc::Rc};

#[derive(Debug)]
pub(crate) struct Entry {
    pub(crate) name: String,
    pub(crate) path: String,
    bucket: u32,
    _ticket: Option<StorageAllocation>,
}
#[derive(Debug)]
struct Version {
    entries: Vec<Rc<Entry>>,
    _ticket: Option<StorageAllocation>,
}
#[derive(Clone, Debug, Default)]
pub(crate) struct CommandHash(Option<Rc<Version>>);

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
impl Version {
    fn reserve(count: usize, state: &SharedState) -> Result<Self, Error> {
        let bytes = count
            .checked_mul(size_of::<Rc<Entry>>())
            .and_then(|n| n.checked_add(boxed::<Self>()))
            .ok_or(RESOURCE_STATUS)?;
        let mut version = Self {
            entries: Vec::new(),
            _ticket: state.borrow().admit_temporary(bytes)?,
        };
        version
            .entries
            .try_reserve_exact(count)
            .map_err(|_| Error::Status(RESOURCE_STATUS))?;
        if let Some(ticket) = version._ticket.as_mut() {
            let excess = version.entries.capacity() - count;
            ticket
                .grow(excess * size_of::<Rc<Entry>>())
                .map_err(|_| Error::Status(RESOURCE_STATUS))?;
        }
        Ok(version)
    }
}
impl CommandHash {
    pub(crate) fn entries(&self) -> &[Rc<Entry>] {
        self.0.as_deref().map_or(&[], |version| &version.entries)
    }
    #[cfg(test)]
    fn clear(&mut self) {
        self.0 = None;
    }
    pub(crate) async fn cleared(&self, cancel: &Cancel, work: &mut Work) -> Result<Self, Error> {
        work.checkpoint(cancel).await?;
        for _ in self.entries() {
            work.checkpoint(cancel).await?;
        }
        Ok(Self::default())
    }
    pub(crate) async fn find(
        &self,
        name: &str,
        cancel: &Cancel,
        work: &mut Work,
    ) -> Result<Option<Rc<Entry>>, Error> {
        let slot = bucket(name, cancel, work).await?;
        for entry in self.entries() {
            work.checkpoint(cancel).await?;
            if entry.bucket == slot && entry.matches(name, cancel, work).await? {
                return Ok(Some(entry.clone()));
            }
        }
        Ok(None)
    }
    pub(crate) async fn updated(
        &self,
        name: &str,
        path: Option<&str>,
        state: &SharedState,
        cancel: &Cancel,
        work: &mut Work,
    ) -> Result<Self, Error> {
        let previous = self.find(name, cancel, work).await?;
        if path.is_none() && previous.is_none() {
            return Ok(self.clone());
        }
        let count =
            self.entries().len() - usize::from(previous.is_some()) + usize::from(path.is_some());
        if count == 0 {
            return Ok(Self::default());
        }
        let mut version = Version::reserve(count, state)?;
        let mut incoming = match path {
            Some(path) => Some(Entry::retain(name, path, state, cancel, work).await?),
            None => None,
        };
        let slot = bucket(name, cancel, work).await?;
        for entry in self.entries() {
            work.checkpoint(cancel).await?;
            let replacing = previous.as_ref().is_some_and(|old| Rc::ptr_eq(entry, old));
            if replacing || (previous.is_none() && entry.bucket >= slot) {
                version.entries.extend(incoming.take());
            }
            if !replacing {
                version.entries.push(entry.clone());
            }
        }
        version.entries.extend(incoming);
        Ok(Self(Some(Rc::new(version))))
    }
}
impl Entry {
    async fn matches(&self, name: &str, cancel: &Cancel, work: &mut Work) -> Result<bool, Error> {
        if self.name.len() != name.len() {
            return Ok(false);
        }
        for (left, right) in self.name.bytes().zip(name.bytes()) {
            work.checkpoint(cancel).await?;
            if left != right {
                return Ok(false);
            }
        }
        Ok(true)
    }
    async fn retain(
        name: &str,
        path: &str,
        state: &SharedState,
        cancel: &Cancel,
        work: &mut Work,
    ) -> Result<Rc<Self>, Error> {
        for _ in path.bytes() {
            work.checkpoint(cancel).await?;
        }
        let bucket = bucket(name, cancel, work).await?;
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
