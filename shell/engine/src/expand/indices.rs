use super::{Error, Work};
use crate::state::State;

pub(super) fn count(state: &State, name: &str) -> usize {
    if name == "PIPESTATUS" {
        return state.pipeline_status().len();
    }
    state.array_count(name)
}

pub(super) fn value(
    state: &State,
    name: &str,
    ordinal: usize,
    previous: &mut Option<i64>,
    max: usize,
    work: &mut Work,
) -> Result<String, Error> {
    let index = if name == "PIPESTATUS" {
        i64::try_from(ordinal).map_err(|_| Error::Status(2))?
    } else {
        let (index, _) = state.array_next(name, *previous).ok_or(2)?;
        *previous = Some(index);
        index
    };
    let bytes = index.checked_ilog10().unwrap_or(0) as usize + 1;
    if bytes > max {
        return Err(2.into());
    }
    work.admit_storage(20)?;
    Ok(index.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{executor::Cancel, state::SharedState};
    use futures::FutureExt;

    fn scalar_state() -> SharedState {
        let mut state = State::default();
        state
            .assign_parameter("a".into(), "x".repeat(128 * 1024))
            .unwrap();
        state.shared()
    }

    #[test]
    fn index_names_never_copy_scalar_payloads() {
        let state = scalar_state();
        let mut work = Work::new(128, 20, 1);
        let mut previous = None;
        assert_eq!(
            value(&state.borrow(), "a", 0, &mut previous, 1, &mut work)
                .unwrap_or_else(|_| panic!("one key must fit")),
            "0"
        );
        assert_eq!(work.storage_remaining, 0);
        assert_eq!(previous, Some(0));
    }

    #[test]
    fn index_names_reject_unadmitted_decimal_storage() {
        let state = scalar_state();
        for (storage, raw) in [(19, 1), (20, 0)] {
            let mut work = Work::new(128, storage, 1);
            assert!(matches!(
                value(&state.borrow(), "a", 0, &mut None, raw, &mut work),
                Err(Error::Status(2))
            ));
            assert_eq!(work.storage_remaining, storage);
        }
    }

    #[test]
    fn index_names_honor_all_expansion_budgets_and_cancellation() {
        let state = scalar_state();
        let word = shell_parser::Parser::parse_word_string("${!a[@]}");
        let cancel = Cancel::new();
        for (steps, storage, fields, raw) in [
            (0, 65536, 8, 64),
            (1024, 0, 8, 64),
            (1024, 65536, 0, 64),
            (1024, 65536, 8, 0),
        ] {
            let mut work = Work::new(steps, storage, fields);
            let result = super::super::fields(
                &word,
                &state,
                &cancel,
                super::super::FieldContext::ForList,
                (64, fields, raw),
                &mut work,
            )
            .now_or_never()
            .unwrap();
            assert!(matches!(result, Err(Error::Status(2))));
        }
        let mut work = Work::new(1024, 65536, 8);
        let result = super::super::fields(
            &word,
            &state,
            &cancel,
            super::super::FieldContext::ForList,
            (64, 8, 64),
            &mut work,
        )
        .now_or_never()
        .unwrap()
        .unwrap_or_else(|_| panic!("admitted key must expand"));
        assert_eq!(result, ["0"]);
        cancel.cancel();
        let result = super::super::fields(
            &word,
            &state,
            &cancel,
            super::super::FieldContext::ForList,
            (64, 8, 64),
            &mut work,
        )
        .now_or_never()
        .unwrap();
        assert!(matches!(result, Err(Error::Status(130))));
    }
}
