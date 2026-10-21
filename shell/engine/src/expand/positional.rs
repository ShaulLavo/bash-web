use super::{Error, Expansion, Protection};
use crate::{arithmetic, state::SharedState};

impl Expansion<'_> {
    pub(super) async fn indexed_element(
        &mut self,
        name: &str,
        index: &str,
        state: &SharedState,
        protected: bool,
    ) -> Result<(), Error> {
        let index = self.indexed_index(name, index, state).await?;
        let value = {
            let state = state.borrow();
            let value = state.array_element(name, index);
            if value.is_none() && state.nounset {
                self.work.admit_storage(name.len().saturating_add(128))?;
                return Err(Error::Unbound {
                    name: format!("{name}[{index}]"),
                    line: None,
                });
            }
            let value = value.unwrap_or("");
            if value.len() > self.raw_remaining {
                return Err(2.into());
            }
            self.work.admit_storage(value.len())?;
            value.to_owned()
        };
        self.segment(&value, Protection::expansion(protected, state), protected)
            .await
    }

    pub(super) async fn indexed_length(
        &mut self,
        name: &str,
        index: &str,
        state: &SharedState,
        protected: bool,
    ) -> Result<(), Error> {
        if matches!(index, "@" | "*") {
            crate::state::State::admit_scalar_access(state, name, self.cancel, self.work).await?;
            self.indexed_require_bound(name, None, state)?;
            let count = if name == "PIPESTATUS" {
                state.borrow().pipeline_status().len()
            } else {
                state.borrow().array_count(name)
            };
            self.work.admit_storage(20)?;
            return self
                .segment(
                    &count.to_string(),
                    Protection::expansion(protected, state),
                    protected,
                )
                .await;
        }
        let index = self.indexed_index(name, index, state).await?;
        self.indexed_require_bound(name, Some(index), state)?;
        let (value, utf8) = {
            let state = state.borrow();
            let value = state.array_element(name, index).unwrap_or("");
            if value.len() > self.raw_remaining {
                return Err(2.into());
            }
            self.work.admit_storage(value.len())?;
            let utf8 = ["LC_ALL", "LC_CTYPE", "LANG"]
                .iter()
                .filter_map(|name| state.scalar_parameter(name))
                .find(|value| !value.is_empty())
                .is_some_and(super::utf8_locale);
            (value.to_owned(), utf8)
        };
        let count = self.character_count(&value, utf8).await?;
        self.work.admit_storage(20)?;
        self.segment(
            &count.to_string(),
            Protection::expansion(protected, state),
            protected,
        )
        .await
    }

    async fn indexed_index(
        &mut self,
        name: &str,
        index: &str,
        state: &SharedState,
    ) -> Result<i64, Error> {
        crate::state::State::admit_scalar_access(state, name, self.cancel, self.work).await?;
        let index =
            arithmetic::evaluate(index, state, self.cancel, self.raw_remaining, self.work).await?;
        self.ifs = None;
        self.ifs_changed = true;
        Ok(index)
    }

    fn indexed_require_bound(
        &mut self,
        name: &str,
        index: Option<i64>,
        state: &SharedState,
    ) -> Result<(), Error> {
        let state = state.borrow();
        let present = matches!(state.binding(name), Some(crate::state::Binding::Indexed(_)))
            || index.map_or_else(
                || state.binding(name).is_some(),
                |index| state.array_element(name, index).is_some(),
            );
        if present || !state.nounset || name == "PIPESTATUS" {
            return Ok(());
        }
        self.work.admit_storage(name.len().saturating_add(128))?;
        let name = index.map_or_else(|| name.to_owned(), |index| format!("{name}[{index}]"));
        Err(Error::Unbound { name, line: None })
    }

    pub(super) async fn positional_substring(
        &mut self,
        offset: &str,
        length: Option<&str>,
        state: &SharedState,
        quoted: bool,
        scalar: bool,
    ) -> Result<(), Error> {
        self.slice_boundaries(offset).await?;
        if let Some(length) = length {
            self.slice_boundaries(length).await?;
        }
        let count = state.borrow().positional().len().checked_add(1).ok_or(2)?;
        let offset =
            arithmetic::evaluate(offset, state, self.cancel, self.raw_remaining, self.work).await?;
        self.ifs = None;
        self.ifs_changed = true;
        let Some(start) = slice_start(offset, count) else {
            return Ok(());
        };
        let end = self
            .positional_slice_end(start, count, length, state)
            .await?;
        self.ifs = None;
        self.ifs_changed = true;
        if end - start > self.elements_remaining {
            return Err(2.into());
        }
        self.elements_remaining -= end - start;
        let list = !scalar;
        self.segments.needs_split |= list;
        self.segments.list_word |= list;
        if scalar {
            self.segments.empty(self.work)?;
        }
        let separator = if scalar {
            Some(' ')
        } else {
            self.ifs_separator(state).await?.or(Some(' '))
        };
        let protection = Protection::expansion(quoted || scalar, state);
        for index in start..end {
            self.element_boundary(index - start, list, separator, quoted || scalar)
                .await?;
            let value = self.positional_slice_value(index, state)?;
            self.segment(&value, protection, quoted || scalar).await?;
        }
        Ok(())
    }

    async fn positional_slice_end(
        &mut self,
        start: usize,
        count: usize,
        length: Option<&str>,
        state: &SharedState,
    ) -> Result<usize, Error> {
        let Some(length) = length else {
            return Ok(count);
        };
        let length =
            arithmetic::evaluate(length, state, self.cancel, self.raw_remaining, self.work).await?;
        if length < 0 {
            return crate::exec::fault("substring expression < 0", self.work);
        }
        Ok(start
            .saturating_add(usize::try_from(length).unwrap_or(usize::MAX))
            .min(count))
    }

    fn positional_slice_value(
        &mut self,
        index: usize,
        state: &SharedState,
    ) -> Result<String, Error> {
        let state = state.borrow();
        let value = if index == 0 {
            &state.shell_name
        } else {
            &state.positional()[index - 1]
        };
        if value.len() > self.raw_remaining {
            return Err(2.into());
        }
        self.work.admit_storage(value.len())?;
        Ok(value.clone())
    }
}

fn slice_start(offset: i64, count: usize) -> Option<usize> {
    if offset < 0 {
        return count.checked_sub(usize::try_from(offset.unsigned_abs()).ok()?);
    }
    usize::try_from(offset)
        .ok()
        .filter(|&offset| offset <= count)
}
