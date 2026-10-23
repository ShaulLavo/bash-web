//! Prefix-name enumeration reads binding keys, never their values or targets.
use super::{Error, Expansion, Protection, Work};
use crate::state::SharedState;
use std::ops::Bound::{Excluded, Included, Unbounded};

impl Expansion<'_> {
    pub(super) async fn prefix_names(
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
    let Some((name, _)) = state.bindings().range::<str, _>((lower, Unbounded)).next() else {
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
    use crate::{executor::Cancel, state::State};
    use futures::FutureExt;

    #[test]
    fn names_never_copy_payloads() {
        let mut state = State::default();
        state
            .assign_parameter("param_b".into(), "x".repeat(128 * 1024))
            .unwrap();
        state.assign_parameter("param_a".into(), "".into()).unwrap();
        let state = state.shared();
        let mut work = Work::new(16, 7, 1);
        assert_eq!(
            next_name(&state, "param_", None, 7, &mut work).unwrap(),
            Some("param_a".into())
        );
        assert_eq!(work.storage_remaining, 0);
        let mut work = Work::new(16, 7, 1);
        assert_eq!(
            next_name(&state, "param_", Some("param_a"), 7, &mut work).unwrap(),
            Some("param_b".into())
        );
        assert_eq!(
            next_name(&state, "param_", Some("param_b"), 7, &mut work).unwrap(),
            None
        );
        assert!(next_name(&state, "param_", None, 6, &mut work).is_err());
    }

    #[test]
    fn prefix_names_honor_work_storage_fields_raw_and_cancellation() {
        let mut state = State::default();
        state
            .assign_parameter("param_a".into(), "value".into())
            .unwrap();
        let state = state.shared();
        let word = shell_parser::Parser::parse_word_string("${!param_@}");
        let cancel = Cancel::new();
        for (steps, storage, fields, raw) in [
            (0, 65536, 8, 64),
            (4096, 0, 8, 64),
            (4096, 65536, 0, 64),
            (4096, 65536, 8, 0),
        ] {
            let mut work = Work::new(steps, storage, fields);
            let result =
                super::super::fields_admitted(&word, &state, &cancel, 64, fields, raw, &mut work)
                    .now_or_never()
                    .unwrap();
            assert!(matches!(result, Err(Error::Status(2))));
        }
        let mut work = Work::new(4096, 65536, 8);
        let result = super::super::fields_admitted(&word, &state, &cancel, 64, 8, 64, &mut work)
            .now_or_never()
            .unwrap()
            .unwrap();
        assert_eq!(result, ["param_a"]);
        cancel.cancel();
        let result = super::super::fields_admitted(&word, &state, &cancel, 64, 8, 64, &mut work)
            .now_or_never()
            .unwrap();
        assert!(matches!(result, Err(Error::Status(130))));
    }
}
