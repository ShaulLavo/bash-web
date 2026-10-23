//! Associative subscripts are scalar shell words, never arithmetic expressions.
use super::{Error, Work};
use crate::{executor::Cancel, parse, state::SharedState};

pub(crate) async fn scalar_word(
    source: &str,
    subscript: bool,
    state: &SharedState,
    cancel: &Cancel,
    limit: usize,
    work: &mut Work,
) -> Result<String, Error> {
    if source.len() > limit {
        return Err(2.into());
    }
    let before = work.storage_left();
    super::admit_generated_word(source, cancel, work).await?;
    let temporary = before - work.storage_left();
    let word = parse::scalar_word(source, subscript).map_err(|_| Error::Status(2))?;
    let result = super::word(&word, state, cancel, limit, limit, work).await;
    drop(word);
    work.release_storage(temporary);
    result
}

pub(crate) async fn subscript(
    source: &str,
    state: &SharedState,
    cancel: &Cancel,
    limit: usize,
    work: &mut Work,
) -> Result<String, Error> {
    scalar_word(source, true, state, cancel, limit, work).await
}

impl super::Expansion<'_> {
    pub(super) fn associative_value<'a>(
        &'a mut self,
        name: &'a str,
        index: &'a str,
        state: &'a SharedState,
        length: bool,
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
            if key.is_empty() {
                return expansion.empty_associative_key(name, index, length).await;
            }
            let state = state.borrow();
            let value = state.associative_element(name, &key);
            if value.is_none() && state.nounset && !length {
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
    async fn empty_associative_key(
        &mut self,
        name: &str,
        index: &str,
        length: bool,
    ) -> Result<String, Error> {
        self.work
            .admit_storage(name.len().saturating_add(index.len()).saturating_add(128))?;
        if length {
            return Err(Error::BadArraySubscript {
                name: format!("[{index}]"),
                line: None,
            });
        }
        if let Some(runner) = self.work.substitutions.clone() {
            let diagnostic = match self.work.line {
                Some(line) => format!("/usr/bin/bash: line {line}: {name}: bad array subscript\n"),
                None => format!("/usr/bin/bash: {name}: bad array subscript\n"),
            };
            runner.diagnose(&[&diagnostic]).await?;
        }
        Ok(String::new())
    }
}
