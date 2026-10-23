//! Scalar trim rules adapted from Bashkit expansion.rs::remove_pattern{,_glob}
//! and glob.rs::glob_match_steps at the pinned revision in sources.lock.json.
//! This matcher advances all basic-glob states over borrowed character slices.
//! It allocates no candidate strings and never treats exhausted work as a miss.
use super::{Error, Protection, Work, admit_string_growth, admit_vec_slot};
use crate::executor::Cancel;
use std::mem::size_of;

pub(crate) mod classes;
mod extglob;

#[derive(Clone, Copy)]
struct Character {
    value: char,
    protected: bool,
    escaped_protected: bool,
    /// Backslashes in Bash's literal spelling of a malformed group suffix.
    literal_prefix: u8,
}

#[derive(Default)]
pub(crate) struct Pattern {
    chars: Vec<Character>,
    extglob: bool,
    classes: Option<Result<crate::state::CaseLocale, i32>>,
    quoted_empty: bool,
    /// Case matching selects the first field from a quoted multi-value `$@`.
    /// Continue evaluating the remaining source, but discard its emitted text.
    first_field_complete: bool,
    /// `[[ ]]` scalar patterns join quoted `$@` instead of selecting one field.
    pub(super) join_positionals: bool,
}
impl Pattern {
    /// Already-expanded pattern text, without another parameter expansion pass.
    pub(crate) async fn literal(
        text: &str,
        state: &crate::state::SharedState,
        work: &mut Work,
        cancel: &Cancel,
    ) -> Result<Self, Error> {
        let mut pattern = Self::with_options(false, state.borrow().extglob);
        pattern.classes = Some(crate::state::CaseLocale::from_state(&state.borrow()).map_err(|_| 2));
        for ch in text.chars() {
            work.checkpoint(cancel).await?;
            pattern.push(ch, Protection::None, work)?;
        }
        Ok(pattern)
    }

    /// Borrow quote-aware source without glob normalization; ERE escaping has
    /// different rules and must not change the shared shell expansion result.
    pub(crate) fn regex_character(&self, index: usize) -> Option<(char, bool)> {
        self.chars.get(index).map(|ch| (ch.value, ch.protected))
    }

    pub(super) fn with_options(join_positionals: bool, extglob: bool) -> Self {
        Self {
            join_positionals,
            extglob,
            ..Self::default()
        }
    }

    pub(super) fn finish_first_field(&mut self) {
        self.first_field_complete = true;
    }
    pub(super) fn keep_empty(&mut self) {
        self.quoted_empty = true;
    }
    pub(super) fn push(
        &mut self,
        value: char,
        protection: Protection,
        work: &mut Work,
    ) -> Result<(), Error> {
        if self.first_field_complete {
            return Ok(());
        }
        admit_vec_slot(&mut self.chars, work)?;
        self.chars.push(Character {
            value,
            protected: protection.protects(value),
            escaped_protected: false,
            literal_prefix: u8::from(
                protection.protects(value)
                    && matches!(
                        value,
                        '!' | '#'
                            | '%'
                            | '('
                            | ')'
                            | '*'
                            | '-'
                            | '.'
                            | ':'
                            | '='
                            | '?'
                            | '['
                            | '\\'
                            | ']'
                            | '^'
                            | '|'
                    ),
            ),
        });
        Ok(())
    }
    fn active(&self, index: usize, value: char) -> bool {
        self.chars
            .get(index)
            .is_some_and(|ch| ch.value == value && !ch.protected)
    }
    async fn normalize(&mut self, work: &mut Work, cancel: &Cancel) -> Result<(), Error> {
        // Backslashes introduced by an unquoted variable are pattern escapes.
        // Source escapes have already been removed and structurally protected.
        // Keep the escaped-protected marker once observed: scalar pattern
        // operations may compile the same Pattern more than once.
        let mut read = 0;
        let mut write = 0;
        while read < self.chars.len() {
            work.checkpoint(cancel).await?;
            let escape = self.active(read, '\\') && read + 1 < self.chars.len();
            read += usize::from(escape);
            let mut ch = self.chars[read];
            ch.escaped_protected |= escape && ch.protected;
            ch.protected |= escape;
            self.chars[write] = ch;
            read += 1;
            write += 1;
        }
        self.chars.truncate(write);
        Ok(())
    }
    /// An expansion-provided backslash escapes the synthetic quote marker on
    /// quoted glob punctuation. Full extglob patterns also escape group
    /// delimiters and '!'. Scalar trim/replacement keep their separate
    /// escaped-protected rule; pathname matching keeps only basic punctuation.
    async fn normalize_pathname(&mut self, work: &mut Work, cancel: &Cancel) -> Result<(), Error> {
        self.normalize_glob(false, work, cancel).await
    }
    async fn normalize_glob(
        &mut self,
        extended: bool,
        work: &mut Work,
        cancel: &Cancel,
    ) -> Result<(), Error> {
        let mut read = 0;
        let mut write = 0;
        while read < self.chars.len() {
            work.checkpoint(cancel).await?;
            let escape = self.active(read, '\\') && read + 1 < self.chars.len();
            if escape
                && self.chars[read + 1].protected
                && (matches!(self.chars[read + 1].value, '*' | '?' | '[' | ']' | '\\')
                    || extended && matches!(self.chars[read + 1].value, '(' | ')' | '|' | '!'))
            {
                self.chars[write] = Character {
                    value: '\\',
                    protected: true,
                    escaped_protected: false,
                    literal_prefix: self.chars[read + 1].literal_prefix,
                };
                self.chars[read + 1].protected = false;
                self.chars[read + 1].literal_prefix = 0;
                read += 1;
                write += 1;
                continue;
            }
            read += usize::from(escape);
            let mut ch = self.chars[read];
            ch.literal_prefix = ch.literal_prefix.checked_add(u8::from(escape)).ok_or(2)?;
            ch.protected |= escape;
            self.chars[write] = ch;
            read += 1;
            write += 1;
        }
        self.chars.truncate(write);
        Ok(())
    }
    async fn bracket(
        &self,
        start: usize,
        work: &mut Work,
        cancel: &Cancel,
    ) -> Result<Option<(Atom, usize)>, Error> {
        let negated = self.active(start, '!') || self.active(start, '^');
        let start = start + usize::from(negated);
        let mut end = start;
        // A leading ']' belongs to the class, including after negation.
        if self.active(end, ']') {
            end += 1;
        }
        while end < self.chars.len() {
            work.checkpoint(cancel).await?;
            if self.active(end, ']') {
                return Ok(Some((
                    Atom::Class {
                        start,
                        end,
                        negated,
                    },
                    end + 1,
                )));
            }
            if let Some((_, after)) = self.named_class(end, work, cancel).await? {
                end = after;
                continue;
            }
            if self.active(end, '[') && [':', '.', '='].iter().any(|&ch| self.active(end + 1, ch)) {
                return Err(2.into());
            }
            end += 1;
        }
        Ok(None)
    }
    async fn named_class(
        &self,
        start: usize,
        work: &mut Work,
        cancel: &Cancel,
    ) -> Result<Option<(Option<classes::Named>, usize)>, Error> {
        if self.classes.is_none() || !self.active(start, '[') || !self.active(start + 1, ':') {
            return Ok(None);
        }
        let mut name = [0u8; 6];
        let mut length = 0usize;
        let mut index = start + 2;
        while let Some(ch) = self.chars.get(index) {
            work.checkpoint(cancel).await?;
            if self.active(index, ':') && self.active(index + 1, ']') {
                let named = (length <= name.len())
                    .then(|| classes::Named::parse(&name[..length]))
                    .flatten();
                return Ok(Some((named, index + 2)));
            }
            if length < name.len() {
                name[length] = u8::try_from(ch.value)
                    .ok()
                    .filter(|_| ch.value.is_ascii() && !ch.protected)
                    .unwrap_or(0);
            }
            length += 1;
            index += 1;
        }
        Ok(None)
    }
    /// A pathname component has magic only after quote-boundary escapes have
    /// been resolved. Share normalization with matching rather than guessing
    /// from the unnormalized source bytes and their quote mask.
    pub(super) async fn has_pathname_magic(
        &mut self,
        work: &mut Work,
        cancel: &Cancel,
    ) -> Result<bool, Error> {
        self.normalize_pathname(work, cancel).await?;
        for index in 0..self.chars.len() {
            work.checkpoint(cancel).await?;
            if self.active(index, '*') || self.active(index, '?') {
                return Ok(true);
            }
            if self.active(index, '[') && self.bracket(index + 1, work, cancel).await?.is_some() {
                return Ok(true);
            }
        }
        Ok(false)
    }
    pub(super) async fn pathname_literal(
        &mut self,
        max_bytes: usize,
        work: &mut Work,
        cancel: &Cancel,
    ) -> Result<String, Error> {
        self.normalize_pathname(work, cancel).await?;
        work.admit_storage(max_bytes)?;
        let mut value = String::new();
        value
            .try_reserve_exact(max_bytes)
            .map_err(|_| Error::Status(2))?;
        for ch in &self.chars {
            work.checkpoint(cancel).await?;
            if ch.value.len_utf8() > max_bytes.saturating_sub(value.len()) {
                return Err(2.into());
            }
            value.push(ch.value);
        }
        Ok(value)
    }
    async fn compile(&mut self, work: &mut Work, cancel: &Cancel) -> Result<Vec<Atom>, Error> {
        self.normalize(work, cancel).await?;
        self.atoms(0, work, cancel).await
    }
    async fn compile_pathname(
        &mut self,
        work: &mut Work,
        cancel: &Cancel,
    ) -> Result<Vec<Atom>, Error> {
        self.normalize_pathname(work, cancel).await?;
        self.atoms(0, work, cancel).await
    }
    async fn atoms(
        &self,
        mut index: usize,
        work: &mut Work,
        cancel: &Cancel,
    ) -> Result<Vec<Atom>, Error> {
        let mut atoms = Vec::new();
        while index < self.chars.len() {
            work.checkpoint(cancel).await?;
            let (atom, next) = self.atom(index, work, cancel).await?;
            admit_vec_slot(&mut atoms, work)?;
            atoms.push(atom);
            index = next;
        }
        Ok(atoms)
    }
    pub(super) async fn replacement(
        mut self,
        global: bool,
        work: &mut Work,
        cancel: &Cancel,
    ) -> Result<Search, Error> {
        self.normalize(work, cancel).await?;
        let anchor = if !global && self.active(0, '#') {
            Anchor::Start
        } else if !global && self.active(0, '%') {
            Anchor::End
        } else {
            Anchor::None
        };
        let atoms = self
            .atoms(usize::from(anchor != Anchor::None), work, cancel)
            .await?;
        let count = atoms.len().checked_add(1).ok_or(2)?;
        work.admit_storage(count.checked_mul(size_of::<bool>()).ok_or(2)?)?;
        let mut states = Vec::new();
        states
            .try_reserve_exact(count)
            .map_err(|_| Error::Status(2))?;
        for _ in 0..count {
            work.checkpoint(cancel).await?;
            states.push(false);
        }
        Ok(Search {
            pattern: self,
            atoms,
            states,
            anchor,
        })
    }

    pub(crate) async fn matches_full(
        &mut self,
        value: &str,
        work: &mut Work,
        cancel: &Cancel,
    ) -> Result<bool, Error> {
        self.normalize_glob(self.extglob, work, cancel).await?;
        extglob::matches(self, value, work, cancel).await
    }

    /// Keep pathname expansion on the basic-glob compiler.
    pub(super) async fn matches_pathname(
        &mut self,
        value: &str,
        work: &mut Work,
        cancel: &Cancel,
    ) -> Result<bool, Error> {
        let atoms = self.compile_pathname(work, cancel).await?;
        let count = atoms.len().checked_add(1).ok_or(2)?;
        work.admit_storage(count)?;
        let mut states = Vec::new();
        states
            .try_reserve_exact(count)
            .map_err(|_| Error::Status(2))?;
        states.push(true);
        for atom in &atoms {
            work.checkpoint(cancel).await?;
            states.push(matches!(atom, Atom::Star) && *states.last().ok_or(2)?);
        }
        for ch in value.chars() {
            work.checkpoint(cancel).await?;
            self.advance(&atoms, &mut states, ch, work, cancel).await?;
        }
        Ok(states[atoms.len()])
    }
    async fn atom(
        &self,
        index: usize,
        work: &mut Work,
        cancel: &Cancel,
    ) -> Result<(Atom, usize), Error> {
        if self.group_operator(index).is_some() {
            return Err(2.into());
        }
        self.basic_atom(index, work, cancel).await
    }
    fn group_operator(&self, index: usize) -> Option<char> {
        let ch = self.chars[index];
        (!ch.protected
            && matches!(ch.value, '@' | '?' | '*' | '+' | '!')
            && self.active(index + 1, '('))
        .then_some(ch.value)
    }
    async fn basic_atom(
        &self,
        index: usize,
        work: &mut Work,
        cancel: &Cancel,
    ) -> Result<(Atom, usize), Error> {
        let ch = self.chars[index];
        if ch.escaped_protected {
            return Ok((Atom::Never, index + 1));
        }
        if ch.protected {
            return Ok((Atom::Literal(ch.value), index + 1));
        }
        if ch.value == '[' {
            if let Some(class) = self.bracket(index + 1, work, cancel).await? {
                return Ok(class);
            }
            return Ok((Atom::Literal('['), index + 1));
        }
        let atom = match ch.value {
            '*' => Atom::Star,
            '?' => Atom::Any,
            value => Atom::Literal(value),
        };
        Ok((atom, index + 1))
    }
    async fn matches(
        &self,
        atom: &Atom,
        value: char,
        work: &mut Work,
        cancel: &Cancel,
    ) -> Result<bool, Error> {
        match *atom {
            Atom::Literal(ch) => Ok(ch == value),
            Atom::Never => Ok(false),
            Atom::Any => Ok(true),
            Atom::Star => Err(2.into()),
            Atom::Class {
                start,
                end,
                negated,
            } => {
                self.class_matches(start, end, negated, value, work, cancel)
                    .await
            }
        }
    }
    async fn class_matches(
        &self,
        mut index: usize,
        end: usize,
        negated: bool,
        value: char,
        work: &mut Work,
        cancel: &Cancel,
    ) -> Result<bool, Error> {
        let mut matched = false;
        while index < end {
            work.checkpoint(cancel).await?;
            if let Some((named, after)) = self.named_class(index, work, cancel).await? {
                let locale = self.classes.ok_or(2)??;
                matched |= named.is_some_and(|class| class.matches(value, locale.utf8()));
                index = after;
                continue;
            }
            let first = self.chars[index].value;
            if index + 2 < end && self.active(index + 1, '-') {
                matched |= first <= value && value <= self.chars[index + 2].value;
                index += 3;
                continue;
            }
            matched |= first == value;
            index += 1;
        }
        Ok(matched != negated)
    }
    pub(super) async fn remove<'a>(
        &mut self,
        value: &'a str,
        prefix: bool,
        longest: bool,
        work: &mut Work,
        cancel: &Cancel,
    ) -> Result<&'a str, Error> {
        let mut atoms = self.compile(work, cancel).await?;
        // Reverse atoms, never the contents of bracket expressions.
        if !prefix {
            let count = atoms.len();
            for index in 0..count / 2 {
                work.checkpoint(cancel).await?;
                atoms.swap(index, count - index - 1);
            }
        }
        let mut states = Vec::new();
        work.admit_storage(atoms.len().saturating_add(1))?;
        states
            .try_reserve_exact(atoms.len().saturating_add(1))
            .map_err(|_| Error::Status(2))?;
        states.push(true);
        for atom in &atoms {
            work.checkpoint(cancel).await?;
            states.push(matches!(atom, Atom::Star) && *states.last().ok_or(2)?);
        }
        let mut matched = states[atoms.len()].then_some(if prefix { 0 } else { value.len() });
        if matched.is_some() && !longest {
            return Ok(value);
        }
        let mut characters = value.char_indices();
        loop {
            work.checkpoint(cancel).await?;
            let next = if prefix {
                characters.next()
            } else {
                characters.next_back()
            };
            let Some((index, ch)) = next else { break };
            self.advance(&atoms, &mut states, ch, work, cancel).await?;
            if !states[atoms.len()] {
                continue;
            }
            matched = Some(if prefix { index + ch.len_utf8() } else { index });
            if !longest {
                break;
            }
        }
        let boundary = matched.unwrap_or(if prefix { 0 } else { value.len() });
        Ok(if prefix {
            &value[boundary..]
        } else {
            &value[..boundary]
        })
    }
    pub(super) async fn change_case(
        &mut self,
        value: &str,
        mode: (bool, bool),
        locale: crate::state::CaseLocale,
        max_bytes: usize,
        work: &mut Work,
        cancel: &Cancel,
    ) -> Result<String, Error> {
        let (upper, all) = mode;
        if !locale.utf8() {
            self.require_ascii(work, cancel).await?;
        }
        let atoms = self.compile(work, cancel).await?;
        let mut states = Vec::new();
        let count = atoms.len().checked_add(1).ok_or(2)?;
        work.admit_storage(count)?;
        states
            .try_reserve_exact(count)
            .map_err(|_| Error::Status(2))?;
        for _ in 0..=atoms.len() {
            work.checkpoint(cancel).await?;
            states.push(false);
        }
        let mut result = String::new();
        for (index, ch) in value.chars().enumerate() {
            work.checkpoint(cancel).await?;
            let eligible = (all || index == 0) && (locale.utf8() || ch.is_ascii());
            let selected = eligible
                && self
                    .matches_character(&atoms, &mut states, ch, work, cancel)
                    .await?;
            let mapped = if selected { locale.map(ch, upper)? } else { ch };
            if mapped.len_utf8() > max_bytes.saturating_sub(result.len()) {
                return Err(2.into());
            }
            admit_string_growth(&mut result, mapped.len_utf8(), work)?;
            result.push(mapped);
        }
        Ok(result)
    }
    async fn require_ascii(&self, work: &mut Work, cancel: &Cancel) -> Result<(), Error> {
        for ch in &self.chars {
            work.checkpoint(cancel).await?;
            if !ch.value.is_ascii() {
                return Err(2.into());
            }
        }
        Ok(())
    }
    async fn matches_character(
        &self,
        atoms: &[Atom],
        states: &mut [bool],
        value: char,
        work: &mut Work,
        cancel: &Cancel,
    ) -> Result<bool, Error> {
        // Omitted and unquoted expanded-empty patterns default to '?'.
        // An explicitly quoted empty pattern matches no character.
        if atoms.is_empty() {
            return Ok(!self.quoted_empty);
        }
        states[0] = true;
        for (index, atom) in atoms.iter().enumerate() {
            work.checkpoint(cancel).await?;
            states[index + 1] = matches!(atom, Atom::Star) && states[index];
        }
        self.advance(atoms, states, value, work, cancel).await?;
        Ok(states[atoms.len()])
    }
    async fn advance(
        &self,
        atoms: &[Atom],
        states: &mut [bool],
        value: char,
        work: &mut Work,
        cancel: &Cancel,
    ) -> Result<bool, Error> {
        let mut previous = states[0];
        states[0] = false;
        let mut live = false;
        for (index, atom) in atoms.iter().enumerate() {
            work.checkpoint(cancel).await?;
            let old = states[index + 1];
            states[index + 1] = if matches!(atom, Atom::Star) {
                states[index] || old
            } else {
                previous && self.matches(atom, value, work, cancel).await?
            };
            previous = old;
            live |= states[index + 1];
        }
        Ok(live)
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Anchor {
    None,
    Start,
    End,
}

pub(super) struct Search {
    pattern: Pattern,
    atoms: Vec<Atom>,
    states: Vec<bool>,
    anchor: Anchor,
}
impl Search {
    pub(super) fn anchored(&self) -> bool {
        self.anchor != Anchor::None
    }
    pub(super) async fn find(
        &mut self,
        value: &str,
        mut start: usize,
        work: &mut Work,
        cancel: &Cancel,
    ) -> Result<Option<(usize, usize)>, Error> {
        if self.atoms.is_empty() && self.anchor == Anchor::None {
            return Ok(None);
        }
        loop {
            work.checkpoint(cancel).await?;
            if start == value.len() && !value.is_empty() && self.anchor != Anchor::End {
                return Ok(None);
            }
            if let Some(end) = self.longest(value, start, work, cancel).await? {
                return Ok(Some((start, end)));
            }
            if self.anchor == Anchor::Start || start == value.len() {
                return Ok(None);
            }
            start += value[start..].chars().next().ok_or(2)?.len_utf8();
        }
    }
    async fn longest(
        &mut self,
        value: &str,
        start: usize,
        work: &mut Work,
        cancel: &Cancel,
    ) -> Result<Option<usize>, Error> {
        self.states[0] = true;
        for (index, atom) in self.atoms.iter().enumerate() {
            work.checkpoint(cancel).await?;
            self.states[index + 1] = matches!(atom, Atom::Star) && self.states[index];
        }
        let mut matched = (self.states[self.atoms.len()]
            && (self.anchor != Anchor::End || start == value.len()))
        .then_some(start);
        for (offset, ch) in value[start..].char_indices() {
            work.checkpoint(cancel).await?;
            let live = self
                .pattern
                .advance(&self.atoms, &mut self.states, ch, work, cancel)
                .await?;
            let end = start + offset + ch.len_utf8();
            if self.states[self.atoms.len()] && (self.anchor != Anchor::End || end == value.len()) {
                matched = Some(end);
            }
            if !live {
                break;
            }
        }
        Ok(matched)
    }
}

#[derive(Clone, Copy)]
enum Atom {
    Literal(char),
    Never,
    Any,
    Star,
    Class {
        start: usize,
        end: usize,
        negated: bool,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::FutureExt;

    fn finish<T>(future: impl std::future::Future<Output = T>) -> T {
        let mut future = Box::pin(future);
        let mut context = std::task::Context::from_waker(futures::task::noop_waker_ref());
        for _ in 0..4096 {
            if let std::task::Poll::Ready(value) = future.as_mut().poll(&mut context) {
                return value;
            }
        }
        panic!("bounded pattern operation did not finish");
    }

    #[test]
    fn quote_boundary_normalization_is_idempotent_across_repeated_matches() {
        for (quoted, suffix, positive, negative, magic, expected) in [
            ('a', '*', "aa", "ba", true, vec![('a', true), ('*', false)]),
            (
                '*',
                '*',
                "\\first",
                "first",
                true,
                vec![('\\', true), ('*', false), ('*', false)],
            ),
            (
                '?',
                '*',
                "\\first",
                "first",
                true,
                vec![('\\', true), ('?', false), ('*', false)],
            ),
            (
                '\\',
                '*',
                "\\*",
                "\\first",
                false,
                vec![('\\', true), ('*', true)],
            ),
        ] {
            let cancel = Cancel::new();
            let mut work = Work::new(16384, 16384, 16);
            let mut pattern = Pattern::default();
            pattern
                .push('\\', Protection::None, &mut work)
                .unwrap_or_else(|_| panic!("escape fits"));
            pattern
                .push(quoted, Protection::All, &mut work)
                .unwrap_or_else(|_| panic!("quoted target fits"));
            pattern
                .push(suffix, Protection::None, &mut work)
                .unwrap_or_else(|_| panic!("suffix fits"));
            for _ in 0..3 {
                assert_eq!(
                    finish(pattern.has_pathname_magic(&mut work, &cancel)).ok(),
                    Some(magic)
                );
                assert_eq!(
                    finish(pattern.matches_full(positive, &mut work, &cancel)).ok(),
                    Some(true)
                );
                assert_eq!(
                    finish(pattern.matches_full(negative, &mut work, &cancel)).ok(),
                    Some(false)
                );
                assert_eq!(
                    pattern
                        .chars
                        .iter()
                        .map(|ch| (ch.value, ch.protected))
                        .collect::<Vec<_>>(),
                    expected
                );
            }
        }
    }

    #[test]
    fn extended_quote_boundary_normalization_is_idempotent() {
        let mut work = Work::new(100000, 100000, 16);
        let cancel = Cancel::new();
        let mut pattern = Pattern::with_options(false, true);
        for (text, protection) in [
            ("@(a\\", Protection::None),
            ("|", Protection::All),
            ("b|c)", Protection::None),
        ] {
            for ch in text.chars() {
                pattern
                    .push(ch, protection, &mut work)
                    .unwrap_or_else(|_| panic!("pattern fits"));
            }
        }
        for _ in 0..3 {
            assert_eq!(
                finish(pattern.matches_full("b", &mut work, &cancel)).ok(),
                Some(true)
            );
            assert_eq!(
                finish(pattern.matches_full("a|b", &mut work, &cancel)).ok(),
                Some(false)
            );
        }
    }

    #[test]
    fn case_result_admits_capacity_not_only_written_bytes() {
        // The omitted pattern needs one state byte and the first String
        // growth reserves eight bytes, even for a one-byte result.
        for storage in [8, 9] {
            let mut pattern = Pattern::default();
            let mut work = Work::new(32, storage, 2);
            let cancel = Cancel::new();
            let result = pattern
                .change_case(
                    "a",
                    (true, true),
                    crate::state::CaseLocale::C,
                    8,
                    &mut work,
                    &cancel,
                )
                .now_or_never()
                .expect("small mapping finishes in one turn");
            if storage == 8 {
                assert!(matches!(result, Err(Error::Status(2))));
            } else {
                assert_eq!(
                    result.unwrap_or_else(|_| panic!("admitted mapping must fit")),
                    "A"
                );
                assert_eq!(work.storage_remaining, 0);
            }
        }
    }

    #[test]
    fn pattern_vectors_admit_spare_capacity_before_allocating() {
        let mut values = Vec::<Character>::new();
        let bytes = size_of::<Character>();
        let mut work = Work::new(32, bytes - 1, 2);
        assert!(matches!(
            admit_vec_slot(&mut values, &mut work),
            Err(Error::Status(2))
        ));
        assert_eq!(values.capacity(), 0);
        let mut work = Work::new(32, bytes, 2);
        admit_vec_slot(&mut values, &mut work)
            .unwrap_or_else(|_| panic!("exact capacity must fit"));
        assert_eq!(values.capacity(), 1);
        assert_eq!(work.storage_remaining, 0);
    }
}
