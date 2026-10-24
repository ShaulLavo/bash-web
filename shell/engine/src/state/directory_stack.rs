//! Private storage for pushd/popd/dirs. Each stack version is one `Retained`
//! value that owns both its entries and the State-budget ticket for every
//! byte they keep: the `Rc` box, the vector slots and the string capacities.
//! A change admits the next version's requested bytes before allocating it and
//! replaces the old version only on success, so a refused change leaves data
//! and charge as they were. Clones and snapshots share an immutable version; whoever
//! changes it builds an admitted copy. A State without a memory budget holds
//! no ticket, like the positional parameters.
use super::State;
use crate::exec::{RESOURCE_STATUS, StorageAllocation, StorageBudget};
use std::rc::Rc;

/// Bash's pushd_directory_list, bottom entry first. No variable exposes it.
#[derive(Clone, Debug, Default)]
pub(crate) struct DirectoryStack(Option<Rc<Retained>>);

#[derive(Debug)]
struct Retained {
    entries: Vec<String>,
    _ticket: Option<StorageAllocation>,
}

/// Where an entry of the next version comes from.
enum Slot {
    Old(usize),
    Incoming,
}

impl DirectoryStack {
    pub(super) fn entries(&self) -> &[String] {
        self.0.as_deref().map_or(&[], |retained| &retained.entries)
    }
}

/// The `Rc` box (value plus strong and weak counts) is retained heap too.
const BOX_BYTES: usize = std::mem::size_of::<Retained>() + 2 * std::mem::size_of::<usize>();

fn slot_bytes(count: usize) -> Result<usize, i32> {
    count
        .checked_mul(std::mem::size_of::<String>())
        .ok_or(RESOURCE_STATUS)
}

fn admit(budget: Option<&StorageBudget>, bytes: usize) -> Result<Option<StorageAllocation>, i32> {
    budget
        .map(|budget| budget.admit(bytes))
        .transpose()
        .map_err(|_| RESOURCE_STATUS)
}

impl State {
    pub(crate) fn directories(&self) -> &[String] {
        self.directories.entries()
    }
    /// Builds, without publishing, the next version from old entries and at
    /// most one incoming string. The requested layout's bytes are admitted
    /// before the vector, string copies or Rc are allocated. Dropping the
    /// result unpublished frees it and refunds its ticket.
    fn prepare(
        &self,
        len: usize,
        slot: impl Fn(usize) -> Slot,
        incoming: Option<String>,
    ) -> Result<DirectoryStack, i32> {
        if len == 0 {
            return Ok(DirectoryStack::default());
        }
        let old = self.directories.entries();
        let incoming_bytes = incoming.as_ref().map_or(0, String::capacity);
        let mut bytes = BOX_BYTES
            .checked_add(slot_bytes(len)?)
            .ok_or(RESOURCE_STATUS)?;
        for index in 0..len {
            let entry = match slot(index) {
                Slot::Old(position) => old.get(position).map_or(0, String::len),
                Slot::Incoming => incoming_bytes,
            };
            bytes = bytes.checked_add(entry).ok_or(RESOURCE_STATUS)?;
        }
        let mut ticket = admit(self.memory.as_ref(), bytes)?;
        let mut entries = Vec::new();
        entries
            .try_reserve_exact(len)
            .map_err(|_| RESOURCE_STATUS)?;
        // Reconciles any capacity the vector records beyond the request, so
        // the ticket matches the recorded layout. A refusal drops the vector
        // before it is published. This is bookkeeping of recorded capacity,
        // not allocator-level physical accounting.
        if let Some(ticket) = &mut ticket {
            ticket
                .grow(slot_bytes(entries.capacity() - len)?)
                .map_err(|_| RESOURCE_STATUS)?;
        }
        let mut incoming = incoming;
        for index in 0..len {
            let entry = match slot(index) {
                Slot::Old(position) => old.get(position).cloned().unwrap_or_default(),
                Slot::Incoming => incoming.take().unwrap_or_default(),
            };
            entries.push(entry);
        }
        let retained = Retained {
            entries,
            _ticket: ticket,
        };
        Ok(DirectoryStack(Some(Rc::new(retained))))
    }
    /// Publishes a version prepared earlier by this shell.
    pub(crate) fn install_directories(&mut self, version: DirectoryStack) {
        self.directories = version;
    }
    /// The stack with `entry` on top, prepared before pushd changes directory.
    pub(crate) fn prepare_push_directory(&self, entry: String) -> Result<DirectoryStack, i32> {
        let len = self.directories().len();
        let slot = |index| {
            if index < len {
                Slot::Old(index)
            } else {
                Slot::Incoming
            }
        };
        self.prepare(len + 1, slot, Some(entry))
    }
    /// The stack without its top, prepared before popd changes directory.
    pub(crate) fn prepare_pop_directory(&self) -> Result<DirectoryStack, i32> {
        let len = self.directories().len().saturating_sub(1);
        self.prepare(len, Slot::Old, None)
    }
    /// Replaces the top entry. Nothing changes when the budget refuses it.
    pub(crate) fn replace_top_directory(&mut self, entry: String) -> Result<(), i32> {
        let len = self.directories().len();
        if len == 0 {
            return Ok(());
        }
        let slot = |index| {
            if index + 1 < len {
                Slot::Old(index)
            } else {
                Slot::Incoming
            }
        };
        self.directories = self.prepare(len, slot, Some(entry))?;
        Ok(())
    }
    /// Removes an entry by its bottom-first position.
    pub(crate) fn remove_directory(&mut self, position: usize) -> Result<(), i32> {
        let len = self.directories().len();
        if position >= len {
            return Ok(());
        }
        let slot = |index| Slot::Old(if index < position { index } else { index + 1 });
        self.directories = self.prepare(len - 1, slot, None)?;
        Ok(())
    }
    pub(crate) fn clear_directories(&mut self) {
        self.directories = DirectoryStack::default();
    }
    /// pushd +N/-N: the current directory joins the ring, the ring turns and
    /// the entry that reaches the front leaves the stack. Returns that entry.
    pub(crate) fn rotate_directories(&mut self, count: usize) -> Result<String, i32> {
        let len = self.directories().len();
        let ring = len + 1;
        // Ring position `len` is the current directory.
        let from = |index: usize| (index + ring - count % ring) % ring;
        let target = match from(len) {
            position if position == len => self.cwd.clone(),
            position => self.directories()[position].clone(),
        };
        let slot = |index| match from(index) {
            position if position == len => Slot::Incoming,
            position => Slot::Old(position),
        };
        self.directories = self.prepare(len, slot, Some(self.cwd.clone()))?;
        Ok(target)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(limit: usize) -> (State, StorageBudget) {
        let budget = StorageBudget::new(limit);
        (State::with_memory(budget.clone()), budget)
    }
    fn push(state: &mut State, entry: String) -> Result<(), i32> {
        let version = state.prepare_push_directory(entry)?;
        state.install_directories(version);
        Ok(())
    }
    fn snapshot(state: &super::super::SharedState) -> State {
        use futures::FutureExt;
        let mut work = crate::exec::Work::new(65_536, 65_536, 0);
        State::snapshot(state, &crate::executor::Cancel::new(), &mut work)
            .now_or_never()
            .expect("small snapshot does not yield")
            .unwrap_or_else(|_| panic!("snapshot fits"))
    }
    fn used(budget: &StorageBudget) -> usize {
        budget.observation().0
    }
    /// Every heap byte the current version keeps alive.
    fn retained(state: &State) -> usize {
        let Some(retained) = &state.directories.0 else {
            return 0;
        };
        let strings: usize = retained.entries.iter().map(String::capacity).sum();
        BOX_BYTES + slot_bytes(retained.entries.capacity()).unwrap() + strings
    }

    #[test]
    fn charge_matches_retained_bytes_including_the_rc_box() {
        let (mut state, budget) = state(4096);
        push(&mut state, "/tmp/a".into()).unwrap();
        push(&mut state, "/tmp/b".into()).unwrap();
        assert_eq!(used(&budget), retained(&state));
        assert!(used(&budget) >= BOX_BYTES + 2 * std::mem::size_of::<String>() + 12);
        state.remove_directory(0).unwrap();
        assert_eq!(state.directories(), ["/tmp/b"]);
        assert_eq!(used(&budget), retained(&state));
        state.clear_directories();
        assert_eq!(used(&budget), 0);
    }

    #[test]
    fn zero_budget_push_is_refused_before_anything_is_retained() {
        let (mut state, budget) = state(0);
        assert_eq!(push(&mut state, "/a".into()), Err(RESOURCE_STATUS));
        assert!(state.directories().is_empty());
        assert!(state.directories.0.is_none());
        assert_eq!(used(&budget), 0);
    }

    #[test]
    fn refused_changes_keep_data_and_an_exact_charge() {
        let (mut state, budget) = state(BOX_BYTES + 64);
        push(&mut state, "/a".into()).unwrap();
        let charged = used(&budget);
        assert_eq!(charged, retained(&state));
        assert!(push(&mut state, "x".repeat(1024)).is_err());
        assert!(state.replace_top_directory("y".repeat(1024)).is_err());
        assert_eq!(state.directories(), ["/a"]);
        assert_eq!(used(&budget), charged);
        assert_eq!(used(&budget), retained(&state));
    }

    #[test]
    fn snapshots_share_directory_charge_and_change_through_admitted_copies() {
        let (mut state, budget) = state(4096);
        push(&mut state, "/a".into()).unwrap();
        let source = used(&budget);
        let state = state.shared();
        let mut copy = snapshot(&state);
        assert_eq!(used(&budget), source);
        copy.clear_directories();
        assert_eq!(state.borrow().directories(), ["/a"]);
        assert_eq!(used(&budget), source);
        let mut copy = snapshot(&state);
        push(&mut copy, "/b".into()).unwrap();
        assert_eq!(used(&budget), source + retained(&copy));
        assert_eq!(state.borrow().directories(), ["/a"]);
        drop(copy);
        assert_eq!(used(&budget), source);
        drop(state);
        assert_eq!(used(&budget), 0);
    }

    #[test]
    fn prepared_versions_publish_only_on_install_and_refund_when_dropped() {
        let (mut state, budget) = state(4096);
        push(&mut state, "/a".into()).unwrap();
        let charged = used(&budget);
        let pushed = state.prepare_push_directory("/b".into()).unwrap();
        assert_eq!(state.directories(), ["/a"]);
        assert!(used(&budget) > charged);
        // A failed or cancelled cd drops the prepared version.
        drop(pushed);
        assert_eq!(used(&budget), charged);
        let popped = state.prepare_pop_directory().unwrap();
        assert_eq!(state.directories(), ["/a"]);
        state.install_directories(popped);
        assert!(state.directories().is_empty());
        assert_eq!(used(&budget), 0);
    }

    #[test]
    fn refused_preparations_change_nothing() {
        let (mut state, budget) = state(BOX_BYTES + 64);
        push(&mut state, "/a".into()).unwrap();
        let charged = used(&budget);
        assert_eq!(
            state.prepare_push_directory("x".repeat(1024)).err(),
            Some(RESOURCE_STATUS)
        );
        assert_eq!(state.prepare_pop_directory().err(), None);
        assert_eq!(state.directories(), ["/a"]);
        assert_eq!(used(&budget), charged);
    }

    #[test]
    fn rotation_moves_the_ring_like_bash() {
        let (mut state, budget) = state(4096);
        state.cwd = "/tmp".into();
        push(&mut state, "/".into()).unwrap();
        push(&mut state, "/usr".into()).unwrap();
        // Display order: /tmp /usr /. pushd +1 shows /usr / /tmp.
        assert_eq!(state.rotate_directories(1).unwrap(), "/usr");
        assert_eq!(state.directories(), ["/tmp", "/"]);
        // pushd -0 from /usr / /tmp shows /tmp /usr /.
        state.cwd = "/usr".into();
        assert_eq!(state.rotate_directories(2).unwrap(), "/tmp");
        assert_eq!(state.directories(), ["/", "/usr"]);
        assert_eq!(used(&budget), retained(&state));
    }
}
