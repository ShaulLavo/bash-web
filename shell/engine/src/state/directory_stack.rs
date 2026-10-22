//! Private storage for pushd/popd/dirs. Its retained bytes stay charged to
//! the shell's storage budget for as long as the entries live, like the
//! positional parameters, rather than only for the command that added them.
use super::State;
use crate::exec::{RESOURCE_STATUS, StorageAllocation};
use std::{cell::RefCell, rc::Rc};

/// Bash's pushd_directory_list, bottom entry first. No variable exposes it.
#[derive(Clone, Debug, Default)]
pub(crate) struct DirectoryStack {
    entries: Vec<String>,
    memory: Option<Rc<RefCell<StorageAllocation>>>,
}

impl DirectoryStack {
    /// An isolated shell's copy, with its own charge for the same bytes.
    pub(super) fn fork(&self, entries: Vec<String>) -> Result<Self, i32> {
        let memory = self
            .memory
            .as_ref()
            .map(|memory| memory.borrow().fork())
            .transpose()?
            .map(|ticket| Rc::new(RefCell::new(ticket)));
        Ok(Self { entries, memory })
    }
    pub(super) fn entries(&self) -> &[String] {
        &self.entries
    }
}

fn retained_bytes(entries: &Vec<String>) -> Result<usize, i32> {
    let slots = entries
        .capacity()
        .checked_mul(std::mem::size_of::<String>())
        .ok_or(RESOURCE_STATUS)?;
    entries.iter().try_fold(slots, |bytes, entry| {
        bytes.checked_add(entry.capacity()).ok_or(RESOURCE_STATUS)
    })
}

impl State {
    pub(crate) fn directories(&self) -> &[String] {
        &self.directories.entries
    }
    /// Charge or refund the stack's current retained size.
    fn recharge_directories(&mut self) -> Result<(), i32> {
        let bytes = retained_bytes(&self.directories.entries)?;
        if let Some(memory) = &self.directories.memory {
            return memory
                .borrow_mut()
                .resize(bytes)
                .map_err(|_| RESOURCE_STATUS);
        }
        let Some(budget) = &self.memory else {
            return Ok(());
        };
        let ticket = budget.admit(bytes).map_err(|_| RESOURCE_STATUS)?;
        self.directories.memory = Some(Rc::new(RefCell::new(ticket)));
        Ok(())
    }
    /// Adds a new top entry. Nothing changes when the budget refuses it.
    pub(crate) fn push_directory(&mut self, entry: String) -> Result<(), i32> {
        self.directories
            .entries
            .try_reserve(1)
            .map_err(|_| RESOURCE_STATUS)?;
        self.directories.entries.push(entry);
        if let Err(status) = self.recharge_directories() {
            self.directories.entries.pop();
            self.directories.entries.shrink_to_fit();
            return Err(status);
        }
        Ok(())
    }
    /// Replaces the top entry. Nothing changes when the budget refuses it.
    pub(crate) fn replace_top_directory(&mut self, entry: String) -> Result<(), i32> {
        let Some(top) = self.directories.entries.last_mut() else {
            return Ok(());
        };
        let previous = std::mem::replace(top, entry);
        if let Err(status) = self.recharge_directories() {
            if let Some(top) = self.directories.entries.last_mut() {
                *top = previous;
            }
            return Err(status);
        }
        Ok(())
    }
    /// Removes an entry by its bottom-first position and refunds its bytes.
    pub(crate) fn remove_directory(&mut self, position: usize) -> Result<(), i32> {
        if position < self.directories.entries.len() {
            self.directories.entries.remove(position);
        }
        self.recharge_directories()
    }
    pub(crate) fn clear_directories(&mut self) -> Result<(), i32> {
        self.directories.entries = Vec::new();
        self.recharge_directories()
    }
    /// pushd +N/-N: the current directory joins the ring, the ring turns and
    /// the entry that reaches the front leaves the stack. Returns that entry.
    pub(crate) fn rotate_directories(&mut self, count: usize) -> Result<String, i32> {
        self.push_directory(self.cwd.clone())?;
        self.directories.entries.rotate_right(count);
        let target = self.directories.entries.pop().unwrap_or_default();
        self.recharge_directories()?;
        Ok(target)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exec::StorageBudget;

    fn state(limit: usize) -> (State, StorageBudget) {
        let budget = StorageBudget::new(limit);
        (State::with_memory(budget.clone()), budget)
    }
    fn used(budget: &StorageBudget) -> usize {
        budget.observation().0
    }

    #[test]
    fn retained_entries_stay_charged_until_removed() {
        let (mut state, budget) = state(4096);
        let before = used(&budget);
        state.push_directory("/tmp/a".into()).unwrap();
        state.push_directory("/tmp/b".into()).unwrap();
        let charged = used(&budget) - before;
        assert!(charged >= 2 * std::mem::size_of::<String>() + 12);
        state.remove_directory(0).unwrap();
        assert!(used(&budget) - before < charged);
        state.clear_directories().unwrap();
        assert_eq!(used(&budget), before);
    }

    #[test]
    fn refused_push_and_replace_leave_the_stack_unchanged() {
        let (mut state, budget) = state(std::mem::size_of::<String>() * 4 + 8);
        state.push_directory("/a".into()).unwrap();
        let charged = used(&budget);
        assert!(state.push_directory("x".repeat(1024)).is_err());
        assert_eq!(state.directories(), ["/a"]);
        assert!(state.replace_top_directory("y".repeat(1024)).is_err());
        assert_eq!(state.directories(), ["/a"]);
        assert_eq!(used(&budget), charged);
    }

    #[test]
    fn forks_charge_separately_and_refund_on_drop() {
        let (mut state, budget) = state(4096);
        state.push_directory("/tmp".into()).unwrap();
        let one = used(&budget);
        let copy = state
            .directories
            .fork(state.directories().to_vec())
            .unwrap();
        assert!(used(&budget) > one);
        drop(copy);
        assert_eq!(used(&budget), one);
    }

    #[test]
    fn rotation_moves_the_ring_like_bash() {
        let (mut state, _budget) = state(4096);
        state.cwd = "/tmp".into();
        state.push_directory("/".into()).unwrap();
        state.push_directory("/usr".into()).unwrap();
        // Display order: /tmp /usr /. pushd +1 shows /usr / /tmp.
        assert_eq!(state.rotate_directories(1).unwrap(), "/usr");
        assert_eq!(state.directories(), ["/tmp", "/"]);
    }
}
