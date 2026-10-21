//! Original BASH_REMATCH publisher over the shared indexed binding model.
//! Staging yields without a State borrow. One synchronous commit preserves the
//! visible local/prefix owner, attributes and ordinary nameref identity.
use super::{
    Binding, Indexed, ScalarResolution, SharedState, State, snapshot_node_bytes, snapshot_steps,
};
use crate::{
    exec::{Error, Work},
    executor::Cancel,
};
use std::{mem::size_of, rc::Rc};

const NAME: &str = "BASH_REMATCH";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RematchWarning {
    Circular,
    DepthExceeded,
}
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum RematchRejection {
    Readonly,
    InvalidIdentifier(String),
}
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum RematchPublication {
    Published,
    PublishedWithWarning(RematchWarning),
    Rejected(RematchRejection),
}

fn identifier(name: &str) -> bool {
    let mut bytes = name.bytes();
    bytes
        .next()
        .is_some_and(|byte| byte.is_ascii_alphabetic() || byte == b'_')
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}
fn resolution(state: &State) -> (&str, Option<RematchWarning>) {
    match state.resolve_scalar_target(NAME) {
        ScalarResolution::Target(target) => (target, None),
        ScalarResolution::Cycle => (NAME, Some(RematchWarning::Circular)),
        ScalarResolution::DepthExceeded => (NAME, Some(RematchWarning::DepthExceeded)),
    }
}
async fn validate(
    value: &str,
    captures: &[Option<(usize, usize)>],
    work: &mut Work,
    cancel: &Cancel,
) -> Result<(), Error> {
    if !captures.is_empty() {
        i64::try_from(captures.len() - 1).map_err(|_| Error::Status(2))?;
    }
    for range in captures {
        work.checkpoint(cancel).await?;
        let Some((start, end)) = *range else {
            continue;
        };
        if start > end || !value.is_char_boundary(start) || !value.is_char_boundary(end) {
            return Err(2.into());
        }
    }
    Ok(())
}
async fn stage(
    value: &str,
    captures: &[Option<(usize, usize)>],
    work: &mut Work,
    cancel: &Cancel,
) -> Result<Binding, Error> {
    work.admit_storage(size_of::<Indexed>() + 2 * size_of::<usize>())?;
    let mut values = Indexed::default();
    for (index, range) in captures.iter().enumerate() {
        work.checkpoint(cancel).await?;
        let text = range.map_or("", |(start, end)| &value[start..end]);
        let index = i64::try_from(index).map_err(|_| Error::Status(2))?;
        work.admit_storage(
            values
                .insertion_bytes(index)
                .checked_add(text.len())
                .ok_or(2)?,
        )?;
        let mut captured = String::new();
        captured
            .try_reserve_exact(text.len())
            .map_err(|_| Error::Status(2))?;
        for ch in text.chars() {
            work.checkpoint(cancel).await?;
            captured.push(ch);
        }
        values.insert(index, captured);
    }
    Ok(Binding::Indexed(Rc::new(values)))
}

impl State {
    pub(crate) async fn publish_rematch(
        state: &SharedState,
        value: &str,
        captures: &[Option<(usize, usize)>],
        work: &mut Work,
        cancel: &Cancel,
    ) -> Result<RematchPublication, Error> {
        work.checkpoint(cancel).await?;
        validate(value, captures, work, cancel).await?;
        let reference_bytes = state.borrow().reference_work(NAME)?;
        snapshot_steps(reference_bytes, cancel, work).await?;
        let length = resolution(&state.borrow()).0.len();
        work.admit_storage(length)?;
        snapshot_steps(length, cancel, work).await?;
        let (target, warning, readonly) = {
            let state = state.borrow();
            let (target, warning) = resolution(&state);
            (target.to_owned(), warning, state.is_readonly(target))
        };
        if !identifier(&target) {
            return Ok(RematchPublication::Rejected(
                RematchRejection::InvalidIdentifier(target),
            ));
        }
        if readonly {
            return Ok(RematchPublication::Rejected(RematchRejection::Readonly));
        }
        // The IFS effective-source hook is a coordinated VARIABLES prerequisite.
        // No generic refresh is correct here: Bash keeps the old quoted-star
        // separator but splits using the newly published element zero.
        let binding = stage(value, captures, work, cancel).await?;
        work.admit_storage(snapshot_node_bytes::<Binding>()?)?;
        work.checkpoint(cancel).await?;
        let mut state = state.borrow_mut();
        state.reserve_local_value(&target, binding.storage_bytes())?;
        if warning.is_some() {
            state.namerefs.remove(NAME);
        }
        state.variables.insert(target, binding);
        Ok(warning.map_or(
            RematchPublication::Published,
            RematchPublication::PublishedWithWarning,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::super::FunctionFrame;
    use super::*;
    use crate::{exec::StorageBudget, executor::Executor};
    use futures::FutureExt;
    fn finish<T>(future: impl std::future::Future<Output = T>) -> T {
        let mut future = std::pin::pin!(future);
        let waker = futures::task::noop_waker();
        let mut context = std::task::Context::from_waker(&waker);
        let mut remaining = 100_000;
        loop {
            assert!(remaining > 0, "rematch publication did not finish");
            remaining -= 1;
            if let std::task::Poll::Ready(value) = future.as_mut().poll(&mut context) {
                return value;
            }
        }
    }
    fn enter_local(state: &SharedState) -> FunctionFrame {
        let frame = FunctionFrame::enter(state.clone(), Vec::new(), usize::MAX).unwrap();
        let mut state = state.borrow_mut();
        state.local(NAME.to_owned(), String::from("local")).unwrap();
        frame
    }
    fn publish(
        state: &SharedState,
        text: &str,
        ranges: &[Option<(usize, usize)>],
    ) -> RematchPublication {
        let mut work = Work::new(1_000_000, 1_000_000, 16);
        finish(State::publish_rematch(
            state,
            text,
            ranges,
            &mut work,
            &Cancel::new(),
        ))
        .unwrap_or_else(|_| panic!("rematch staging must succeed"))
    }
    #[test]
    fn rematch_slots_clear_and_invalid_ranges_preserve_binding() {
        let state = State::default().shared();
        assert_eq!(
            publish(&state, "abc", &[Some((1, 2)), None, Some((2, 2))]),
            RematchPublication::Published
        );
        assert_eq!(state.borrow().array_count(NAME), 3);
        assert_eq!(state.borrow().array_element(NAME, 0), Some("b"));
        assert_eq!(state.borrow().array_element(NAME, 1), Some(""));
        assert_eq!(state.borrow().array_element(NAME, 2), Some(""));
        for range in [Some((2, 1)), Some((0, 4)), Some((1, 2))] {
            let mut work = Work::new(1000, 1000, 16);
            assert!(
                finish(State::publish_rematch(
                    &state,
                    "é",
                    &[range],
                    &mut work,
                    &Cancel::new()
                ))
                .is_err()
            );
            assert_eq!(state.borrow().array_element(NAME, 0), Some("b"));
        }
        assert_eq!(publish(&state, "", &[]), RematchPublication::Published);
        assert_eq!(state.borrow().array_count(NAME), 0);
        assert!(matches!(
            state.borrow().binding(NAME),
            Some(Binding::Indexed(_))
        ));
    }
    #[test]
    fn rematch_local_memory_failure_is_atomic_and_refunds() {
        let memory = StorageBudget::new(65_536);
        let state = State::with_memory(memory.clone()).shared();
        let frame = enter_local(&state);
        let before = memory.observation().0;
        let pressure = memory.admit(65_536 - before - 1).unwrap();
        let mut work = Work::new(100_000, 100_000, 16);
        assert!(matches!(
            finish(State::publish_rematch(
                &state,
                "x",
                &[Some((0, 1))],
                &mut work,
                &Cancel::new()
            )),
            Err(Error::Status(crate::exec::RESOURCE_STATUS))
        ));
        assert_eq!(state.borrow().array_element(NAME, 0), Some("local"));
        drop(pressure);
        assert_eq!(memory.observation().0, before);
        publish(&state, "abc", &[Some((0, 3)), None]);
        assert!(memory.observation().0 > before);
        drop(frame);
        assert_eq!(memory.observation().0, 0);
        assert_eq!(state.borrow().array_count(NAME), 0);
    }
    #[test]
    fn rematch_outcomes_keep_nameref_identity_and_readonly_contents() {
        let state = State::default().shared();
        state
            .borrow_mut()
            .declare_nameref(NAME.into(), "other".into(), false)
            .unwrap();
        publish(&state, "abc", &[Some((1, 2))]);
        assert!(state.borrow().is_nameref(NAME));
        assert_eq!(state.borrow().array_element("other", 0), Some("b"));
        state.borrow_mut().readonly("other".into(), None).unwrap();
        assert_eq!(
            publish(&state, "", &[]),
            RematchPublication::Rejected(RematchRejection::Readonly)
        );
        assert_eq!(state.borrow().array_element("other", 0), Some("b"));
        let state = State::default().shared();
        state
            .borrow_mut()
            .declare_nameref(NAME.into(), "other".into(), false)
            .unwrap();
        state
            .borrow_mut()
            .declare_nameref("other".into(), NAME.into(), false)
            .unwrap();
        assert_eq!(
            publish(&state, "b", &[Some((0, 1))]),
            RematchPublication::PublishedWithWarning(RematchWarning::Circular)
        );
        assert!(!state.borrow().is_nameref(NAME));
        assert!(state.borrow().is_nameref("other"));
        assert_eq!(state.borrow().array_element(NAME, 0), Some("b"));
    }
    #[test]
    fn invalid_reference_reports_actual_target_without_publication() {
        let state = State::default().shared();
        state
            .borrow_mut()
            .declare_nameref(NAME.into(), "x[1]".into(), false)
            .unwrap();
        assert_eq!(
            publish(&state, "b", &[Some((0, 1))]),
            RematchPublication::Rejected(RematchRejection::InvalidIdentifier("x[1]".into()))
        );
        assert!(state.borrow().is_nameref(NAME));
        assert!(state.borrow().binding("x").is_none());
    }
    #[test]
    fn cancelled_readonly_publication_stays_a_fatal_cancel() {
        let state = State::default().shared();
        state
            .borrow_mut()
            .readonly(NAME.into(), Some("old".into()))
            .unwrap();
        let cancel = Cancel::new();
        cancel.cancel();
        let mut work = Work::new(100_000, 100_000, 16);
        assert!(matches!(
            finish(State::publish_rematch(&state, "", &[], &mut work, &cancel)),
            Err(Error::Status(130))
        ));
        assert_eq!(state.borrow().array_element(NAME, 0), Some("old"));
    }
    #[test]
    fn rematch_work_and_cancel_fail_before_mutation_and_release_tasks() {
        let state = State::default().shared();
        state
            .borrow_mut()
            .assign_parameter(NAME.into(), "old".into())
            .unwrap();
        let frame = enter_local(&state);
        let text = "a".repeat(65536);
        let mut work = Work::new(1_000_000, 100, 16);
        assert!(
            finish(State::publish_rematch(
                &state,
                &text,
                &[Some((0, text.len()))],
                &mut work,
                &Cancel::new()
            ))
            .is_err()
        );
        let executor = Executor::new();
        let cancel = Cancel::new();
        let child_cancel = cancel.clone();
        let child_state = state.clone();
        let job = executor.spawn(async move {
            let mut work = Work::new(1_000_000, 1_000_000, 16);
            match State::publish_rematch(
                &child_state,
                &text,
                &[Some((0, text.len()))],
                &mut work,
                &child_cancel,
            )
            .await
            {
                Err(Error::Status(status)) => status,
                _ => panic!("publication must be interrupted"),
            }
        });
        executor.drive(1);
        assert!(!job.is_finished());
        cancel.cancel();
        let drained = executor.drive(64);
        assert_eq!(drained.pending, 0);
        assert!(matches!(job.now_or_never(), Some(130)));
        assert_eq!(state.borrow().array_element(NAME, 0), Some("local"));
        publish(&state, "ok", &[Some((0, 2))]);
        assert_eq!(state.borrow().array_element(NAME, 0), Some("ok"));
        drop(frame);
        assert_eq!(state.borrow().array_element(NAME, 0), Some("old"));
    }
}
