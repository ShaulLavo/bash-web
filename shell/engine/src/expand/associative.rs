//! Associative subscripts are shell words, never arithmetic expressions.
use super::{Error, Work};
use crate::{executor::Cancel, parse, state::SharedState};

pub(crate) async fn subscript(
    source: &str,
    state: &SharedState,
    cancel: &Cancel,
    limit: usize,
    work: &mut Work,
) -> Result<String, Error> {
    if source.len() > limit {
        return Err(2.into());
    }
    super::admit_generated_word(source, cancel, work).await?;
    let word = parse::generated_word(source).map_err(|_| Error::Status(2))?;
    let key = super::word(&word, state, cancel, limit, limit, work).await?;
    if key.is_empty() {
        work.admit_storage(source.len().saturating_add(128))?;
        return Err(Error::BadArraySubscript {
            name: source.to_owned(),
            line: None,
        });
    }
    Ok(key)
}

impl super::Expansion<'_> {
    pub(super) fn associative_value<'a>(
        &'a mut self,
        name: &'a str,
        index: &'a str,
        state: &'a SharedState,
    ) -> crate::exec::ResultFuture<'a, String> {
        self.part_frame(|expansion| async move {
            crate::state::State::admit_scalar_access(state, name, expansion.cancel, expansion.work)
                .await?;
            let key = subscript(
                index,
                state,
                expansion.cancel,
                expansion.raw_remaining,
                expansion.work,
            )
            .await?;
            expansion.ifs = None;
            expansion.ifs_changed = true;
            let state = state.borrow();
            let value = state.associative_element(name, &key);
            if value.is_none() && state.nounset {
                expansion
                    .work
                    .admit_storage(name.len().saturating_add(index.len()).saturating_add(128))?;
                return Err(Error::Unbound {
                    name: format!("{name}[{index}]"),
                    line: None,
                });
            }
            expansion.array_snapshot(value)
        })
    }
}
