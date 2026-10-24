//! Split -W at unquoted IFS before brace, parameter and command expansion.
use crate::{
    exec::{Error, RESOURCE_STATUS},
    executor::Cancel,
    expand::{self, Ifs, Work},
    state::SharedState,
};

use shell_parser::parser::{CommandBoundaryScanner, CommandBoundaryStep};

#[derive(Clone, Copy, Default)]
struct Frame {
    end: char,
    quote: Option<char>,
}
struct Scanner {
    frames: [Frame; 64],
    depth: usize,
    escaped: bool,
    dollar: bool,
    command: Option<CommandBoundaryScanner>,
}
impl Scanner {
    fn new() -> Self {
        Self {
            frames: [Frame::default(); 64],
            depth: 0,
            escaped: false,
            dollar: false,
            command: None,
        }
    }
    fn quote(&self) -> Option<char> {
        self.frames[self.depth].quote
    }
    fn separator(&self, ch: char, ifs: &Ifs) -> bool {
        self.command.is_none()
            && self.depth == 0
            && self.quote().is_none()
            && !self.escaped
            && ifs.contains(ch)
    }
    fn push(&mut self, end: char) -> Result<(), Error> {
        self.depth += 1;
        if self.depth >= self.frames.len() {
            return Err(RESOURCE_STATUS.into());
        }
        self.frames[self.depth] = Frame { end, quote: None };
        Ok(())
    }
    /// Return whether this character needs lexer protection in a word context.
    fn character(&mut self, ch: char, work: &mut Work) -> Result<bool, Error> {
        if let Some(command) = &mut self.command {
            let structural = ch.is_whitespace() || matches!(ch, '$' | '(' | ')' | '<' | '>');
            work.admit_storage(16 + usize::from(structural) * 512)?;
            if command.feed(ch) == CommandBoundaryStep::Close {
                self.command = None;
            }
            return Ok(false);
        }
        if self.escaped {
            self.escaped = false;
            self.dollar = false;
            return Ok(false);
        }
        if ch == '\\' && self.quote() != Some('\'') {
            self.escaped = true;
            self.dollar = false;
            return Ok(false);
        }
        if self.quote() == Some('\'') {
            if ch == '\'' {
                self.frames[self.depth].quote = None;
            }
            return Ok(false);
        }
        if self.dollar && matches!(ch, '(' | '{') {
            self.dollar = false;
            if ch == '{' {
                self.push('}')?;
                return Ok(false);
            }
            work.admit_storage(std::mem::size_of::<CommandBoundaryScanner>() + 512)?;
            self.command = Some(CommandBoundaryScanner::new());
            return Ok(false);
        }
        self.dollar = ch == '$';
        if self.quote() == Some('"') {
            if ch == '"' {
                self.frames[self.depth].quote = None;
            }
            return Ok(false);
        }
        if self.quote() == Some('`') {
            if ch == '`' {
                self.frames[self.depth].quote = None;
            }
            return Ok(false);
        }
        if matches!(ch, '\'' | '"' | '`') {
            self.frames[self.depth].quote = Some(ch);
            return Ok(false);
        }
        if self.depth != 0 {
            self.nested(ch)?;
            return Ok(false);
        }
        Ok(matches!(
            ch,
            ' ' | '\t' | '\n' | ';' | '|' | '&' | '(' | ')' | '<' | '>'
        ))
    }
    fn nested(&mut self, ch: char) -> Result<(), Error> {
        if ch == self.frames[self.depth].end {
            self.depth -= 1;
            return Ok(());
        }
        if matches!(ch, '(' | '{') {
            self.push(if ch == '(' { ')' } else { '}' })?;
        }
        Ok(())
    }
}
struct Slice<'a> {
    raw: &'a str,
    final_quote: Option<char>,
}
async fn split<'a>(
    source: &'a str,
    ifs: &Ifs,
    work: &mut Work,
    cancel: &Cancel,
) -> Result<Vec<Slice<'a>>, Error> {
    let mut words = Vec::new();
    let mut start = 0;
    let mut scan = Scanner::new();
    for (index, ch) in source.char_indices() {
        work.checkpoint(cancel).await?;
        if !scan.separator(ch, ifs) {
            scan.character(ch, work)?;
            continue;
        }
        if start != index {
            push(
                &mut words,
                Slice {
                    raw: &source[start..index],
                    final_quote: None,
                },
                work,
            )?;
        }
        start = index + ch.len_utf8();
        scan = Scanner::new();
    }
    if start != source.len() {
        push(
            &mut words,
            Slice {
                raw: &source[start..],
                final_quote: scan.quote(),
            },
            work,
        )?;
    }
    Ok(words)
}
fn push<T>(values: &mut Vec<T>, value: T, work: &mut Work) -> Result<(), Error> {
    if values.len() == values.capacity() {
        let growth = values.capacity().max(1);
        work.admit_storage(growth.saturating_mul(std::mem::size_of::<T>()))?;
        let requested = values.capacity() + growth;
        values
            .try_reserve_exact(growth)
            .map_err(|_| Error::Status(RESOURCE_STATUS))?;
        work.admit_storage((values.capacity() - requested) * std::mem::size_of::<T>())?;
    }
    values.push(value);
    Ok(())
}
async fn spelling(word: &Slice<'_>, work: &mut Work, cancel: &Cancel) -> Result<String, Error> {
    let capacity = word.raw.len().saturating_mul(2).saturating_add(2);
    work.admit_storage(capacity)?;
    let mut text = String::with_capacity(capacity);
    let mut scan = Scanner::new();
    for ch in word.raw.chars() {
        work.checkpoint(cancel).await?;
        // Completion reparses quotes, but not the ANSI-C/localized dollar prefix.
        // Command bodies remain shell source and retain their normal quoting.
        if scan.command.is_none()
            && scan.quote() != Some('`')
            && scan.dollar
            && matches!(ch, '\'' | '"')
        {
            text.pop();
            text.push_str("\\$");
        }
        if scan.character(ch, work)? {
            text.push('\\');
        }
        text.push(ch);
    }
    // Bash accepts an unfinished final quote, and drops an unfinished escape.
    if scan.escaped {
        text.pop();
    }
    if let Some(quote) = word.final_quote {
        text.push(quote);
    }
    Ok(text)
}
pub(super) async fn expand(
    source: &str,
    state: &SharedState,
    limits: (usize, usize),
    work: &mut Work,
    cancel: &Cancel,
) -> Result<Vec<String>, Error> {
    let ifs = Ifs::new(state, cancel, limits.0, work).await?;
    let words = split(source, &ifs, work, cancel).await?;
    let mut values = Vec::new();
    let mut bytes = 0usize;
    for raw in words {
        let spelling = spelling(&raw, work, cancel).await?;
        work.admit_parse(spelling.len(), cancel).await?;
        let syntax = spelling.chars().filter(|ch| !ch.is_alphanumeric()).count();
        let slot = std::mem::size_of::<shell_parser::parser::WordPart>()
            + std::mem::size_of::<shell_parser::parser::Word>()
            + std::mem::size_of::<shell_parser::parser::Command>();
        work.admit_storage(
            spelling
                .len()
                .saturating_mul(128)
                .saturating_add(syntax.saturating_mul(4).saturating_mul(slot))
                .saturating_add(512),
        )?;
        let word = crate::parse::generated_word(&spelling).map_err(|_| Error::Status(1))?;
        let max_bytes = limits.0.saturating_sub(bytes);
        let expanded = expand::fields(
            &word,
            state,
            cancel,
            expand::FieldContext::Completion,
            (max_bytes, limits.1.saturating_sub(values.len()), max_bytes),
            work,
        )
        .await?;
        for value in expanded {
            bytes = bytes.checked_add(value.len()).ok_or(RESOURCE_STATUS)?;
            push(&mut values, value, work)?;
        }
    }
    Ok(values)
}
