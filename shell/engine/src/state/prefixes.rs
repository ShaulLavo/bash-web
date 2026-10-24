//! Prefix capacity belongs to State; amendment payloads belong to active slots.
#[cfg(test)]
use super::Binding;
use super::{State, references::SavedBinding};
use crate::exec::{Error, StorageAllocation, Work};
use std::{collections::BTreeMap, ops::Index};

type Saved = BTreeMap<String, SavedBinding>;
#[derive(Debug, Default)]
struct Slot {
    saved: Saved,
    // Drop the saved payload before refunding its amendment reservation.
    amendments: Option<StorageAllocation>,
}
#[derive(Debug, Default)]
pub(super) struct Prefixes {
    slots: Box<[Slot]>,
    len: usize,
    // Drop all slots and their control storage before refunding capacity.
    memory: Option<StorageAllocation>,
}
impl Index<usize> for Prefixes {
    type Output = Saved;
    fn index(&self, index: usize) -> &Saved {
        &self.slots[..self.len][index].saved
    }
}
impl std::ops::IndexMut<usize> for Prefixes {
    fn index_mut(&mut self, index: usize) -> &mut Saved {
        &mut self.slots[..self.len][index].saved
    }
}
impl Prefixes {
    pub(super) fn len(&self) -> usize {
        self.len
    }
    pub(super) fn is_empty(&self) -> bool {
        self.len == 0
    }
    pub(super) fn iter(&self) -> impl Iterator<Item = &Saved> {
        self.slots[..self.len].iter().map(|slot| &slot.saved)
    }
    pub(super) fn last(&self) -> Option<&Saved> {
        self.iter().last()
    }
    pub(super) fn last_mut(&mut self) -> Option<&mut Saved> {
        self.slots[..self.len]
            .last_mut()
            .map(|slot| &mut slot.saved)
    }
    pub(super) fn prepare(
        &mut self,
        memory: Option<StorageAllocation>,
        work: &mut Work,
    ) -> Result<(), Error> {
        if self.len < self.slots.len() {
            return Ok(());
        }
        let capacity = self.len.checked_mul(2).ok_or(2)?.max(1);
        let bytes = capacity.checked_mul(std::mem::size_of::<Slot>()).ok_or(2)?;
        work.admit_storage(bytes)?;
        let allocation = memory
            .map(|mut ticket| ticket.grow(bytes).map(|()| ticket))
            .transpose()
            .map_err(|_| Error::Status(crate::exec::RESOURCE_STATUS))?;
        let mut slots = Box::<[Slot]>::new_uninit_slice(capacity);
        for slot in &mut slots {
            slot.write(Slot::default());
        }
        // Every element above was initialized, including unused retained slots.
        let mut slots = unsafe { slots.assume_init() };
        for (to, from) in slots.iter_mut().zip(self.slots.iter_mut()) {
            *to = std::mem::take(from);
        }
        drop(std::mem::replace(&mut self.slots, slots));
        self.memory = allocation;
        Ok(())
    }
    pub(super) fn push_prepared(&mut self, saved: Saved, amendments: Option<StorageAllocation>) {
        assert!(
            self.len < self.slots.len(),
            "prefix capacity admitted before publication"
        );
        self.slots[self.len] = Slot { saved, amendments };
        self.len += 1;
    }
    pub(super) fn pop(&mut self) -> Option<Saved> {
        self.len = self.len.checked_sub(1)?;
        Some(std::mem::take(&mut self.slots[self.len].saved))
    }
    pub(super) fn pop_memory(&mut self) -> Option<StorageAllocation> {
        self.slots[self.len].amendments.take()
    }
    // Called only after the popped payload has been restored or destroyed.
    pub(super) fn release_popped(&mut self) {
        self.slots[self.len].amendments = None;
    }
    pub(super) fn reserve_effect(
        &mut self,
        name: &str,
        owner: super::references::Owner,
        bytes: usize,
    ) -> Result<(), Error> {
        for slot in &mut self.slots[..self.len] {
            if !slot
                .saved
                .get(name)
                .is_some_and(|saved| saved.owner == owner)
            {
                continue;
            }
            if let Some(memory) = &mut slot.amendments {
                memory.grow(bytes).map_err(Error::from)?;
            }
        }
        Ok(())
    }
    pub(super) fn amend(
        &mut self,
        name: &str,
        owner: super::references::Owner,
        update: &super::BindingUpdate,
    ) {
        for slot in &mut self.slots[..self.len] {
            let Some(saved) = slot
                .saved
                .get_mut(name)
                .filter(|saved| saved.owner == owner)
            else {
                continue;
            };
            saved.value = update.image(saved.value.as_ref());
        }
    }
    pub(super) fn clear(&mut self, name: &str, owner: super::references::Owner) {
        for slot in &mut self.slots[..self.len] {
            let Some(saved) = slot
                .saved
                .get_mut(name)
                .filter(|saved| saved.owner == owner)
            else {
                continue;
            };
            saved.value = None;
        }
    }
    pub(super) fn from_snapshot(saved: Vec<Saved>, state: &State) -> Result<Self, Error> {
        let len = saved.len();
        let bytes = len.checked_mul(std::mem::size_of::<Slot>()).ok_or(2)?;
        let memory = state.admit_temporary(bytes)?;
        let slots = saved
            .into_iter()
            .map(|saved| Slot {
                saved,
                amendments: None,
            })
            .collect::<Box<[_]>>();
        Ok(Self { slots, len, memory })
    }
    #[cfg(test)]
    pub(super) fn push(&mut self, saved: BTreeMap<String, Option<Binding>>) {
        let mut work = Work::new(0, usize::MAX, 0);
        self.prepare(None, &mut work)
            .unwrap_or_else(|_| panic!("test prefix fits"));
        let saved = saved
            .into_iter()
            .map(|(name, value)| {
                (
                    name,
                    SavedBinding {
                        value,
                        owner: Default::default(),
                    },
                )
            })
            .collect();
        self.push_prepared(saved, None);
    }
    #[cfg(test)]
    pub(super) fn capacity_bytes(&self) -> usize {
        self.slots.len() * std::mem::size_of::<Slot>()
    }
}
