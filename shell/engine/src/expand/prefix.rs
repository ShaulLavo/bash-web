use super::{Error, Expansion, Protection, Work};
use crate::state::SharedState;
use std::ops::Bound::{Excluded, Included, Unbounded};

impl Expansion<'_> {
    pub(super) fn prefix_names<'a>(
        &'a mut self,
        prefix: &'a str,
        star: bool,
        state: &'a SharedState,
        quoted: bool,
        scalar: bool,
    ) -> crate::exec::ResultFuture<'a, ()> {
        self.part_frame(move |expansion| {
            expansion.prefix_name_fields(prefix, star, state, quoted, scalar)
        })
    }

    async fn prefix_name_fields(
        &mut self,
        prefix: &str,
        star: bool,
        state: &SharedState,
        quoted: bool,
        scalar: bool,
    ) -> Result<(), Error> {
        if !super::operand::scalar_name(prefix) {
            return Err(2.into());
        }
        let separator = self.ifs_separator(state).await?;
        let list = !scalar && (!star || !quoted && separator.is_some());
        self.segments.needs_split |= list || !scalar && !quoted;
        self.segments.list_word |= list;
        if scalar || quoted && star {
            self.segments.empty(self.work)?;
        }
        let separator = if list || scalar && !star {
            separator.or(Some(' '))
        } else {
            separator
        };
        let protection = Protection::expansion(quoted || scalar, state);
        let mut previous = None;
        let mut index = 0;
        loop {
            self.work.checkpoint(self.cancel).await?;
            let Some(name) = next_name(
                state,
                prefix,
                previous.as_deref(),
                self.raw_remaining,
                self.work,
            )?
            else {
                return Ok(());
            };
            if self.elements_remaining == 0 {
                return Err(2.into());
            }
            self.elements_remaining -= 1;
            self.element_boundary(index, list, separator, quoted || scalar)
                .await?;
            self.segment(&name, protection, quoted || scalar).await?;
            previous = Some(name);
            index += 1;
        }
    }
}

fn next_name(
    state: &SharedState,
    prefix: &str,
    previous: Option<&str>,
    max: usize,
    work: &mut Work,
) -> Result<Option<String>, Error> {
    let state = state.borrow();
    let lower = previous.map_or(Included(prefix), Excluded);
    let binding = state.bindings().range::<str, _>((lower, Unbounded)).next();
    let nameref = state.namerefs().range::<str, _>((lower, Unbounded)).next();
    let name = binding.map(|(name, _)| name).into_iter();
    let Some(name) = name.chain(nameref.map(|(name, _)| name)).min() else {
        return Ok(None);
    };
    if !name.starts_with(prefix) {
        return Ok(None);
    }
    if name.len() > max {
        return Err(2.into());
    }
    work.admit_storage(name.len())?;
    Ok(Some(name.to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::State;

    #[test]
    fn names_never_copy_payloads() {
        let mut state = State::default();
        state
            .assign_parameter("param_b".into(), "x".repeat(128 * 1024))
            .unwrap();
        state.assign_parameter("param_a".into(), "".into()).unwrap();
        state
            .declare_nameref("param_c".into(), "missing".repeat(16 * 1024), false)
            .unwrap();
        let state = state.shared();
        for (previous, expected) in [
            (None, "param_a"),
            (Some("param_a"), "param_b"),
            (Some("param_b"), "param_c"),
        ] {
            let mut work = Work::new(16, 7, 1);
            assert!(matches!(
                next_name(&state, "param_", previous, 7, &mut work),
                Ok(Some(name)) if name == expected
            ));
            assert_eq!(work.storage_remaining, 0);
        }
        let mut work = Work::new(16, 7, 1);
        assert!(matches!(
            next_name(&state, "param_", Some("param_c"), 7, &mut work),
            Ok(None)
        ));
        assert!(next_name(&state, "param_", None, 6, &mut work).is_err());
    }
}
