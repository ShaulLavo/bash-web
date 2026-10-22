//! Original HOME-only word-prefix expansion over the parser's existing quote flags.
use super::{Expansion, ExpansionOptions, Protection, Work, expand, part_quoted};
use crate::{
    exec::Error,
    executor::Cancel,
    state::{SharedState, State},
};
use shell_parser::parser::{Word, WordPart};

pub(super) struct WordTildes<'a> {
    word: &'a Word,
    scalar: bool,
    has_part_quotes: bool,
    candidate: bool,
    assignment: Option<(usize, usize)>,
}

impl<'a> WordTildes<'a> {
    pub(super) async fn new(
        word: &'a Word,
        scalar: bool,
        assignment: bool,
        has_part_quotes: bool,
        expansion: &mut Expansion<'_>,
    ) -> Result<Self, Error> {
        // Words without an unquoted literal `~` take the ordinary literal
        // path and spend no tilde work.
        let candidate = word.parts.iter().enumerate().any(|(index, part)| {
            !part_quoted(word, index, has_part_quotes)
                && matches!(part, WordPart::Literal(text) if text.contains('~'))
        });
        let assignment = match (candidate, assignment) {
            (false, _) => None,
            (true, true) => Some((0, 0)),
            (true, false) => {
                assignment_start(word, has_part_quotes, expansion.work, expansion.cancel).await?
            }
        };
        Ok(Self {
            word,
            scalar,
            has_part_quotes,
            candidate,
            assignment,
        })
    }

    async fn literal_has_prefix(
        &self,
        value: &str,
        index: usize,
        expansion: &mut Expansion<'_>,
    ) -> Result<bool, Error> {
        for (offset, _) in value.match_indices('~') {
            expansion.work.checkpoint(expansion.cancel).await?;
            if self.prefix(value, index, offset) {
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn prefix(&self, value: &str, index: usize, offset: usize) -> bool {
        self.eligible(value, index, offset) && self.boundary(value, index, offset)
    }

    fn quoted(&self, index: usize) -> bool {
        part_quoted(self.word, index, self.has_part_quotes)
    }

    fn follows_colon(&self, value: &str, index: usize, offset: usize) -> bool {
        if offset > 0 {
            return value.as_bytes()[offset - 1] == b':';
        }
        let Some(previous) = index.checked_sub(1) else {
            return false;
        };
        !self.quoted(previous)
            && matches!(&self.word.parts[previous], WordPart::Literal(text) if text.ends_with(':'))
    }

    fn eligible(&self, value: &str, index: usize, offset: usize) -> bool {
        if (index, offset) == (0, 0) {
            return true;
        }
        let Some(start) = self.assignment else {
            return false;
        };
        (index, offset) == start
            || ((index, offset) > start && self.follows_colon(value, index, offset))
    }

    fn boundary(&self, value: &str, index: usize, offset: usize) -> bool {
        if let Some(&next) = value.as_bytes().get(offset + 1) {
            return matches!(next, b'/' | b':');
        }
        let Some(next) = self.word.parts.get(index + 1) else {
            return true;
        };
        !self.quoted(index + 1)
            && matches!(next, WordPart::Literal(text) if text.starts_with(['/', ':']))
    }

    pub(super) async fn literal(
        &self,
        expansion: &mut Expansion<'_>,
        index: usize,
        state: &SharedState,
    ) -> Result<(), Error> {
        let WordPart::Literal(value) = &self.word.parts[index] else {
            return Err(2.into());
        };
        let quoted = self.quoted(index);
        if quoted || !self.candidate || !self.literal_has_prefix(value, index, expansion).await? {
            return expansion.literal(value, state, self.scalar || quoted).await;
        }
        State::admit_scalar_access(state, "HOME", expansion.cancel, expansion.work).await?;
        let Some(home) = home_snapshot(expansion, state)? else {
            return expansion.literal(value, state, self.scalar).await;
        };
        let result = self
            .emit_literal(expansion, index, value, &home, state)
            .await;
        expansion.work.release_storage(home.len());
        result
    }

    async fn emit_literal(
        &self,
        expansion: &mut Expansion<'_>,
        index: usize,
        value: &str,
        home: &str,
        state: &SharedState,
    ) -> Result<(), Error> {
        let mut start = 0;
        for (offset, _) in value.match_indices('~') {
            expansion.work.checkpoint(expansion.cancel).await?;
            if !self.prefix(value, index, offset) {
                continue;
            }
            expansion
                .literal(&value[start..offset], state, self.scalar)
                .await?;
            expansion.segment(home, Protection::All, true).await?;
            start = offset + 1;
        }
        expansion.literal(&value[start..], state, self.scalar).await
    }
}

#[derive(Clone, Copy)]
enum Name {
    Start,
    Identifier,
    Append,
}

impl Name {
    fn next(self, byte: u8) -> Option<Self> {
        match (self, byte) {
            (Self::Start, b'a'..=b'z' | b'A'..=b'Z' | b'_')
            | (Self::Identifier, b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'_') => {
                Some(Self::Identifier)
            }
            (Self::Identifier, b'+') => Some(Self::Append),
            _ => None,
        }
    }
}

async fn assignment_start(
    word: &Word,
    has_part_quotes: bool,
    work: &mut Work,
    cancel: &Cancel,
) -> Result<Option<(usize, usize)>, Error> {
    let mut name = Name::Start;
    for (index, part) in word.parts.iter().enumerate() {
        work.checkpoint(cancel).await?;
        if part_quoted(word, index, has_part_quotes) {
            return Ok(None);
        }
        let WordPart::Literal(text) = part else {
            return Ok(None);
        };
        match name_end(text, name, work, cancel).await? {
            NameEnd::Equals(offset) => return Ok(Some((index, offset + 1))),
            NameEnd::Continue(next) => name = next,
            NameEnd::Invalid => return Ok(None),
        }
    }
    Ok(None)
}

enum NameEnd {
    Equals(usize),
    Continue(Name),
    Invalid,
}

async fn name_end(
    text: &str,
    mut name: Name,
    work: &mut Work,
    cancel: &Cancel,
) -> Result<NameEnd, Error> {
    for (offset, byte) in text.bytes().enumerate() {
        work.checkpoint(cancel).await?;
        if byte == b'=' && !matches!(name, Name::Start) {
            return Ok(NameEnd::Equals(offset));
        }
        let Some(next) = name.next(byte) else {
            return Ok(NameEnd::Invalid);
        };
        name = next;
    }
    Ok(NameEnd::Continue(name))
}

fn home_snapshot(
    expansion: &mut Expansion<'_>,
    state: &SharedState,
) -> Result<Option<String>, Error> {
    let state = state.borrow();
    let Some(value) = state.scalar_parameter("HOME") else {
        return Ok(None);
    };
    if value.len() > expansion.snapshot_max() {
        return Err(2.into());
    }
    expansion.work.admit_storage(value.len())?;
    Ok(Some(value.to_owned()))
}

pub(crate) async fn assignment(
    word: &Word,
    state: &SharedState,
    cancel: &Cancel,
    max: usize,
    max_raw: usize,
    work: &mut Work,
) -> Result<String, Error> {
    let values = expand(
        word,
        state,
        cancel,
        ExpansionOptions {
            max_bytes: max,
            max_fields: 1,
            max_raw,
            scalar: true,
            admitted: false,
            tilde_assignment: true,
        },
        work,
    )
    .await?;
    Ok(values.into_iter().next().unwrap_or_default())
}
