//! Immutable completion-table versions share retained storage across isolated shells.
use super::{SharedState, State};
use crate::{
    exec::{Error, RESOURCE_STATUS, StorageAllocation, Work},
    executor::Cancel,
};
use std::{mem::size_of, rc::Rc};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Special {
    Default,
    Empty,
    Initial,
}
impl Special {
    pub(crate) fn flag(self) -> &'static str {
        match self {
            Self::Default => "-D",
            Self::Empty => "-E",
            Self::Initial => "-I",
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Target<'a> {
    Name(&'a str),
    Special(Special),
}
#[derive(Clone, Debug)]
enum Key {
    Name(String),
    Special(Special),
}
impl Target<'_> {
    fn bucket(self) -> u32 {
        // Observed Bash completion-table order: FNV-1, 512 buckets, newest first
        // within a bucket. Keep special selectors typed rather than key sentinels.
        let name = match self {
            Self::Name(name) => name,
            Self::Special(Special::Default) => "_DefaultCmD_",
            Self::Special(Special::Empty) => "_EmptycmD_",
            Self::Special(Special::Initial) => "_InitialWorD_",
        };
        name.bytes().fold(2166136261u32, |hash, byte| {
            hash.wrapping_mul(16777619) ^ u32::from(byte)
        }) % 512
    }
}
impl Key {
    fn target(&self) -> Target<'_> {
        match self {
            Self::Name(name) => Target::Name(name),
            Self::Special(kind) => Target::Special(*kind),
        }
    }
    fn bytes(&self) -> usize {
        match self {
            Self::Name(name) => name.len(),
            Self::Special(_) => 0,
        }
    }
}

/// Text order is -G, -W, -P, -S, -X, -C, -F.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct Spec<'a> {
    pub(crate) actions: u32,
    pub(crate) options: u16,
    pub(crate) text: [Option<&'a str>; 7],
}
#[derive(Debug)]
pub(crate) struct StoredSpec {
    actions: u32,
    options: u16,
    text: [Option<String>; 7],
    _ticket: Option<StorageAllocation>,
}
impl StoredSpec {
    pub(crate) fn view(&self) -> Spec<'_> {
        Spec {
            actions: self.actions,
            options: self.options,
            text: self.text.each_ref().map(|text| text.as_deref()),
        }
    }
    pub(crate) fn retain(spec: Spec<'_>, state: &State) -> Result<Rc<Self>, i32> {
        let bytes = spec
            .text
            .iter()
            .flatten()
            .try_fold(box_bytes::<Self>(), |sum, text| {
                sum.checked_add(text.len()).ok_or(RESOURCE_STATUS)
            })?;
        let ticket = state.admit_temporary(bytes)?;
        Ok(Rc::new(Self {
            actions: spec.actions,
            options: spec.options,
            text: spec.text.map(|text| text.map(str::to_owned)),
            _ticket: ticket,
        }))
    }
}
#[derive(Debug)]
struct Entry {
    key: Key,
    spec: Rc<StoredSpec>,
}
#[derive(Debug)]
struct Retained {
    entries: Vec<Entry>,
    _ticket: Option<StorageAllocation>,
}
#[derive(Clone, Debug, Default)]
pub(crate) struct CompletionTable {
    pub(crate) initialized: bool,
    retained: Option<Rc<Retained>>,
}
const fn box_bytes<T>() -> usize {
    size_of::<T>() + 2 * size_of::<usize>()
}
impl CompletionTable {
    fn entries(&self) -> &[Entry] {
        self.retained.as_deref().map_or(&[], |table| &table.entries)
    }
    pub(crate) fn len(&self) -> usize {
        self.entries().len()
    }
    pub(crate) fn entry(&self, index: usize) -> (Target<'_>, &Rc<StoredSpec>) {
        let entry = &self.entries()[index];
        (entry.key.target(), &entry.spec)
    }
    pub(crate) fn clear(&mut self) {
        self.retained = None;
    }
    pub(crate) async fn find(
        &self,
        target: Target<'_>,
        cancel: &Cancel,
        work: &mut Work,
    ) -> Result<Option<Rc<StoredSpec>>, Error> {
        for entry in self.entries() {
            scan(entry.key.bytes(), cancel, work).await?;
            if entry.key.target() == target {
                return Ok(Some(entry.spec.clone()));
            }
        }
        Ok(None)
    }
    /// Admit the entire next version before copying keys, then publish atomically.
    pub(crate) async fn updated(
        &self,
        target: Target<'_>,
        spec: Option<Rc<StoredSpec>>,
        state: &SharedState,
        cancel: &Cancel,
        work: &mut Work,
    ) -> Result<Self, Error> {
        let target_bytes = match target {
            Target::Name(name) => name.len(),
            Target::Special(_) => 0,
        };
        scan(target_bytes, cancel, work).await?;
        let bucket = target.bucket();
        let mut bytes = box_bytes::<Retained>();
        let mut count = usize::from(spec.is_some());
        let mut insertion = None;
        let mut replacement = None;
        for (index, entry) in self.entries().iter().enumerate() {
            scan(entry.key.bytes(), cancel, work).await?;
            if insertion.is_none() && entry.key.target().bucket() >= bucket {
                insertion = Some(index);
            }
            if entry.key.target() == target {
                replacement = Some(index);
                continue;
            }
            count = count.checked_add(1).ok_or(RESOURCE_STATUS)?;
            bytes = bytes
                .checked_add(entry.key.bytes())
                .ok_or(RESOURCE_STATUS)?;
        }
        let name_bytes = match target {
            Target::Name(name) if spec.is_some() => name.len(),
            _ => 0,
        };
        bytes = bytes
            .checked_add(name_bytes)
            .and_then(|n| n.checked_add(count.checked_mul(size_of::<Entry>())?))
            .ok_or(RESOURCE_STATUS)?;
        let mut ticket = state.borrow().admit_temporary(bytes)?;
        let mut entries = Vec::new();
        entries
            .try_reserve_exact(count)
            .map_err(|_| Error::Status(RESOURCE_STATUS))?;
        if let Some(ticket) = &mut ticket {
            ticket.grow((entries.capacity() - count) * size_of::<Entry>())?;
        }
        let insertion = replacement.or(insertion).unwrap_or(self.entries().len());
        let mut incoming = spec.map(|spec| Entry {
            key: match target {
                Target::Name(name) => Key::Name(name.to_owned()),
                Target::Special(kind) => Key::Special(kind),
            },
            spec,
        });
        for (index, entry) in self.entries().iter().enumerate() {
            scan(entry.key.bytes(), cancel, work).await?;
            if index == insertion {
                entries.extend(incoming.take());
            }
            if entry.key.target() != target {
                entries.push(Entry {
                    key: entry.key.clone(),
                    spec: entry.spec.clone(),
                });
            }
        }
        entries.extend(incoming);
        Ok(Self {
            initialized: true,
            retained: Some(Rc::new(Retained {
                entries,
                _ticket: ticket,
            })),
        })
    }
}
async fn scan(bytes: usize, cancel: &Cancel, work: &mut Work) -> Result<(), Error> {
    for _ in 0..bytes.max(1) {
        work.checkpoint(cancel).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests;
