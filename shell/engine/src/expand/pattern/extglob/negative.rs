//! Complement edges use admitted substring relations, never recursive backtracking.
use super::{Instruction, Pattern, States, initialize_flags};
use crate::executor::Cancel;
use crate::expand::{Error, Work, admit_vec_exact, admit_vec_slot};

struct Machine<'a> {
    pattern: &'a Pattern,
    code: &'a [Instruction],
    value: &'a [char],
    excluded: &'a [Option<Vec<bool>>],
}
impl Machine<'_> {
    async fn accept_from(
        &self,
        states: &mut States,
        start: (usize, usize),
        accepted: &mut [bool],
        work: &mut Work,
        cancel: &Cancel,
    ) -> Result<(), Error> {
        states.clear(work, cancel).await?;
        states.insert(start.1 * self.code.len() + start.0);
        let mut cursor = 0;
        while cursor < states.pending.len() {
            work.checkpoint(cancel).await?;
            let node = states.pending[cursor];
            self.step(states, node, accepted, work, cancel).await?;
            cursor += 1;
        }
        Ok(())
    }

    async fn step(
        &self,
        states: &mut States,
        node: usize,
        accepted: &mut [bool],
        work: &mut Work,
        cancel: &Cancel,
    ) -> Result<(), Error> {
        let position = node / self.code.len();
        let instruction = node % self.code.len();
        let offset = position * self.code.len();
        match self.code[instruction] {
            Instruction::Accept => accepted[position] = true,
            Instruction::Jump(target) => states.insert(offset + target),
            Instruction::Split(left, right) => {
                states.insert(offset + left);
                states.insert(offset + right);
            }
            Instruction::Consume(atom, target) => {
                self.consume(states, position, (atom, target), work, cancel)
                    .await?;
            }
            Instruction::Negate(_, target) => {
                self.complement(states, position, (instruction, target), work, cancel)
                    .await?;
            }
        }
        Ok(())
    }

    async fn consume(
        &self,
        states: &mut States,
        position: usize,
        edge: (super::Atom, usize),
        work: &mut Work,
        cancel: &Cancel,
    ) -> Result<(), Error> {
        let Some(&value) = self.value.get(position) else {
            return Ok(());
        };
        if self.pattern.matches(&edge.0, value, work, cancel).await? {
            states.insert((position + 1) * self.code.len() + edge.1);
        }
        Ok(())
    }

    async fn complement(
        &self,
        states: &mut States,
        position: usize,
        edge: (usize, usize),
        work: &mut Work,
        cancel: &Cancel,
    ) -> Result<(), Error> {
        let relation = self.excluded[edge.0].as_ref().ok_or(2)?;
        let width = self.value.len() + 1;
        for end in position..width {
            work.checkpoint(cancel).await?;
            if !relation[position * width + end] {
                states.insert(end * self.code.len() + edge.1);
            }
        }
        Ok(())
    }
}

async fn flags(count: usize, work: &mut Work, cancel: &Cancel) -> Result<Vec<bool>, Error> {
    let mut flags = Vec::new();
    admit_vec_exact(&mut flags, count, work)?;
    initialize_flags(&mut flags, count, work, cancel).await?;
    Ok(flags)
}

pub(super) fn matches<'a>(
    pattern: &'a Pattern,
    code: &'a [Instruction],
    value: &'a str,
    work: &'a mut Work,
    cancel: &'a Cancel,
) -> crate::exec::ResultFuture<'a, bool> {
    // Keep the complement machine out of every enclosing expansion future,
    // including recursive scalar operands that never select this branch.
    work.frame(move |work| run(pattern, code, value, work, cancel))
}

async fn run(
    pattern: &Pattern,
    code: &[Instruction],
    value: &str,
    work: &mut Work,
    cancel: &Cancel,
) -> Result<bool, Error> {
    let mut characters = Vec::new();
    for ch in value.chars() {
        work.checkpoint(cancel).await?;
        admit_vec_slot(&mut characters, work)?;
        characters.push(ch);
    }
    let width = characters.len().checked_add(1).ok_or(2)?;
    let cells = width.checked_mul(width).ok_or(2)?;
    let count = width.checked_mul(code.len()).ok_or(2)?;
    let mut states = States::new(count, work, cancel).await?;
    let mut excluded = Vec::new();
    admit_vec_exact(&mut excluded, code.len(), work)?;
    for _ in code {
        work.checkpoint(cancel).await?;
        excluded.push(None);
    }
    // Every nested entry is emitted after its containing negative instruction.
    // Its relation is therefore complete before the containing body can use it.
    for index in (0..code.len()).rev() {
        work.checkpoint(cancel).await?;
        let Instruction::Negate(entry, _) = code[index] else {
            continue;
        };
        let mut relation = flags(cells, work, cancel).await?;
        let machine = Machine {
            pattern,
            code,
            value: &characters,
            excluded: &excluded,
        };
        for start in 0..width {
            let row = &mut relation[start * width..(start + 1) * width];
            machine
                .accept_from(&mut states, (entry, start), row, work, cancel)
                .await?;
        }
        excluded[index] = Some(relation);
    }
    let mut accepted = flags(width, work, cancel).await?;
    let machine = Machine {
        pattern,
        code,
        value: &characters,
        excluded: &excluded,
    };
    machine
        .accept_from(&mut states, (0, 0), &mut accepted, work, cancel)
        .await?;
    Ok(accepted[characters.len()])
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::FutureExt;

    #[test]
    fn negative_frame_is_admitted_before_polling() {
        let pattern = Pattern::default();
        let code = [Instruction::Accept];
        let cancel = Cancel::new();
        let mut probe = Work::new(100, 0, 1);
        let bytes = std::mem::size_of_val(&run(&pattern, &code, "", &mut probe, &cancel));
        let mut denied = Work::new(100, bytes - 1, 1);
        assert!(matches!(
            matches(&pattern, &code, "", &mut denied, &cancel).now_or_never(),
            Some(Err(Error::Status(2)))
        ));
        assert_eq!(denied.storage_left(), bytes - 1);
        assert_eq!(denied.remaining, 100);
        let mut exact = Work::new(100, bytes, 1);
        let frame = matches(&pattern, &code, "", &mut exact, &cancel);
        drop(frame);
        assert_eq!(exact.storage_left(), 0);
        assert_eq!(exact.remaining, 100);
    }

    #[test]
    fn negative_frame_refunds_execution_on_completion_cancellation_and_drop() {
        let scope = crate::exec::Scope::new(
            1024,
            crate::exec::StorageBudget::new(1024),
            crate::exec::StorageBudget::new(65536),
        );
        let pattern = Pattern::default();
        let code = [Instruction::Accept];
        let cancel = Cancel::new();
        let mut work = Work::new(100000, 100000, 1).with_frame_scope(scope.clone());
        assert!(matches!(
            matches(&pattern, &code, "", &mut work, &cancel).now_or_never(),
            Some(Ok(true))
        ));
        assert_eq!(scope.execution_available(), 65536);
        let value = "a".repeat(256);
        let mut pending = Box::pin(matches(&pattern, &code, &value, &mut work, &cancel));
        assert!(pending.as_mut().now_or_never().is_none());
        assert!(scope.execution_available() < 65536);
        cancel.cancel();
        assert!(matches!(
            pending.as_mut().now_or_never(),
            Some(Err(Error::Status(130)))
        ));
        drop(pending);
        assert_eq!(scope.execution_available(), 65536);
        let cancel = Cancel::new();
        let mut pending = Box::pin(matches(&pattern, &code, &value, &mut work, &cancel));
        assert!(pending.as_mut().now_or_never().is_none());
        assert!(scope.execution_available() < 65536);
        drop(pending);
        assert_eq!(scope.execution_available(), 65536);
    }

    #[test]
    fn relation_storage_is_admitted_before_initialization() {
        let cancel = Cancel::new();
        let mut denied = Work::new(100, 7, 16);
        assert!(matches!(
            flags(8, &mut denied, &cancel).now_or_never(),
            Some(Err(Error::Status(2)))
        ));
        assert_eq!(denied.storage_remaining, 7);
        assert_eq!(denied.remaining, 100);
        let mut exact = Work::new(100, 8, 16);
        assert_eq!(
            flags(8, &mut exact, &cancel)
                .now_or_never()
                .and_then(Result::ok),
            Some(vec![false; 8])
        );
        assert_eq!(exact.storage_remaining, 0);
        assert_eq!(exact.remaining, 92);
    }

    #[test]
    fn relation_initialization_checks_work_and_cancellation() {
        let cancel = Cancel::new();
        let mut exhausted = Work::new(3, 8, 16);
        assert!(matches!(
            flags(8, &mut exhausted, &cancel).now_or_never(),
            Some(Err(Error::Status(2)))
        ));
        let mut work = Work::new(100, 8, 16);
        cancel.cancel();
        assert!(matches!(
            flags(8, &mut work, &cancel).now_or_never(),
            Some(Err(Error::Status(130)))
        ));
    }
}
