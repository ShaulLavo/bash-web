use super::{Error, Expansion, ListSource, Protection};
use crate::state::{SharedState, State};

impl Expansion<'_> {
    pub(super) async fn array_substring(
        &mut self,
        name: &str,
        at: bool,
        bounds: (&str, Option<&str>),
        state: &SharedState,
        quoted: bool,
        scalar: bool,
    ) -> Result<(), Error> {
        State::admit_scalar_access(state, name, self.cancel, self.work).await?;
        let is_scalar = state.borrow().array_is_scalar(name);
        if is_scalar {
            let null_field = at && quoted && !scalar;
            return self
                .substring(name, bounds, state, scalar || quoted, null_field)
                .await;
        }
        self.slice_boundaries(bounds.0).await?;
        if let Some(length) = bounds.1 {
            self.slice_boundaries(length).await?;
        }
        let range = self.array_slice_range(name, bounds, state).await?;
        let (list, separator) = self
            .element_layout(ListSource::Array, at, state, quoted, scalar)
            .await?;
        let Some((start, count)) = range else {
            return Ok(());
        };
        let mut previous = start.checked_sub(1);
        let protection = Protection::expansion(quoted || scalar, state);
        for index in 0..count {
            self.work.checkpoint(self.cancel).await?;
            let Some((next, value)) = self.array_slice_next(name, previous, state)? else {
                break;
            };
            self.admit_element()?;
            self.element_boundary(index, list, separator, quoted || scalar)
                .await?;
            self.segment(&value, protection, quoted || scalar).await?;
            previous = Some(next);
        }
        Ok(())
    }

    async fn array_slice_range(
        &mut self,
        name: &str,
        (offset, length): (&str, Option<&str>),
        state: &SharedState,
    ) -> Result<Option<(i64, usize)>, Error> {
        // Empty or unset arrays skip both expressions. Otherwise the bounds
        // read the array as the offset arithmetic left it, and the element
        // walk below stops at the live end rather than a stale count.
        if state.borrow().array_last_index(name).is_none() {
            return Ok(None);
        }
        let offset =
            crate::arithmetic::evaluate(offset, state, self.cancel, self.raw_remaining, self.work)
                .await?;
        self.ifs = None;
        self.ifs_changed = true;
        let Some(start) = state
            .borrow()
            .array_last_index(name)
            .and_then(|last| slice_start(offset, last))
        else {
            return Ok(None);
        };
        let Some(length) = length else {
            return Ok(Some((start, usize::MAX)));
        };
        let length =
            crate::arithmetic::evaluate(length, state, self.cancel, self.raw_remaining, self.work)
                .await?;
        self.ifs = None;
        self.ifs_changed = true;
        if length < 0 {
            return crate::exec::fault("substring expression < 0", self.work);
        }
        Ok(Some((start, usize::try_from(length).unwrap_or(usize::MAX))))
    }

    fn array_slice_next(
        &mut self,
        name: &str,
        previous: Option<i64>,
        state: &SharedState,
    ) -> Result<Option<(i64, String)>, Error> {
        let state = state.borrow();
        if name == "PIPESTATUS" {
            let next = previous.map_or(Some(0), |index| index.checked_add(1));
            let Some(next) = next.and_then(|n| usize::try_from(n).ok()) else {
                return Ok(None);
            };
            let Some(value) = state.pipeline_status().get(next) else {
                return Ok(None);
            };
            self.work.admit_storage(20)?;
            return Ok(Some((
                i64::try_from(next).map_err(|_| 2)?,
                value.to_string(),
            )));
        }
        let Some((index, value)) = state.array_next(name, previous) else {
            return Ok(None);
        };
        if value.len() > self.raw_remaining {
            return Err(2.into());
        }
        self.work.admit_storage(value.len())?;
        Ok(Some((index, value.to_owned())))
    }
}

fn slice_start(offset: i64, last: i64) -> Option<i64> {
    if offset < 0 {
        // Bash rejects negative slices when the exclusive upper bound overflows.
        return last.checked_add(1)?.checked_add(offset).filter(|&n| n >= 0);
    }
    (offset <= last).then_some(offset)
}
