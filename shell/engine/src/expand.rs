//! Quote-aware fields adapted from Bashkit expansion.rs at the revision pinned
//! in sources.lock.json. Protection and empty fields are structural, never data
//! sentinels. Scalar parameter operands are lazy and bounded.
//! Scalar trims and replacements use basic patterns; argv and for-word lists
//! also expand pathname patterns through the shell filesystem.
use crate::{
    executor::Cancel,
    state::{SharedState, State},
};
use futures::FutureExt;
use shell_parser::parser::{ParameterOp, Word, WordPart};

mod array_slice;
mod braces;
use crate::state::CaseLocale as Locale;
mod case_pattern;
mod command;
mod glob;
pub(crate) use glob::{completion_matches, sort as sort_candidates};
mod ifs;
mod indices;
mod indirect;
mod operand;
pub(crate) mod pattern;
mod positional;
mod prefix;
mod printable;
mod replacement;
mod tilde;
mod transformation;
pub(crate) use printable::Printability;
use std::{borrow::Cow, collections::BTreeSet};
pub(crate) use tilde::assignment;

pub(crate) use crate::exec::{Error, ShellBoundaryStage};

pub(crate) async fn admit_assignment(
    state: &SharedState,
    name: &str,
    bytes: usize,
    cancel: &Cancel,
    work: &mut Work,
) -> Result<(), Error> {
    let result = State::admit_assignment(state, name, bytes, cancel, work).await;
    if matches!(&result, Err(Error::Status(1)))
        && matches!(
            state.borrow().resolve_scalar_target(name),
            crate::state::ScalarResolution::DepthExceeded
        )
    {
        return Err(Error::AssignmentDepth);
    }
    result
}

/// Expansion policy and command-substitution runner over neutral admission.
/// Keep feature state inline and preserve its lifetime through the whole command.
pub(crate) struct Work {
    execution: crate::exec::Work,
    frame_scope: Option<crate::exec::Scope>,
    arithmetic_depth: usize,
    arithmetic_names: Vec<(String, u64)>,
    pub(crate) arithmetic_writes: u64,
    /// Runs command substitutions; absent where a word cannot run commands.
    pub(crate) substitutions: Option<crate::interpreter::Substitutions>,
    /// Status of the last command substitution this command ran.
    pub(crate) substitution_status: Option<i32>,
}
impl std::ops::Deref for Work {
    type Target = crate::exec::Work;
    fn deref(&self) -> &Self::Target {
        &self.execution
    }
}
impl std::ops::DerefMut for Work {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.execution
    }
}
impl Work {
    pub(crate) fn new(steps: usize, storage: usize, fields: usize) -> Self {
        Self {
            execution: crate::exec::Work::new(steps, storage, fields),
            frame_scope: None,
            arithmetic_depth: 0,
            arithmetic_names: Vec::new(),
            arithmetic_writes: 0,
            substitutions: None,
            substitution_status: None,
        }
    }
    pub(crate) fn with_frame_scope(mut self, scope: crate::exec::Scope) -> Self {
        self.frame_scope = Some(scope);
        self
    }
    fn frame<'a, T: 'a, F>(
        &'a mut self,
        build: impl FnOnce(&'a mut Self) -> F,
    ) -> crate::exec::ResultFuture<'a, T>
    where
        F: std::future::Future<Output = Result<T, Error>> + 'a,
    {
        if let Some(scope) = self.frame_scope.clone() {
            return scope.frame(build(self), |code| Err(code.into()));
        }
        match self.admit_storage(std::mem::size_of::<F>()) {
            Ok(()) => futures::future::Either::Right(build(self).boxed_local()),
            Err(error) => futures::future::Either::Left(futures::future::ready(Err(error))),
        }
    }
    pub(crate) fn enter_arithmetic(&mut self) -> Result<(), Error> {
        if self.arithmetic_depth >= operand::MAX_DEPTH {
            return Err(2.into());
        }
        self.arithmetic_depth += 1;
        Ok(())
    }
    pub(crate) fn leave_arithmetic(&mut self) {
        self.arithmetic_depth -= 1;
    }
    pub(crate) async fn enter_scalar_arithmetic(
        &mut self,
        name: &str,
        cancel: &Cancel,
    ) -> Result<(), Error> {
        for index in 0..self.arithmetic_names.len() {
            self.checkpoint(cancel).await?;
            if self.arithmetic_names[index].0 == name
                && self.arithmetic_names[index].1 == self.arithmetic_writes
            {
                return crate::exec::fault("expression recursion level exceeded", self);
            }
        }
        if self.arithmetic_names.len() == self.arithmetic_names.capacity() {
            let capacity = self.arithmetic_names.capacity().saturating_mul(2).max(1);
            let bytes = (capacity - self.arithmetic_names.capacity())
                * std::mem::size_of::<(String, u64)>();
            self.admit_storage(bytes)?;
            self.arithmetic_names
                .try_reserve_exact(capacity - self.arithmetic_names.len())
                .map_err(|_| Error::Status(2))?;
        }
        self.admit_storage(name.len())?;
        self.arithmetic_names
            .push((name.to_owned(), self.arithmetic_writes));
        Ok(())
    }
    pub(crate) fn leave_scalar_arithmetic(&mut self) {
        self.arithmetic_names.pop();
    }
}

fn admit_string_growth(value: &mut String, bytes: usize, work: &mut Work) -> Result<(), Error> {
    let needed = value.len().checked_add(bytes).ok_or(2)?;
    if needed <= value.capacity() {
        return Ok(());
    }
    let capacity = needed.max(value.capacity().saturating_mul(2)).max(8);
    work.admit_storage(capacity - value.capacity())?;
    value
        .try_reserve_exact(capacity - value.len())
        .map_err(|_| Error::Status(2))
}

/// Admit and reserve room for exactly `total` elements when the count is
/// known, instead of doubling (which can charge almost twice the need).
fn admit_vec_exact<T>(value: &mut Vec<T>, total: usize, work: &mut Work) -> Result<(), Error> {
    if total <= value.capacity() {
        return Ok(());
    }
    let bytes = (total - value.capacity())
        .checked_mul(std::mem::size_of::<T>())
        .ok_or(2)?;
    work.admit_storage(bytes)?;
    value
        .try_reserve_exact(total - value.len())
        .map_err(|_| Error::Status(2))
}

fn admit_vec_slot<T>(value: &mut Vec<T>, work: &mut Work) -> Result<(), Error> {
    if value.len() < value.capacity() {
        return Ok(());
    }
    let capacity = value.capacity().saturating_mul(2).max(1);
    let bytes = (capacity - value.capacity())
        .checked_mul(std::mem::size_of::<T>())
        .ok_or(2)?;
    work.admit_storage(bytes)?;
    value
        .try_reserve_exact(capacity - value.len())
        .map_err(|_| Error::Status(2))
}

#[derive(Default)]
pub(crate) struct Ifs {
    small: [char; 3],
    small_len: usize,
    chars: BTreeSet<char>,
}
impl Ifs {
    fn separator(state: &SharedState) -> Option<char> {
        state
            .borrow()
            .field_ifs()
            .map_or(Some(' '), |value| value.chars().next())
    }
    async fn admit_access(
        state: &SharedState,
        cancel: &Cancel,
        work: &mut Work,
    ) -> Result<(), Error> {
        State::admit_scalar_access(state, "IFS", cancel, work).await
    }
    pub(crate) async fn new(
        state: &SharedState,
        cancel: &Cancel,
        max: usize,
        work: &mut Work,
    ) -> Result<Self, Error> {
        Self::admit_access(state, cancel, work).await?;
        let value: Cow<'static, str> = {
            let s = state.borrow();
            let value = s.field_ifs().unwrap_or(" \t\n");
            if value.len() > max.max(3) {
                return Err(2.into());
            }
            match value {
                "" => Cow::Borrowed(""),
                " \t\n" => Cow::Borrowed(" \t\n"),
                value => {
                    work.admit_storage(value.len())?;
                    Cow::Owned(value.to_owned())
                }
            }
        };
        let snapshot_bytes = if matches!(&value, Cow::Owned(_)) {
            value.len()
        } else {
            0
        };
        let members = state.borrow().cached_ifs_members();
        let mut ifs = Self::default();
        for ch in value.chars() {
            work.checkpoint(cancel).await?;
            if members.is_none_or(|members| members.contains(ch)) {
                ifs.insert(ch, work)?;
            }
        }
        drop(value);
        work.release_storage(snapshot_bytes);
        Ok(ifs)
    }
    fn single(ch: char) -> Self {
        Self {
            small: [ch, '\0', '\0'],
            small_len: 1,
            chars: BTreeSet::new(),
        }
    }
    fn is_empty(&self) -> bool {
        self.small_len == 0 && self.chars.is_empty()
    }
    pub(crate) fn contains(&self, ch: char) -> bool {
        self.small[..self.small_len].contains(&ch) || self.chars.contains(&ch)
    }
    fn insert(&mut self, ch: char, work: &mut Work) -> Result<(), Error> {
        if self.contains(ch) {
            return Ok(());
        }
        if self.small_len < self.small.len() {
            self.small[self.small_len] = ch;
            self.small_len += 1;
            return Ok(());
        }
        // Charge a whole sparse B-tree node before each new overflow member.
        // Default/empty and short delimiter sets need no collection allocation.
        work.admit_storage((std::mem::size_of::<char>() + std::mem::size_of::<usize>()) * 16)?;
        self.chars.insert(ch);
        Ok(())
    }
    fn delimiter(&self, ch: char) -> Delimiter {
        if !self.contains(ch) {
            return Delimiter::Text;
        }
        if matches!(ch, ' ' | '\t' | '\n') {
            return Delimiter::Whitespace;
        }
        Delimiter::Other
    }
}
enum Delimiter {
    Text,
    Whitespace,
    Other,
}

#[derive(Clone, Copy)]
enum Protection {
    None,
    Spaces,
    All,
}
impl Protection {
    fn expansion(quoted: bool, state: &SharedState) -> Self {
        if quoted {
            return Self::All;
        }
        if Ifs::separator(state).is_none() {
            return Self::Spaces;
        }
        Self::None
    }
    fn protects(self, ch: char) -> bool {
        matches!(self, Self::All) || (matches!(self, Self::Spaces) && ch == ' ')
    }
}

/// Retain protection and list separators until all parameter writes finish.
/// Text and separators are bounded by raw_remaining; empty events consume Work.
/// Adjacent text with identical protection shares one allocation, including
/// the operand scanner's character-sized pieces.
enum Segment {
    Text {
        value: String,
        protected: bool,
        glob_protected: bool,
    },
    Empty,
    ListSeparator(char),
}
#[derive(Default)]
struct Segments {
    parts: Vec<Segment>,
    needs_split: bool,
    list_word: bool,
    split_space: bool,
    account_storage: bool,
}
impl Segments {
    fn admit_slot(&mut self, work: &mut Work) -> Result<(), Error> {
        if !self.account_storage || self.parts.len() < self.parts.capacity() {
            return Ok(());
        }
        let capacity = self.parts.capacity().saturating_mul(2).max(1);
        let bytes = (capacity - self.parts.capacity())
            .checked_mul(std::mem::size_of::<Segment>())
            .ok_or(2)?;
        work.admit_storage(bytes)?;
        self.parts
            .try_reserve_exact(capacity - self.parts.len())
            .map_err(|_| Error::Status(2))
    }
    fn character(
        &mut self,
        ch: char,
        protected: bool,
        glob_protected: bool,
        work: &mut Work,
    ) -> Result<(), Error> {
        if let Some(Segment::Text {
            value,
            protected: previous,
            glob_protected: previous_glob,
        }) = self.parts.last_mut()
            && *previous == protected
            && *previous_glob == glob_protected
        {
            if self.account_storage {
                admit_string_growth(value, ch.len_utf8(), work)?;
            }
            value.push(ch);
            return Ok(());
        }
        self.admit_slot(work)?;
        let value = if self.account_storage {
            let mut value = String::new();
            admit_string_growth(&mut value, ch.len_utf8(), work)?;
            value.push(ch);
            value
        } else {
            ch.to_string()
        };
        self.parts.push(Segment::Text {
            value,
            protected,
            glob_protected,
        });
        Ok(())
    }
    fn empty(&mut self, work: &mut Work) -> Result<(), Error> {
        if !matches!(self.parts.last(), Some(Segment::Empty)) {
            self.admit_slot(work)?;
            self.parts.push(Segment::Empty);
        }
        Ok(())
    }
    async fn join(
        self,
        ifs: Ifs,
        max_bytes: usize,
        max_fields: usize,
        work: &mut Work,
        cancel: &Cancel,
    ) -> Result<String, Error> {
        let mut fields = Fields::new(max_bytes, max_fields);
        fields.joined = true;
        Ok(self.collect(ifs, fields, work, cancel).await?.current)
    }
    async fn collect(
        self,
        mut ifs: Ifs,
        mut fields: Fields,
        work: &mut Work,
        cancel: &Cancel,
    ) -> Result<Fields, Error> {
        fields.account_storage |= self.account_storage;
        // @ uses spaces when the final IFS is empty. Positional unquoted *
        // expanded with empty IFS selects space splitting for the whole word.
        if !self.needs_split {
            ifs = Ifs::default();
        } else if self.split_space || (self.list_word && ifs.is_empty()) {
            ifs = Ifs::single(' ');
        }
        fields.list_word = self.list_word;
        for part in self.parts {
            fields.segment(part, &ifs, work, cancel).await?;
        }
        fields.end_group(work)?;
        fields.join_checkpoints(work, cancel).await?;
        Ok(fields)
    }
}

/// Accumulates a single word's groups. IFS whitespace is deferred so an
/// adjacent non-whitespace delimiter consumes it as one delimiter, including
/// across segment boundaries. Empty protected segments act as text boundaries.
/// Joined diagnostics retain all text in `current`, leaving `out` unallocated;
/// their buffer growth and retained segments share Work's storage admission.
struct Fields {
    out: Vec<String>,
    current: String,
    pathname: bool,
    /// Byte protections for pathname candidates only, keyed by `out` index.
    /// Fields without an unprotected `*`, `?` or `[` keep no mask.
    protections: Vec<(usize, Vec<bool>)>,
    /// The current field's protection as (bytes, protected) runs, so plain
    /// argv pays per quote boundary rather than per byte.
    current_runs: Vec<(usize, bool)>,
    current_magic: bool,
    /// Admitted words with extglob on also flag `@(`, `+(` and `!(` groups,
    /// which pathname expansion rejects instead of treating them literally.
    extglob_groups: bool,
    group_prefix: bool,
    present: bool,
    whitespace: bool,
    leading: bool,
    list_word: bool,
    bytes: usize,
    max_bytes: usize,
    max_fields: usize,
    count: usize,
    joined: bool,
    account_storage: bool,
    join_work: usize,
}
impl Fields {
    fn new(max_bytes: usize, max_fields: usize) -> Self {
        Self {
            out: Vec::new(),
            current: String::new(),
            pathname: false,
            protections: Vec::new(),
            current_runs: Vec::new(),
            current_magic: false,
            extglob_groups: false,
            group_prefix: false,
            present: false,
            whitespace: false,
            leading: true,
            list_word: false,
            bytes: 0,
            max_bytes,
            max_fields,
            count: 0,
            joined: false,
            account_storage: false,
            join_work: 0,
        }
    }
    fn push(&mut self, work: &mut Work) -> Result<(), Error> {
        if self.count >= self.max_fields {
            return Err(2.into());
        }
        if self.joined {
            self.start_field(work)?;
            self.join_work += 1;
        } else {
            if self.account_storage {
                admit_vec_slot(&mut self.out, work)?;
            }
            self.out.push(std::mem::take(&mut self.current));
            if self.pathname {
                self.keep_protection(work)?;
            }
        }
        self.count += 1;
        self.present = false;
        Ok(())
    }
    /// Only pathname candidates expand their runs into a byte mask.
    fn keep_protection(&mut self, work: &mut Work) -> Result<(), Error> {
        self.group_prefix = false;
        if !std::mem::take(&mut self.current_magic) {
            self.current_runs.clear();
            return Ok(());
        }
        let index = self.out.len().checked_sub(1).ok_or(2)?;
        let mut mask = Vec::new();
        admit_vec_exact(&mut mask, self.out[index].len(), work)?;
        for &(bytes, protected) in &self.current_runs {
            mask.resize(mask.len() + bytes, protected);
        }
        self.current_runs.clear();
        admit_vec_slot(&mut self.protections, work)?;
        self.protections.push((index, mask));
        Ok(())
    }
    fn protect(&mut self, bytes: usize, protected: bool, work: &mut Work) -> Result<(), Error> {
        if let Some((length, last)) = self.current_runs.last_mut()
            && *last == protected
        {
            *length += bytes;
            return Ok(());
        }
        // Unadmitted argv charges neither its text nor these per-segment runs.
        if self.account_storage {
            admit_vec_slot(&mut self.current_runs, work)?;
        }
        self.current_runs.push((bytes, protected));
        Ok(())
    }
    async fn segment(
        &mut self,
        part: Segment,
        ifs: &Ifs,
        work: &mut Work,
        cancel: &Cancel,
    ) -> Result<(), Error> {
        let (value, protected, glob_protected) = match part {
            Segment::Empty => {
                work.checkpoint(cancel).await?;
                self.text_boundary(work)?;
                return self.join_checkpoints(work, cancel).await;
            }
            Segment::ListSeparator(ch) => {
                work.checkpoint(cancel).await?;
                self.character(ch, ifs.delimiter(ch), false, work)?;
                return self.join_checkpoints(work, cancel).await;
            }
            Segment::Text {
                value,
                protected,
                glob_protected,
            } => (value, protected, glob_protected),
        };
        // Text segments are nonempty; their first character pays for entry.
        for ch in value.chars() {
            work.checkpoint(cancel).await?;
            let delimiter = if protected {
                Delimiter::Text
            } else {
                ifs.delimiter(ch)
            };
            self.character(ch, delimiter, glob_protected, work)?;
            self.join_checkpoints(work, cancel).await?;
        }
        Ok(())
    }
    async fn join_checkpoints(&mut self, work: &mut Work, cancel: &Cancel) -> Result<(), Error> {
        for _ in 0..std::mem::take(&mut self.join_work) {
            work.checkpoint(cancel).await?;
        }
        Ok(())
    }
    fn text_boundary(&mut self, work: &mut Work) -> Result<(), Error> {
        if self.whitespace && self.present {
            self.push(work)?;
        }
        self.whitespace = false;
        self.leading = false;
        self.start_field(work)
    }
    fn start_field(&mut self, work: &mut Work) -> Result<(), Error> {
        if self.count >= self.max_fields {
            return Err(2.into());
        }
        if self.joined && !self.present && self.count != 0 {
            self.append(' ', true, work)?;
        }
        self.present = true;
        Ok(())
    }
    fn character(
        &mut self,
        ch: char,
        delimiter: Delimiter,
        glob_protected: bool,
        work: &mut Work,
    ) -> Result<(), Error> {
        match delimiter {
            Delimiter::Whitespace => self.whitespace = true,
            Delimiter::Other => self.non_whitespace(work)?,
            Delimiter::Text => self.text(ch, glob_protected, work)?,
        }
        Ok(())
    }
    fn non_whitespace(&mut self, work: &mut Work) -> Result<(), Error> {
        // Bash's list-word path trims leading IFS whitespace together
        // with its adjacent first delimiter. Protected empty prefixes are
        // text boundaries and have already ended the leading region.
        let trim = self.list_word && self.leading && self.whitespace;
        self.leading = false;
        self.whitespace = false;
        if !trim {
            self.push(work)?;
        }
        Ok(())
    }
    fn text(&mut self, ch: char, glob_protected: bool, work: &mut Work) -> Result<(), Error> {
        self.text_boundary(work)?;
        self.append(ch, glob_protected, work)
    }
    fn append(&mut self, ch: char, glob_protected: bool, work: &mut Work) -> Result<(), Error> {
        if ch.len_utf8() > self.max_bytes.saturating_sub(self.bytes) {
            return Err(2.into());
        }
        if self.joined || self.account_storage {
            admit_string_growth(&mut self.current, ch.len_utf8(), work)?;
        }
        if self.joined {
            self.join_work += 1;
        }
        self.bytes += ch.len_utf8();
        self.current.push(ch);
        if self.pathname {
            self.protect(ch.len_utf8(), glob_protected, work)?;
            let active = !glob_protected;
            self.current_magic |=
                active && (matches!(ch, '*' | '?' | '[') || (ch == '(' && self.group_prefix));
            self.group_prefix = self.extglob_groups && active && matches!(ch, '@' | '+' | '!');
        }
        Ok(())
    }
    fn end_group(&mut self, work: &mut Work) -> Result<(), Error> {
        if self.present {
            self.push(work)?;
        }
        self.whitespace = false;
        Ok(())
    }
}

/// Selected assignment operands are captured before field splitting.
/// Quote removal belongs to operand evaluation; assignment results inherit only
/// the outer word's protection, as in Bash (unlike default/alternative results).
struct Captured {
    value: String,
    max_bytes: usize,
}
impl Captured {
    fn append(&mut self, value: &str) -> Result<(), Error> {
        if value.len() > self.max_bytes.saturating_sub(self.value.len()) {
            return Err(2.into());
        }
        self.value.push_str(value);
        Ok(())
    }
    async fn append_admitted(
        &mut self,
        value: &str,
        work: &mut Work,
        cancel: &Cancel,
    ) -> Result<(), Error> {
        for ch in value.chars() {
            work.checkpoint(cancel).await?;
            admit_string_growth(&mut self.value, ch.len_utf8(), work)?;
            self.append(ch.encode_utf8(&mut [0; 4]))?;
        }
        Ok(())
    }
}

#[derive(Clone, Copy)]
struct OperandContext<'a> {
    state: &'a SharedState,
    quoted: bool,
    scalar: bool,
    depth: usize,
}

#[derive(Clone, Copy)]
struct TransformContext<'a> {
    state: &'a SharedState,
    protected: bool,
    depth: usize,
}

#[derive(Clone, Copy)]
struct ExpansionOptions {
    max_bytes: usize,
    max_fields: usize,
    max_raw: usize,
    scalar: bool,
    pathname: bool,
    admitted: bool,
    tilde: tilde::Context,
}

struct Expansion<'a> {
    segments: Segments,
    captured: Option<Captured>,
    pattern: Option<pattern::Pattern>,
    replacement: Option<replacement::Replacement>,
    pattern_context: bool,
    // Diagnostics leave pattern syntax but retain enclosing snapshot charges.
    pattern_snapshots: bool,
    // Fully admitted entry points also own their boxed recursive futures.
    admit_frames: bool,
    ifs: Option<Ifs>,
    ifs_changed: bool,
    work: &'a mut Work,
    cancel: &'a Cancel,
    max_raw: usize,
    /// Also bound intermediate expansion bytes, even if IFS removes them all.
    raw_remaining: usize,
    /// Empty array/positional elements consume work even when they emit no text.
    elements_remaining: usize,
}
impl Expansion<'_> {
    /// Only actual value reads require a binding. The target of a lazy
    /// default/replacement/error operator is tested for absence, not read;
    /// ordinary expansions in its selected operand still pass through here.
    async fn require_bound(&mut self, name: &str, state: &SharedState) -> Result<(), Error> {
        State::admit_scalar_access(state, name, self.cancel, self.work).await?;
        if !state.borrow().nounset {
            return Ok(());
        }
        for _ in name.bytes() {
            self.work.checkpoint(self.cancel).await?;
        }
        let missing = {
            let state = state.borrow();
            match name {
                "0" | "?" | "#" | "@" | "*" | "PWD" | "PIPESTATUS" => false,
                "!" => state.last_async().is_none(),
                _ if operand::scalar_name(name) => !state.scalar_is_set(name),
                _ if !name.is_empty() && name.bytes().all(|byte| byte.is_ascii_digit()) => name
                    .parse::<usize>()
                    .map_or(true, |index| index > state.positional().len()),
                // Other special parameters and general arrays are outside the
                // scalar adapter; nounset does not add semantics for them.
                _ => false,
            }
        };
        if !missing {
            return Ok(());
        }
        // Own the name only after admitting it and the owning diagnostic's
        // later formatted copy. Cancellation/limits win before allocation.
        self.work
            .admit_storage(name.len().saturating_mul(2).saturating_add(128))?;
        Err(Error::Unbound {
            name: name.to_owned(),
            line: None,
        })
    }
    async fn current_ifs(&mut self, state: &SharedState) -> Result<(), Error> {
        if self.ifs.is_none() {
            self.ifs = Some(Ifs::new(state, self.cancel, self.raw_remaining, self.work).await?);
        }
        Ok(())
    }
    async fn ifs_separator(&mut self, state: &SharedState) -> Result<Option<char>, Error> {
        Ifs::admit_access(state, self.cancel, self.work).await?;
        Ok(Ifs::separator(state))
    }
    fn admit_raw(&mut self, bytes: usize) -> Result<(), Error> {
        if bytes > self.raw_remaining {
            return Err(2.into());
        }
        self.raw_remaining -= bytes;
        Ok(())
    }
    fn snapshot_max(&self) -> usize {
        if !self.pattern_snapshots {
            return self.raw_remaining;
        }
        self.raw_remaining
            .min(self.work.remaining)
            .min(self.work.storage_remaining)
    }
    async fn admit_pattern_snapshot(&mut self, value: &str) -> Result<(), Error> {
        if !self.pattern_snapshots {
            return Ok(());
        }
        self.scan_value(value).await
    }
    async fn scan_value(&mut self, value: &str) -> Result<(), Error> {
        for _ in value.bytes() {
            self.work.checkpoint(self.cancel).await?;
        }
        Ok(())
    }
    async fn empty_expansion(&mut self, protected: bool, state: &SharedState) -> Result<(), Error> {
        self.segment("", Protection::expansion(protected, state), protected)
            .await
    }
    fn admit_pattern_length(&mut self, name: &str, state: &SharedState) -> Result<(), Error> {
        if !self.pattern_snapshots {
            return Ok(());
        }
        if !operand::length_name(name) {
            return Err(2.into());
        }
        // A nested length retains its existing counting rules. Its transient
        // input must also fit alongside the enclosing trim's snapshot.
        if state.borrow().dynamic_parameter(name) {
            self.work.admit_storage(State::DYNAMIC_PARAMETER_BYTES)
        } else if matches!(name, "?" | "#") {
            // parameter() formats these special values into an owned string.
            self.work.admit_storage(20)
        } else {
            self.work
                .admit_storage(state.borrow().parameter(name).len())
        }
    }
    async fn literal(
        &mut self,
        value: &str,
        state: &SharedState,
        protected: bool,
    ) -> Result<(), Error> {
        if protected || self.captured.is_some() || value.is_empty() {
            return self.segment(value, Protection::All, protected).await;
        }
        self.admit_raw(value.len())?;
        self.current_ifs(state).await?;
        let ifs = self.ifs.as_ref().ok_or(2)?;
        let members = state.borrow().cached_ifs_members();
        // Bash protects literal IFS characters when emitting them. A later
        // assignment may make a previously ordinary literal a delimiter.
        for ch in value.chars() {
            self.work.checkpoint(self.cancel).await?;
            self.segments.character(
                ch,
                members.map_or_else(
                    || !matches!(ifs.delimiter(ch), Delimiter::Text),
                    |members| members.contains(ch),
                ),
                false,
                self.work,
            )?;
        }
        Ok(())
    }
    async fn segment(
        &mut self,
        value: &str,
        protection: Protection,
        keeps_empty: bool,
    ) -> Result<(), Error> {
        self.admit_raw(value.len())?;
        self.emit(value, protection, keeps_empty).await
    }
    async fn emit(
        &mut self,
        value: &str,
        protection: Protection,
        keeps_empty: bool,
    ) -> Result<(), Error> {
        if let Some(pattern) = &mut self.pattern {
            self.work.checkpoint(self.cancel).await?;
            if value.is_empty() && keeps_empty {
                pattern.keep_empty();
            }
            for ch in value.chars() {
                self.work.checkpoint(self.cancel).await?;
                pattern.push(ch, protection, self.work)?;
            }
            return Ok(());
        }
        if let Some(replacement) = &mut self.replacement {
            self.work.checkpoint(self.cancel).await?;
            for ch in value.chars() {
                self.work.checkpoint(self.cancel).await?;
                replacement.push(ch, protection, self.work)?;
            }
            return Ok(());
        }
        if let Some(captured) = &mut self.captured {
            self.work.checkpoint(self.cancel).await?;
            if self.pattern_snapshots || self.segments.account_storage {
                return captured
                    .append_admitted(value, self.work, self.cancel)
                    .await;
            }
            return captured.append(value);
        }
        if value.is_empty() {
            self.work.checkpoint(self.cancel).await?;
            if keeps_empty {
                self.segments.empty(self.work)?;
            }
            return Ok(());
        }
        for ch in value.chars() {
            self.work.checkpoint(self.cancel).await?;
            self.segments.character(
                ch,
                protection.protects(ch),
                matches!(protection, Protection::All),
                self.work,
            )?;
        }
        Ok(())
    }
    fn part<'a>(
        &'a mut self,
        part: &'a WordPart,
        state: &'a SharedState,
        quoted: bool,
        scalar: bool,
        depth: usize,
    ) -> crate::exec::ResultFuture<'a, ()> {
        self.part_frame(move |expansion| async move {
            if !scalar && !quoted {
                Ifs::admit_access(state, expansion.cancel, expansion.work).await?;
            }
            expansion.segments.needs_split |= !scalar && !quoted;
            if matches!(part, WordPart::BadSubstitution(_)) {
                expansion.work.admit_storage(256)?;
                return Err(Error::BadSubstitution {
                    message: "invalid parameter expansion",
                    line: None,
                });
            }
            if let WordPart::ParameterExpansion {
                name,
                operator,
                operand,
                colon_variant,
            } = part
            {
                return expansion
                    .parameter(
                        name,
                        operator,
                        operand,
                        *colon_variant,
                        OperandContext {
                            state,
                            quoted,
                            scalar,
                            depth,
                        },
                        None,
                    )
                    .await;
            }
            if let WordPart::IndirectExpansion {
                name,
                operator,
                operand,
                colon_variant,
            } = part
            {
                // The parser represents the special `${!}` with an empty
                // indirect name. Resolve that typed node as an ordinary read.
                if name.is_empty() && operator.is_none() {
                    return expansion.variable("!", state, quoted, scalar).await;
                }
                return expansion
                    .indirect(
                        name,
                        operator.as_ref(),
                        operand,
                        *colon_variant,
                        OperandContext {
                            state,
                            quoted,
                            scalar,
                            depth,
                        },
                    )
                    .await;
            }
            if let WordPart::FileSubstitution(commands) = part {
                return expansion
                    .file_substitution(commands, state, quoted, scalar)
                    .await;
            }
            if let WordPart::CommandSubstitution(commands) = part {
                return expansion
                    .command_substitution(commands, state, quoted, scalar)
                    .await;
            }
            if let WordPart::ProcessSubstitution { commands, is_input } = part {
                // Bash expands an empty body (`<()`) to nothing at all.
                if commands.is_empty() {
                    return expansion.segment("", Protection::All, false).await;
                }
                let runner = expansion.work.substitutions.clone().ok_or(2)?;
                crate::ast_copy::admit(commands, expansion.cancel, expansion.work).await?;
                let mut child =
                    crate::state::State::snapshot(state, expansion.cancel, expansion.work).await?;
                child.traps = state.borrow().traps.process_substitution();
                let child = child.shared();
                expansion.work.admit_storage(16)?;
                let fd = runner
                    .process(commands.clone(), *is_input, child, state, expansion.work)
                    .await?;
                return expansion
                    .segment(&format!("/dev/fd/{fd}"), Protection::All, false)
                    .await;
            }
            if matches!(part, WordPart::UnparsedProcessSubstitution { .. }) {
                expansion.work.admit_storage(256)?;
                return Err(Error::ShellBoundary {
                    stage: ShellBoundaryStage::Expansion,
                    line: None,
                });
            }
            if let WordPart::UnparsedCommandSubstitution { source, error } = part {
                return expansion
                    .unparsed_substitution(source, error, state, quoted, scalar)
                    .await;
            }
            if let WordPart::ArithmeticExpansion(source) = part {
                let value = crate::arithmetic::evaluate(
                    source,
                    state,
                    expansion.cancel,
                    expansion.raw_remaining,
                    expansion.work,
                )
                .await
                .map_err(Error::in_expansion)?;
                expansion.ifs = None;
                expansion.ifs_changed = true;
                expansion.work.admit_storage(20)?;
                return expansion
                    .segment(
                        &value.to_string(),
                        Protection::expansion(scalar || quoted, state),
                        scalar || quoted,
                    )
                    .await;
            }
            if let WordPart::Substring {
                name,
                offset,
                length,
            } = part
            {
                return expansion
                    .substring_part(name, offset, length.as_deref(), state, quoted, scalar)
                    .await
                    .map_err(Error::in_expansion);
            }
            if is_list(part) {
                return expansion
                    .elements(part, state, quoted, scalar || expansion.captured.is_some())
                    .await;
            }
            if let WordPart::PrefixMatch { prefix, star } = part {
                return expansion
                    .prefix_names(
                        prefix,
                        *star,
                        state,
                        quoted,
                        scalar || expansion.captured.is_some(),
                    )
                    .await;
            }
            if let WordPart::ArrayLength(name) = part {
                return expansion
                    .indexed_length(name, "@", state, scalar || quoted)
                    .await;
            }
            if let WordPart::Length(name) = part {
                if name.contains(':') {
                    expansion.work.admit_storage(256)?;
                    return Err(Error::BadSubstitution {
                        message: "invalid length parameter",
                        line: None,
                    });
                }
                expansion.admit_pattern_length(name, state)?;
                return expansion.length(name, state, scalar || quoted, depth).await;
            }
            if let WordPart::ArrayAccess { name, index } = part
                && name != "PIPESTATUS"
            {
                return expansion
                    .indexed_element(name, index, state, scalar || quoted)
                    .await;
            }
            if let WordPart::Variable(name) = part {
                return expansion.variable(name, state, quoted, scalar).await;
            }
            if let WordPart::Transformation { name, operator } = part {
                return expansion
                    .transformation(
                        name,
                        *operator,
                        TransformContext {
                            state,
                            protected: scalar || quoted,
                            depth,
                        },
                    )
                    .await;
            }
            let max = expansion.snapshot_max();
            let value = scalar_value(
                part,
                state,
                max,
                expansion.pattern_snapshots.then_some(&mut *expansion.work),
            )?;
            expansion.admit_pattern_snapshot(&value).await?;
            expansion
                .segment(
                    &value,
                    Protection::expansion(scalar || quoted, state),
                    scalar || quoted,
                )
                .await
        })
    }

    fn part_frame<'a, F>(
        &'a mut self,
        build: impl FnOnce(&'a mut Self) -> F,
    ) -> crate::exec::ResultFuture<'a, ()>
    where
        F: std::future::Future<Output = Result<(), Error>> + 'a,
    {
        // Admitted scalar/pattern contexts must charge the actual recursive
        // future before boxing it. Legacy argv retains its separate accounting.
        if self.admit_frames
            && let Err(error) = self.work.admit_storage(std::mem::size_of::<F>())
        {
            return futures::future::Either::Left(futures::future::ready(Err(error)));
        }
        futures::future::Either::Right(build(self).boxed_local())
    }

    async fn variable(
        &mut self,
        name: &str,
        state: &SharedState,
        quoted: bool,
        scalar: bool,
    ) -> Result<(), Error> {
        self.require_bound(name, state).await?;
        let max = self.snapshot_max();
        let value = {
            let state = state.borrow();
            let dynamic = state.dynamic_parameter(name);
            let formatted = matches!(name, "?" | "#") || dynamic;
            if dynamic {
                self.work.admit_storage(State::DYNAMIC_PARAMETER_BYTES)?;
            } else if self.pattern_snapshots && formatted {
                self.work.admit_storage(20)?;
            }
            let value = state.parameter(name);
            if self.pattern_snapshots && !formatted {
                self.work.admit_storage(value.len())?;
            }
            bounded(value, max)?
        };
        self.admit_pattern_snapshot(&value).await?;
        self.segment(
            &value,
            Protection::expansion(scalar || quoted, state),
            scalar || quoted,
        )
        .await
    }
    /// Brace extraction parses process-substitution lookalikes before lazy
    /// selection. Nested command/arithmetic substitutions stay opaque here.
    async fn slice_boundaries(&mut self, source: &str) -> Result<(), Error> {
        // Ordinary operands already have a cooperative scanner. Avoid a
        // second charged pass when no shell boundary can be present.
        if !source.contains(['<', '>']) {
            return Ok(());
        }
        let mut chars = source.char_indices().peekable();
        let mut quote = None;
        let mut escaped = false;
        while let Some((index, c)) = chars.next() {
            self.work.checkpoint(self.cancel).await?;
            if escaped {
                escaped = false;
                continue;
            }
            if quote == Some(c) {
                quote = None;
                continue;
            }
            if c == '\\' && quote != Some('\'') {
                escaped = true;
                continue;
            }
            if quote.is_some() {
                continue;
            }
            if matches!(c, '\'' | '"' | '`') {
                quote = Some(c);
                continue;
            }
            if !matches!(c, '<' | '>' | '$') || chars.peek().is_none_or(|&(_, c)| c != '(') {
                continue;
            }
            let begin = index + 2;
            let (mut end, fused) = self.slice_body_end(source, begin, false).await?;
            if c != '$' {
                // Bash reads a process substitution here by parsing commands
                // up to their closing `)` (`xparse_dolparen`), so a fused
                // `<((` span ends where command grammar ends it.
                if fused {
                    end = self.slice_body_end(source, begin, true).await?.0;
                }
                self.validate_slice_body(&source[begin..end]).await?;
            }
            while chars.peek().is_some_and(|&(index, _)| index <= end) {
                self.work.checkpoint(self.cancel).await?;
                chars.next();
            }
        }
        Ok(())
    }

    async fn slice_body_end(
        &mut self,
        source: &str,
        begin: usize,
        command: bool,
    ) -> Result<(usize, bool), Error> {
        // Reserve initial scanner buffers, then their conservative cumulative
        // growth allowance before each character. Text after its closing `)`
        // must not consume scanner storage.
        self.work.admit_storage(2048)?;
        let mut scanner = shell_parser::parser::CommandBoundaryScanner::new();
        if command {
            // A blank first keeps a leading `(` a subshell, not arithmetic.
            scanner.feed(' ');
        }
        for (index, c) in source[begin..].char_indices() {
            self.work.checkpoint(self.cancel).await?;
            if index > 4096 {
                return Err(2.into());
            }
            self.work.admit_storage(512)?;
            if scanner.feed(c) == shell_parser::parser::CommandBoundaryStep::Close {
                return Ok((begin + index, scanner.arithmetic_start().is_some()));
            }
        }
        self.work.admit_storage(256)?;
        Err(Error::ShellBoundary {
            stage: ShellBoundaryStage::Expansion,
            line: None,
        })
    }

    async fn validate_slice_body(&mut self, body: &str) -> Result<(), Error> {
        self.work.admit_parse(body.len(), self.cancel).await?;
        self.work
            .admit_storage(body.len().saturating_mul(512).saturating_add(2048))?;
        match crate::parse::substitution_grammar(body) {
            Ok(_) => Ok(()),
            Err(error) if shell_parser_budget_error(&error) => Err(2.into()),
            Err(_) => {
                self.work.admit_storage(256)?;
                Err(Error::ShellBoundary {
                    stage: ShellBoundaryStage::Expansion,
                    line: None,
                })
            }
        }
    }
    async fn substring_part(
        &mut self,
        name: &str,
        offset: &str,
        length: Option<&str>,
        state: &SharedState,
        quoted: bool,
        scalar: bool,
    ) -> Result<(), Error> {
        if name == "@" {
            return self
                .positional_substring(offset, length, state, quoted, scalar)
                .await;
        }
        if let Some((array, index)) = indexed_name(name)
            && matches!(index, "@" | "*")
        {
            return self
                .array_substring(array, index == "@", (offset, length), state, quoted, scalar)
                .await;
        }
        let result = self
            .substring(name, (offset, length), state, scalar || quoted, false)
            .await;
        self.ifs = None;
        self.ifs_changed = true;
        result
    }
    /// `null_field` marks a quoted `[@]` reference, where an out-of-range
    /// start yields no word, like an empty `"$@"`.
    async fn substring(
        &mut self,
        name: &str,
        (offset, length): (&str, Option<&str>),
        state: &SharedState,
        protected: bool,
        null_field: bool,
    ) -> Result<(), Error> {
        if !operand::length_name(name) {
            return Err(2.into());
        }
        self.work.checkpoint(self.cancel).await?;
        self.slice_boundaries(offset).await?;
        if let Some(length) = length {
            self.slice_boundaries(length).await?;
        }
        // Resolve the source before arithmetic side effects. An unset scalar
        // skips both expressions; an out-of-range start skips the length.
        self.require_bound(name, state).await?;
        let present = {
            let s = state.borrow();
            if operand::scalar_name(name) {
                s.scalar_is_set(name)
            } else if matches!(name, "?" | "#") {
                true
            } else {
                name.parse::<usize>()
                    .ok()
                    .and_then(|n| n.checked_sub(1))
                    .is_some_and(|n| n < s.positional().len())
            }
        };
        if !present {
            return self.empty_expansion(protected, state).await;
        }
        let (value, utf8) = {
            let s = state.borrow();
            let value = substring_snapshot(&s, name, self.raw_remaining, self.work)?;
            let locale = ["LC_ALL", "LC_CTYPE", "LANG"]
                .iter()
                .filter_map(|name| s.bindings().get(*name))
                .find(|v| !v.is_empty());
            (value, locale.is_some_and(|v| utf8_locale(v)))
        };
        let count = self.character_count(&value, utf8).await?;
        let offset =
            crate::arithmetic::evaluate(offset, state, self.cancel, self.raw_remaining, self.work)
                .await?;
        self.ifs = None;
        self.ifs_changed = true;
        let start = if offset < 0 {
            count.checked_sub(usize::try_from(offset.unsigned_abs()).unwrap_or(usize::MAX))
        } else {
            usize::try_from(offset).ok().filter(|&n| n <= count)
        };
        let Some(start) = start else {
            if null_field {
                self.element_layout(ListSource::Array, true, state, true, false)
                    .await?;
                return Ok(());
            }
            return self.empty_expansion(protected, state).await;
        };
        let end = if let Some(length) = length {
            let length = crate::arithmetic::evaluate(
                length,
                state,
                self.cancel,
                self.raw_remaining,
                self.work,
            )
            .await?;
            self.ifs = None;
            self.ifs_changed = true;
            if length < 0 {
                match count
                    .checked_sub(usize::try_from(length.unsigned_abs()).unwrap_or(usize::MAX))
                {
                    Some(end) if end >= start => end,
                    _ => return crate::exec::fault("substring expression < 0", self.work),
                }
            } else {
                start
                    .saturating_add(usize::try_from(length).unwrap_or(usize::MAX))
                    .min(count)
            }
        } else {
            count
        };
        let (mut byte_start, mut byte_end) = (start, end);
        if utf8 {
            byte_start = value.len();
            byte_end = value.len();
            for (index, (byte, _)) in value.char_indices().enumerate() {
                self.work.checkpoint(self.cancel).await?;
                if index == start {
                    byte_start = byte;
                }
                if index == end {
                    byte_end = byte;
                    break;
                }
            }
        }
        // The engine stores valid UTF-8 scalars; byte slices that would produce
        // invalid UTF-8 are explicitly outside that representation.
        let result = value.get(byte_start..byte_end).ok_or(2)?;
        self.segment(result, Protection::expansion(protected, state), protected)
            .await
    }
    async fn character_count(&mut self, value: &str, utf8: bool) -> Result<usize, Error> {
        let mut count = 0usize;
        for byte in value.bytes() {
            self.work.checkpoint(self.cancel).await?;
            // Rust strings are valid UTF-8. C/POSIX count every byte.
            count += usize::from(!utf8 || byte & 0xc0 != 0x80);
        }
        Ok(count)
    }

    async fn length(
        &mut self,
        name: &str,
        state: &SharedState,
        protected: bool,
        depth: usize,
    ) -> Result<(), Error> {
        if let Some((array, index)) = indexed_name(name) {
            return self.indexed_length(array, index, state, protected).await;
        }
        if !operand::length_name(name) || depth >= operand::MAX_DEPTH {
            return Err(2.into());
        }
        self.work.checkpoint(self.cancel).await?;
        self.require_bound(name, state).await?;
        let (value, utf8) = {
            let s = state.borrow();
            // Admit the transient snapshot before copying, independently of the
            // much smaller decimal result. No state borrow crosses counting.
            if s.dynamic_parameter(name) {
                self.work.admit_storage(State::DYNAMIC_PARAMETER_BYTES)?;
            }
            let value = bounded(
                s.parameter(name),
                self.raw_remaining.min(self.work.remaining),
            )?;
            let locale = ["LC_ALL", "LC_CTYPE", "LANG"]
                .iter()
                .filter_map(|name| s.bindings().get(*name))
                .find(|value| !value.is_empty());
            (value, locale.is_some_and(|value| utf8_locale(value)))
        };
        let count = self.character_count(&value, utf8).await?;
        if self.pattern_snapshots {
            self.work.admit_storage(20)?;
        }
        self.segment(
            &count.to_string(),
            Protection::expansion(protected, state),
            protected,
        )
        .await
    }
    async fn parameter(
        &mut self,
        name: &str,
        operator: &ParameterOp,
        operand: &str,
        colon: bool,
        context: OperandContext<'_>,
        error_pointer: Option<&str>,
    ) -> Result<(), Error> {
        let OperandContext {
            state,
            quoted,
            scalar,
            depth,
        } = context;
        self.slice_boundaries(operand).await?;
        let supported_name = operand::parameter_name(name)
            || operand::indirect_operator(operator) && matches!(name, "@" | "*");
        if error_pointer.is_none() && !supported_name || depth >= operand::MAX_DEPTH {
            return Err(2.into());
        }
        if matches!(name, "@" | "*") && operand::indirect_operator(operator) {
            return self
                .part_frame(|expansion| {
                    expansion.positional_parameter(name, operator, operand, colon, context)
                })
                .await;
        }
        // These operators read their source value, unlike the four lazy
        // presence-testing operators below. Check before operand side effects.
        if trim_mode(operator).is_some()
            || case_mode(operator).is_some()
            || matches!(
                operator,
                ParameterOp::ReplaceFirst { .. } | ParameterOp::ReplaceAll { .. }
            )
        {
            self.require_bound(name, state).await?;
        }
        if let ParameterOp::ReplaceFirst {
            pattern,
            replacement,
        }
        | ParameterOp::ReplaceAll {
            pattern,
            replacement,
        } = operator
        {
            if name == "PIPESTATUS" {
                return Err(2.into());
            }
            return self
                .replace(
                    name,
                    pattern,
                    replacement,
                    matches!(operator, ParameterOp::ReplaceAll { .. }),
                    TransformContext {
                        state,
                        protected: scalar || quoted,
                        depth,
                    },
                )
                .await;
        }
        if let Some((prefix, longest)) = trim_mode(operator) {
            return self
                .trim(
                    name,
                    operand,
                    TransformContext {
                        state,
                        protected: scalar || quoted,
                        depth,
                    },
                    prefix,
                    longest,
                )
                .await;
        }
        if let Some((upper, all)) = case_mode(operator) {
            if name == "PIPESTATUS" {
                return Err(2.into());
            }
            return self
                .change_case(
                    name,
                    operand,
                    TransformContext {
                        state,
                        protected: scalar || quoted,
                        depth,
                    },
                    upper,
                    all,
                )
                .await;
        }
        let replacement = match operator {
            ParameterOp::UseDefault => false,
            ParameterOp::UseReplacement => true,
            ParameterOp::AssignDefault | ParameterOp::Error => false,
            _ => return Err(2.into()),
        };
        State::admit_scalar_access(state, name, self.cancel, self.work).await?;
        let absent = {
            let s = state.borrow();
            !s.dynamic_parameter(name)
                && s.scalar_parameter(name)
                    .is_none_or(|v| colon && v.is_empty())
        };
        if absent && matches!(operator, ParameterOp::AssignDefault | ParameterOp::Error) {
            return self
                .effect_operand(name, operator, operand, colon, context, error_pointer)
                .await;
        }
        if replacement != absent {
            return self
                .operand(operand, state, quoted, scalar, depth + 1, false)
                .await;
        }
        let max = self.snapshot_max();
        let value = if replacement {
            String::new()
        } else {
            let s = state.borrow();
            parameter_snapshot(&s, name, max, self.pattern_snapshots, self.work)?
        };
        self.admit_pattern_snapshot(&value).await?;
        self.segment(
            &value,
            Protection::expansion(scalar || quoted, state),
            scalar || quoted,
        )
        .await
    }
    async fn trim(
        &mut self,
        name: &str,
        source: &str,
        context: TransformContext<'_>,
        prefix: bool,
        longest: bool,
    ) -> Result<(), Error> {
        let TransformContext {
            state,
            protected,
            depth,
        } = context;
        self.work.checkpoint(self.cancel).await?;
        // Resolve before operand side effects. Admit storage and work before
        // snapshotting, and release the state borrow before any suspension.
        let value = {
            let s = state.borrow();
            let max = self.raw_remaining.min(self.work.remaining);
            parameter_snapshot(&s, name, max, true, self.work)?
        };
        // Bash does not evaluate a trim pattern for an unset or empty scalar.
        if value.is_empty() {
            return self.empty_expansion(protected, state).await;
        }
        self.scan_value(&value).await?;
        let mut pattern = self.pattern_operand(source, state, depth).await?;
        let result = pattern
            .remove(&value, prefix, longest, self.work, self.cancel)
            .await?;
        self.segment(result, Protection::expansion(protected, state), protected)
            .await
    }
    async fn pattern_operand(
        &mut self,
        source: &str,
        state: &SharedState,
        depth: usize,
    ) -> Result<pattern::Pattern, Error> {
        let capacity = self.raw_remaining;
        let mut child = Expansion {
            segments: Segments::default(),
            captured: None,
            pattern: Some(pattern::Pattern::default()),
            replacement: None,
            pattern_context: true,
            pattern_snapshots: true,
            admit_frames: self.admit_frames,
            ifs: None,
            ifs_changed: false,
            work: self.work,
            cancel: self.cancel,
            max_raw: capacity,
            raw_remaining: capacity,
            elements_remaining: self.elements_remaining,
        };
        // A transformation pattern has its own quote context. Outer quotes protect
        // only its returned value; quotes inside protect pattern characters.
        child
            .operand(source, state, false, false, depth + 1, true)
            .await?;
        self.raw_remaining -= capacity - child.raw_remaining;
        let ifs_changed = child.ifs_changed;
        let replacement_output = child.segments.account_storage;
        let pattern = child.pattern.take().ok_or(2)?;
        drop(child);
        if replacement_output {
            self.admit_replacement_output().await?;
        }
        self.ifs_changed |= ifs_changed;
        if ifs_changed {
            self.ifs = None;
        }
        Ok(pattern)
    }
    async fn change_case(
        &mut self,
        name: &str,
        source: &str,
        context: TransformContext<'_>,
        upper: bool,
        all: bool,
    ) -> Result<(), Error> {
        let TransformContext {
            state,
            protected,
            depth,
        } = context;
        self.work.checkpoint(self.cancel).await?;
        let (value, present) = {
            let s = state.borrow();
            let present = s.scalar_is_set(name);
            let value = parameter_snapshot(
                &s,
                name,
                self.raw_remaining.min(self.work.remaining),
                true,
                self.work,
            )?;
            (value, present)
        };
        if !present {
            return self.empty_expansion(protected, state).await;
        }
        self.scan_value(&value).await?;
        let mut pattern = self.pattern_operand(source, state, depth).await?;
        let locale = Locale::from_state(&state.borrow())?;
        let result = pattern
            .change_case(
                &value,
                (upper, all),
                locale,
                self.raw_remaining,
                self.work,
                self.cancel,
            )
            .await?;
        self.segment(&result, Protection::expansion(protected, state), protected)
            .await
    }
    async fn effect_operand(
        &mut self,
        name: &str,
        operator: &ParameterOp,
        source: &str,
        colon: bool,
        context: OperandContext<'_>,
        error_pointer: Option<&str>,
    ) -> Result<(), Error> {
        let OperandContext {
            state,
            quoted,
            scalar,
            depth,
        } = context;
        // Bash rejects a direct special target before expanding its operand;
        // an indirect target is only checked after the operand expands.
        let direct_special = matches!(operator, ParameterOp::AssignDefault)
            && error_pointer.is_none()
            && !operand::scalar_name(name);
        if direct_special {
            return self.special_assignment(name);
        }
        // Reserve target/diagnostic bytes before copying either name or value.
        let diagnostic_bytes =
            error_pointer.map_or(name.len(), |pointer| pointer.len().saturating_add(1));
        let overhead = if matches!(operator, ParameterOp::Error) {
            diagnostic_bytes.saturating_add(96)
        } else {
            name.len()
        };
        let max_bytes = self.raw_remaining;
        self.work.admit_storage(overhead)?;
        let capacity = max_bytes.min(self.work.storage_remaining);
        let mut child = Expansion {
            segments: Segments {
                account_storage: self.segments.account_storage
                    || matches!(operator, ParameterOp::Error),
                ..Segments::default()
            },
            captured: (!matches!(operator, ParameterOp::Error)).then_some(Captured {
                value: String::new(),
                max_bytes: capacity,
            }),
            pattern: None,
            replacement: None,
            // Diagnostics leave the pattern context, including in nested operands.
            pattern_context: self.pattern_context && !matches!(operator, ParameterOp::Error),
            // Ordinary diagnostics also retain segments/output while snapshotting.
            pattern_snapshots: self.pattern_snapshots || matches!(operator, ParameterOp::Error),
            admit_frames: self.admit_frames,
            ifs: None,
            ifs_changed: false,
            work: self.work,
            cancel: self.cancel,
            max_raw: capacity,
            raw_remaining: capacity,
            elements_remaining: self.elements_remaining,
        };
        if matches!(operator, ParameterOp::Error) {
            let value = child.diagnostic_operand(source, state, depth + 1).await?;
            self.raw_remaining -= capacity - child.raw_remaining;
            drop(child);
            let message = if source.is_empty() {
                if colon {
                    "parameter null or not set"
                } else {
                    "parameter not set"
                }
                .to_owned()
            } else {
                value
            };
            return Err(Error::Parameter {
                line: None,
                name: error_pointer
                    .map_or_else(|| name.to_owned(), |pointer| format!("!{pointer}")),
                message,
            });
        }
        child
            .operand(source, state, quoted, scalar, depth + 1, false)
            .await?;
        self.raw_remaining -= capacity - child.raw_remaining;
        let ifs_changed = child.ifs_changed;
        let replacement_output = child.segments.account_storage;
        let captured = child.captured.take().ok_or(2)?;
        drop(child);
        if replacement_output {
            self.admit_replacement_output().await?;
        }
        if !operand::scalar_name(name) {
            return self.special_assignment(name);
        }
        admit_assignment(state, name, captured.value.len(), self.cancel, self.work).await?;
        State::admit_scalar_access(state, "IFS", self.cancel, self.work).await?;
        let ifs_changed = ifs_changed || state.borrow().shares_scalar_binding(name, "IFS")?;
        self.work.admit_storage(captured.value.len())?;
        // A prefix frame may also retain the durable value it will restore.
        if state.borrow().prefix_saved(name) {
            self.work
                .admit_storage(name.len().saturating_add(captured.value.len()))?;
        }
        let assigned = state
            .borrow_mut()
            .assign_parameter(name.to_owned(), captured.value.clone());
        if assigned.is_err() {
            self.work
                .admit_storage(name.len().saturating_mul(2).saturating_add(160))?;
            return Err(Error::Readonly {
                name: name.to_owned(),
                line: None,
                expansion: true,
            });
        }
        self.ifs_changed |= ifs_changed;
        if ifs_changed {
            self.ifs = None;
        }
        self.emit(
            &captured.value,
            Protection::expansion(scalar || quoted, state),
            scalar || quoted,
        )
        .await
    }
    fn special_assignment(&mut self, name: &str) -> Result<(), Error> {
        self.work
            .admit_storage(name.len().saturating_mul(2).saturating_add(128))?;
        Err(Error::SpecialAssignment {
            name: format!("${name}"),
            line: None,
        })
    }
    async fn diagnostic_operand(
        &mut self,
        source: &str,
        state: &SharedState,
        depth: usize,
    ) -> Result<String, Error> {
        // Bash expands error text independently of the surrounding context.
        // Direct literals retain whitespace; unquoted expansions split on IFS.
        if source.is_empty() {
            self.work.checkpoint(self.cancel).await?;
            return Ok(String::new());
        }
        let mut scanner = operand::Scanner::new(source, false, false, false);
        while let Some(piece) = scanner.next(self.work, self.cancel).await? {
            if let operand::Piece::Text { value, protected } = piece {
                self.literal(value, state, protected).await?;
                continue;
            }
            self.operand_piece(piece, state, false, false, depth)
                .await?;
        }
        self.current_ifs(state).await?;
        std::mem::take(&mut self.segments)
            .join(
                self.ifs.take().ok_or(2)?,
                self.max_raw,
                self.work.fields_remaining,
                self.work,
                self.cancel,
            )
            .await
    }
    async fn operand(
        &mut self,
        source: &str,
        state: &SharedState,
        quoted: bool,
        scalar: bool,
        depth: usize,
        pattern_source: bool,
    ) -> Result<(), Error> {
        let mut scanner =
            operand::Scanner::new(source, quoted, self.pattern_context, pattern_source);
        while let Some(piece) = scanner.next(self.work, self.cancel).await? {
            self.operand_piece(piece, state, quoted, scalar, depth)
                .await?;
        }
        // An outer quoted expansion exists even when its selected operand is empty.
        self.segment("", Protection::None, scalar || quoted).await
    }
    async fn operand_piece(
        &mut self,
        piece: operand::Piece<'_>,
        state: &SharedState,
        quoted: bool,
        scalar: bool,
        depth: usize,
    ) -> Result<(), Error> {
        if !scalar && !quoted {
            Ifs::admit_access(state, self.cancel, self.work).await?;
        }
        match piece {
            operand::Piece::Text { value, protected } => {
                self.segment(
                    value,
                    Protection::expansion(scalar || quoted || protected, state),
                    scalar || quoted || protected,
                )
                .await
            }
            operand::Piece::Expansion { part, protected } => {
                self.part(&part, state, quoted || protected, scalar, depth)
                    .await
            }
            operand::Piece::Positional { at, protected } => {
                self.case_positionals(state, at, protected).await
            }
        }
    }
    async fn separator(&mut self, ch: Option<char>, protected: bool) -> Result<(), Error> {
        if let Some(ch) = ch {
            let protection = if protected {
                Protection::All
            } else {
                Protection::None
            };
            self.segment(ch.encode_utf8(&mut [0; 4]), protection, false)
                .await?;
        }
        Ok(())
    }
    async fn elements(
        &mut self,
        part: &WordPart,
        state: &SharedState,
        quoted: bool,
        scalar: bool,
    ) -> Result<(), Error> {
        if let WordPart::ArrayIndices { name, .. } | WordPart::ArrayAccess { name, .. } = part {
            State::admit_scalar_access(state, name, self.cancel, self.work).await?;
        }
        let (count, at) = {
            let s = state.borrow();
            match part {
                WordPart::Variable(name) => (s.positional().len(), name == "@"),
                WordPart::ArrayIndices { name, star } => (indices::count(&s, name), !star),
                WordPart::ArrayAccess { name, index } => (
                    if name == "PIPESTATUS" {
                        s.pipeline_status().len()
                    } else {
                        s.array_count(name)
                    },
                    index == "@",
                ),
                _ => return Err(2.into()),
            }
        };
        if count > self.elements_remaining {
            return Err(2.into());
        }
        self.elements_remaining -= count;
        let source = match part {
            WordPart::Variable(_) => ListSource::Positional,
            WordPart::ArrayIndices { .. } => ListSource::Indices,
            _ => ListSource::Array,
        };
        let (list, separator) = self
            .element_layout(source, at, state, quoted, scalar)
            .await?;
        let protection = Protection::expansion(quoted || scalar, state);
        let mut array_index = None;
        for index in 0..count {
            self.element_boundary(index, list, separator, quoted || scalar)
                .await?;
            if let WordPart::ArrayIndices { name, .. } = part {
                State::admit_scalar_access(state, name, self.cancel, self.work).await?;
            }
            let value = list_value(
                part,
                state,
                index,
                &mut array_index,
                self.raw_remaining,
                self.work,
            )?;
            self.segment(&value, protection, quoted || scalar).await?;
        }
        Ok(())
    }
    async fn element_layout(
        &mut self,
        source: ListSource,
        at: bool,
        state: &SharedState,
        quoted: bool,
        scalar: bool,
    ) -> Result<(bool, Option<char>), Error> {
        let ifs_separator = self.ifs_separator(state).await?;
        let star_separator = if at {
            ifs_separator
        } else {
            self.positional_star_separator(state).await?
        };
        let indices_space_join = !scalar
            && !quoted
            && matches!(source, ListSource::Indices)
            && !at
            && ifs_separator.is_none();
        let list = !scalar && (at || !quoted && !indices_space_join);
        self.segments.needs_split |= list || indices_space_join;
        // An initially empty IFS selects Bash's list-word space path. A
        // nonempty reference IFS whose target later becomes empty does not.
        let reference_ifs = state.borrow().is_nameref("IFS");
        self.segments.list_word |= list && (at || !reference_ifs || star_separator.is_none());
        self.segments.split_space |= !scalar
            && !quoted
            && !at
            && matches!(source, ListSource::Positional)
            && star_separator.is_none();
        let separator = if scalar && at || indices_space_join {
            Some(' ')
        } else if list {
            ifs_separator.or(Some(' '))
        } else {
            star_separator
        };
        // Quoted '*' and every scalar context keep one field even for no values.
        if scalar || (quoted && !at) {
            self.segments.empty(self.work)?;
        }
        Ok((list, separator))
    }
    async fn element_boundary(
        &mut self,
        index: usize,
        list: bool,
        separator: Option<char>,
        protected: bool,
    ) -> Result<(), Error> {
        self.work.checkpoint(self.cancel).await?;
        if index == 0 {
            return Ok(());
        }
        if list {
            let ch = separator.ok_or(2)?;
            self.admit_raw(ch.len_utf8())?;
            self.segments.admit_slot(self.work)?;
            self.segments.parts.push(Segment::ListSeparator(ch));
            return Ok(());
        }
        self.separator(separator, protected).await
    }
}

enum ListSource {
    Positional,
    Indices,
    Array,
}

fn case_mode(operator: &ParameterOp) -> Option<(bool, bool)> {
    match operator {
        ParameterOp::UpperFirst => Some((true, false)),
        ParameterOp::UpperAll => Some((true, true)),
        ParameterOp::LowerFirst => Some((false, false)),
        ParameterOp::LowerAll => Some((false, true)),
        _ => None,
    }
}

fn trim_mode(operator: &ParameterOp) -> Option<(bool, bool)> {
    match operator {
        ParameterOp::RemovePrefixShort => Some((true, false)),
        ParameterOp::RemovePrefixLong => Some((true, true)),
        ParameterOp::RemoveSuffixShort => Some((false, false)),
        ParameterOp::RemoveSuffixLong => Some((false, true)),
        _ => None,
    }
}

fn utf8_locale(locale: &str) -> bool {
    // Recognize UTF-8 codeset suffixes without scanning or copying an arbitrary
    // locale value. C/POSIX, empty and other locales use the C byte-count path.
    locale
        .get(locale.len().saturating_sub(6)..)
        .is_some_and(|suffix| suffix.eq_ignore_ascii_case(".UTF-8"))
        || locale
            .get(locale.len().saturating_sub(5)..)
            .is_some_and(|suffix| suffix.eq_ignore_ascii_case(".UTF8"))
}

// Dynamic values must be admitted before formatting, rather than measuring
// an already allocated clock string. Ordinary borrowed scalars keep exact size.
fn parameter_snapshot(
    state: &State,
    name: &str,
    max: usize,
    admitted: bool,
    work: &mut Work,
) -> Result<String, Error> {
    if state.dynamic_parameter(name) {
        work.admit_storage(State::DYNAMIC_PARAMETER_BYTES)?;
        return bounded(state.parameter(name), max);
    }
    let value = state.scalar_parameter(name).unwrap_or("");
    if admitted {
        work.admit_storage(value.len())?;
    }
    bounded(Cow::Borrowed(value), max)
}

fn substring_snapshot(
    state: &crate::state::State,
    name: &str,
    max: usize,
    work: &mut Work,
) -> Result<String, Error> {
    if state.dynamic_parameter(name) {
        return parameter_snapshot(state, name, max, true, work);
    }
    let size = match name {
        "?" => {
            state.status().unsigned_abs().checked_ilog10().unwrap_or(0) as usize
                + 1
                + usize::from(state.status() < 0)
        }
        "#" => state.positional().len().checked_ilog10().unwrap_or(0) as usize + 1,
        _ => state.parameter(name).len(),
    };
    if size > max {
        return Err(2.into());
    }
    work.admit_storage(size)?;
    Ok(state.parameter(name).into_owned())
}

fn bounded(value: Cow<'_, str>, max: usize) -> Result<String, Error> {
    if value.len() > max {
        return Err(2.into());
    }
    Ok(value.into_owned())
}
fn shell_parser_budget_error(error: &shell_parser::error::Error) -> bool {
    matches!(error, shell_parser::error::Error::ResourceLimit(_))
}

fn scalar_value(
    part: &WordPart,
    state: &SharedState,
    max: usize,
    mut snapshot_work: Option<&mut Work>,
) -> Result<String, Error> {
    let s = state.borrow();
    let formatted = matches!(part, WordPart::ArrayAccess { name, .. } if name == "PIPESTATUS");
    if formatted && let Some(work) = snapshot_work.as_deref_mut() {
        work.admit_storage(20)?;
    }
    let value = match part {
        WordPart::Literal(text) => Cow::Borrowed(text.as_str()),
        WordPart::ArrayAccess { name, index } if name == "PIPESTATUS" => Cow::Owned(
            index
                .parse::<usize>()
                .ok()
                .and_then(|i| s.pipeline_status().get(i))
                .map(i32::to_string)
                .unwrap_or_default(),
        ),
        _ => return Err(2.into()),
    };
    if !formatted && let Some(work) = snapshot_work {
        work.admit_storage(value.len())?;
    }
    bounded(value, max)
}
fn list_value(
    part: &WordPart,
    state: &SharedState,
    index: usize,
    array_index: &mut Option<i64>,
    max: usize,
    work: &mut Work,
) -> Result<String, Error> {
    let s = state.borrow();
    let value = match part {
        WordPart::Variable(_) => s.positional().get(index).map(String::as_str).unwrap_or(""),
        WordPart::ArrayIndices { name, .. } => {
            return indices::value(&s, name, index, array_index, max, work);
        }
        WordPart::ArrayAccess { name, .. } if name != "PIPESTATUS" => {
            let (next, value) = s.array_next(name, *array_index).ok_or(2)?;
            *array_index = Some(next);
            value
        }
        WordPart::ArrayAccess { .. } => {
            work.admit_storage(20)?;
            return bounded(
                Cow::Owned(
                    s.pipeline_status()
                        .get(index)
                        .map(i32::to_string)
                        .unwrap_or_default(),
                ),
                max,
            );
        }
        _ => return Err(2.into()),
    };
    if value.len() > max {
        return Err(2.into());
    }
    work.admit_storage(value.len())?;
    bounded(Cow::Borrowed(value), max)
}
fn is_list(part: &WordPart) -> bool {
    match part {
        WordPart::Variable(name) => matches!(name.as_str(), "@" | "*"),
        WordPart::ArrayIndices { .. } => true,
        WordPart::ArrayAccess { index, .. } => matches!(index.as_str(), "@" | "*"),
        _ => false,
    }
}

fn part_quoted(word: &Word, index: usize, has_part_quotes: bool) -> bool {
    if has_part_quotes {
        return word.part_quoted.get(index).copied().unwrap_or(false);
    }
    word.quoted
}

async fn expand_one(
    word: &Word,
    state: &SharedState,
    cancel: &Cancel,
    options: ExpansionOptions,
    raw_remaining: &mut usize,
    work: &mut Work,
) -> Result<Vec<String>, Error> {
    let ExpansionOptions {
        max_bytes,
        max_fields,
        max_raw,
        scalar,
        pathname,
        admitted,
        tilde,
    } = options;
    let mut expansion = Expansion {
        segments: Segments {
            account_storage: admitted,
            ..Segments::default()
        },
        captured: None,
        pattern: None,
        replacement: None,
        pattern_context: false,
        pattern_snapshots: admitted,
        admit_frames: admitted,
        ifs: None,
        ifs_changed: false,
        work,
        cancel,
        max_raw,
        raw_remaining: *raw_remaining,
        elements_remaining: max_raw.saturating_add(max_fields),
    };
    if scalar {
        expansion.segments.empty(expansion.work)?;
    }
    let mut has_part_quotes = false;
    for &quoted in &word.part_quoted {
        expansion.work.checkpoint(cancel).await?;
        has_part_quotes |= quoted;
    }
    let tildes =
        tilde::WordTildes::new(word, scalar, tilde, has_part_quotes, &mut expansion).await?;
    for (index, part) in word.parts.iter().enumerate() {
        expansion.work.checkpoint(cancel).await?;
        let quoted = part_quoted(word, index, has_part_quotes);
        if is_list(part) {
            expansion.elements(part, state, quoted, scalar).await?;
            continue;
        }
        if matches!(part, WordPart::Literal(_)) {
            tildes.literal(&mut expansion, index, state).await?;
            continue;
        }
        expansion.part(part, state, quoted, scalar, 0).await?;
    }
    *raw_remaining = expansion.raw_remaining;
    expansion.current_ifs(state).await?;
    let ifs = expansion.ifs.take().ok_or(2)?;
    let pathname =
        pathname && !scalar && expansion.work.substitutions.is_some() && !state.borrow().noglob;
    let mut fields = Fields::new(max_bytes, max_fields);
    fields.pathname = pathname;
    fields.extglob_groups = pathname && admitted && state.borrow().extglob;
    let fields = expansion
        .segments
        .collect(ifs, fields, expansion.work, cancel)
        .await?;
    if !pathname {
        return Ok(fields.out);
    }
    let Fields {
        out,
        protections,
        current_runs,
        account_storage,
        ..
    } = fields;
    if account_storage {
        let spare = current_runs.capacity() * std::mem::size_of::<(usize, bool)>();
        drop(current_runs);
        expansion.work.release_storage(spare);
    }
    let candidates = glob::Candidates {
        fields: out,
        patterns: protections,
        admitted: account_storage,
    };
    glob::expand_fields(
        candidates,
        state,
        (max_bytes, max_fields),
        raw_remaining,
        expansion.work,
        cancel,
    )
    .await
}

async fn expand(
    word: &Word,
    state: &SharedState,
    cancel: &Cancel,
    options: ExpansionOptions,
    work: &mut Work,
) -> Result<Vec<String>, Error> {
    let ExpansionOptions {
        max_bytes,
        max_fields,
        max_raw,
        scalar,
        ..
    } = options;
    let variants = if scalar || !braces::has_candidate(word) {
        None
    } else {
        braces::variants(word, max_fields.max(1), work, cancel).await?
    };
    let mut raw_remaining = max_raw;
    let Some(variants) = variants else {
        return expand_one(word, state, cancel, options, &mut raw_remaining, work).await;
    };
    let mut values = Vec::new();
    // Usually one field per spelling; more fields still grow by doubling.
    admit_vec_exact(&mut values, variants.len().min(max_fields), work)?;
    let mut bytes_remaining = max_bytes;
    // The generated spellings move into `values`; their vector is freed below.
    let spelling_slots = variants
        .capacity()
        .saturating_mul(std::mem::size_of::<String>());
    for variant in variants {
        work.checkpoint(cancel).await?;
        if variant.is_empty() {
            continue;
        }
        if plain_literal(&variant, work, cancel).await? {
            // One field, exactly as the reparse would produce it. The variant
            // was already admitted when it was generated; only its output and
            // argument slot are new.
            raw_remaining = raw_remaining.checked_sub(variant.len()).ok_or(2)?;
            bytes_remaining = bytes_remaining.checked_sub(variant.len()).ok_or(2)?;
            if values.len() >= max_fields {
                return Err(2.into());
            }
            admit_vec_slot(&mut values, work)?;
            values.push(variant);
            continue;
        }
        work.admit_parse(variant.len(), cancel).await?;
        // Text copies and lexical metadata scale with bytes; AST vectors scale
        // with syntax, not text length. Alternating `a\\a` creates two 112-byte
        // WordParts per escape on native, whose doubled vector capacity alone
        // exceeds 128 * source bytes. Count potential part/command boundaries
        // cooperatively; four slots allow two parts and geometric Vec growth.
        // Command/Word slots also cover parsed (but unsupported) substitutions.
        let mut syntax = 0usize;
        for ch in variant.chars() {
            work.checkpoint(cancel).await?;
            if ch.is_whitespace()
                || matches!(
                    ch,
                    '$' | '\\'
                        | '\''
                        | '"'
                        | '`'
                        | '<'
                        | '>'
                        | '('
                        | ')'
                        | ';'
                        | '|'
                        | '&'
                        | '\0'
                        | '\u{1e}'
                        | '\u{1f}'
                )
            {
                syntax = syntax.saturating_add(1);
            }
        }
        let slot = std::mem::size_of::<WordPart>()
            .saturating_add(std::mem::size_of::<Word>())
            .saturating_add(std::mem::size_of::<shell_parser::parser::Command>());
        work.admit_storage(
            variant
                .len()
                .saturating_mul(128)
                .saturating_add(syntax.saturating_mul(4).saturating_mul(slot))
                .saturating_add(512),
        )?;
        let parsed = crate::parse::generated_word(&variant).map_err(|error| match error {
            shell_parser::Error::ResourceLimit(_) => Error::Status(2),
            _ => Error::BadSubstitution {
                message: "invalid generated word",
                line: None,
            },
        })?;
        let expanded = expand_one(
            &parsed,
            state,
            cancel,
            ExpansionOptions {
                max_bytes: bytes_remaining,
                max_fields: max_fields.saturating_sub(values.len()),
                tilde: tilde::Context::Generated,
                ..options
            },
            &mut raw_remaining,
            work,
        )
        .await?;
        for value in expanded {
            bytes_remaining = bytes_remaining.checked_sub(value.len()).ok_or(2)?;
            admit_vec_slot(&mut values, work)?;
            values.push(value);
        }
    }
    work.release_storage(spelling_slots);
    Ok(values)
}

/// A brace variant made only of characters with no meaning to the parser or
/// to later expansion (no quotes, expansions, operators, blanks, globs, tilde
/// or braces) is its own single field; it needs no reparse.
async fn plain_literal(variant: &str, work: &mut Work, cancel: &Cancel) -> Result<bool, Error> {
    for ch in variant.chars() {
        work.checkpoint(cancel).await?;
        if !(ch.is_alphanumeric()
            || matches!(
                ch,
                '_' | '-' | '.' | ',' | '/' | '+' | ':' | '=' | '@' | '%' | '^'
            ))
        {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Textual expansion precedes arithmetic parsing, even in skipped branches.
/// Capture is bounded and storage-admitted, without charging its bytes as the
/// enclosing expansion's output. Nested arithmetic shares this command's Work.
pub(crate) async fn arithmetic_text(
    source: &str,
    state: &SharedState,
    cancel: &Cancel,
    max: usize,
    work: &mut Work,
) -> Result<String, Error> {
    let mut expansion = Expansion {
        segments: Segments {
            account_storage: true,
            ..Segments::default()
        },
        captured: Some(Captured {
            value: String::new(),
            max_bytes: max,
        }),
        pattern: None,
        replacement: None,
        pattern_context: true,
        pattern_snapshots: true,
        admit_frames: true,
        ifs: None,
        ifs_changed: false,
        work,
        cancel,
        max_raw: max,
        raw_remaining: max,
        elements_remaining: max,
    };
    let mut scanner = operand::Scanner::arithmetic(source);
    while let Some(piece) = scanner.next(expansion.work, expansion.cancel).await? {
        expansion.operand_piece(piece, state, true, true, 0).await?;
    }
    expansion.segment("", Protection::None, true).await?;
    Ok(expansion.captured.take().ok_or(2)?.value)
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum FieldContext {
    Argv,
    ForList,
    Completion,
}

pub(crate) async fn fields(
    word: &Word,
    state: &SharedState,
    cancel: &Cancel,
    context: FieldContext,
    limits: (usize, usize, usize),
    work: &mut Work,
) -> Result<Vec<String>, Error> {
    if context == FieldContext::ForList {
        work.checkpoint(cancel).await?;
    }
    if context != FieldContext::Completion {
        work.fields_remaining = work.fields_remaining.min(limits.1);
    }
    let values = expand(
        word,
        state,
        cancel,
        ExpansionOptions {
            max_bytes: limits.0,
            max_fields: limits.1,
            max_raw: limits.2,
            scalar: false,
            pathname: context != FieldContext::Completion,
            admitted: context != FieldContext::Argv,
            tilde: tilde::Context::Word,
        },
        work,
    )
    .await?;
    if context != FieldContext::Completion {
        work.fields_remaining = work.fields_remaining.saturating_sub(values.len());
    }
    Ok(values)
}

/// Assignments and redirects are scalar contexts, distinct from argv fields.
/// '$@' joins with spaces here; '$*' uses the first IFS character.
pub(crate) async fn word(
    word: &Word,
    state: &SharedState,
    cancel: &Cancel,
    max: usize,
    max_raw: usize,
    work: &mut Work,
) -> Result<String, Error> {
    scalar_word(
        word,
        state,
        cancel,
        max,
        max_raw,
        tilde::Context::Word,
        work,
    )
    .await
}

async fn scalar_word(
    word: &Word,
    state: &SharedState,
    cancel: &Cancel,
    max: usize,
    max_raw: usize,
    tilde: tilde::Context,
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
            pathname: false,
            admitted: false,
            tilde,
        },
        work,
    )
    .await?;
    Ok(values.into_iter().next().unwrap_or_default())
}

/// Original fully storage-admitted scalar context for conditional operands.
/// Capture directly into one bounded string: no field vector, splitting,
/// pathname expansion, brace variants, or uncharged transient snapshots.
pub(crate) async fn conditional_word(
    word: &Word,
    state: &SharedState,
    cancel: &Cancel,
    max: usize,
    work: &mut Work,
) -> Result<String, Error> {
    work.checkpoint(cancel).await?;
    let mut expansion = Expansion {
        segments: Segments {
            account_storage: true,
            ..Segments::default()
        },
        captured: Some(Captured {
            value: String::new(),
            max_bytes: max,
        }),
        pattern: None,
        replacement: None,
        pattern_context: false,
        pattern_snapshots: true,
        admit_frames: true,
        ifs: None,
        ifs_changed: false,
        work,
        cancel,
        max_raw: max,
        raw_remaining: max,
        elements_remaining: max,
    };
    let mut has_part_quotes = false;
    for &quoted in &word.part_quoted {
        expansion.work.checkpoint(cancel).await?;
        has_part_quotes |= quoted;
    }
    for (index, part) in word.parts.iter().enumerate() {
        expansion.work.checkpoint(cancel).await?;
        let quoted = part_quoted(word, index, has_part_quotes);
        if is_list(part) {
            expansion.elements(part, state, quoted, true).await?;
        } else if let WordPart::Literal(value) = part {
            expansion.literal(value, state, true).await?;
        } else {
            expansion.part(part, state, quoted, true, 0).await?;
        }
    }
    Ok(expansion.captured.take().ok_or(2)?.value)
}

/// Expand one case-pattern word while retaining the quote protection that the
/// bounded glob matcher needs. Raw parser spelling is required: Display cannot
/// reconstruct the quote protection of a synthetic AST.
pub(crate) async fn pattern(
    word: &Word,
    state: &SharedState,
    cancel: &Cancel,
    max_raw: usize,
    work: &mut Work,
) -> Result<pattern::Pattern, Error> {
    pattern_with_positionals(word, state, cancel, max_raw, work, false).await
}

/// Original conditional-pattern adapter. Unlike case patterns, quoted `$@`
/// remains one scalar with spaces between all positional values.
pub(crate) async fn conditional_pattern(
    word: &Word,
    state: &SharedState,
    cancel: &Cancel,
    max_raw: usize,
    work: &mut Work,
) -> Result<pattern::Pattern, Error> {
    pattern_with_positionals(word, state, cancel, max_raw, work, true).await
}

async fn pattern_with_positionals(
    word: &Word,
    state: &SharedState,
    cancel: &Cancel,
    max_raw: usize,
    work: &mut Work,
    join_positionals: bool,
) -> Result<pattern::Pattern, Error> {
    work.checkpoint(cancel).await?;
    let source = word.raw.as_deref().ok_or(2)?;
    let mut expansion = Expansion {
        segments: Segments::default(),
        captured: None,
        pattern: Some(pattern::Pattern::with_options(
            join_positionals,
            state.borrow().extglob || join_positionals,
        )),
        replacement: None,
        pattern_context: true,
        pattern_snapshots: true,
        admit_frames: true,
        ifs: None,
        ifs_changed: false,
        work,
        cancel,
        max_raw,
        raw_remaining: max_raw,
        elements_remaining: max_raw,
    };
    let mut scanner = operand::Scanner::case_pattern(source);
    while let Some(piece) = scanner.next(expansion.work, cancel).await? {
        expansion
            .operand_piece(piece, state, false, false, 0)
            .await?;
    }
    expansion.pattern.take().ok_or(2.into())
}

fn indexed_name(name: &str) -> Option<(&str, &str)> {
    let (name, index) = name.split_once('[')?;
    Some((name, index.strip_suffix(']')?))
}

#[cfg(test)]
fn poll_argv(
    word: &Word,
    state: &SharedState,
    cancel: &Cancel,
    limits: (usize, usize, usize),
    work: &mut Work,
) -> Option<Result<Vec<String>, Error>> {
    fields(word, state, cancel, FieldContext::Argv, limits, work).now_or_never()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_list_budgets(source: &str, state: &SharedState, expected: &[&str]) {
        let token = shell_parser::Parser::parse_word_string(source);
        for (steps, bytes, fields, raw, canceled, status) in [
            (0, 65536, 8, 64, false, 2),
            (4096, 0, 8, 64, false, 2),
            (4096, 65536, 0, 64, false, 2),
            (4096, 65536, 8, 0, false, 2),
            (4096, 65536, 8, 64, true, 130),
            (4096, 65536, 8, 64, false, 0),
        ] {
            let cancel = Cancel::new();
            if canceled {
                cancel.cancel();
            }
            let mut budget = Work::new(steps, bytes, fields);
            let expanded = fields_admitted(&token, state, &cancel, 64, fields, raw, &mut budget)
                .now_or_never()
                .expect("bounded list expansion must not suspend");
            assert_list_result(expanded, expected, status, source);
        }
    }

    fn assert_list_result(
        result: Result<Vec<String>, Error>,
        expected: &[&str],
        status: i32,
        source: &str,
    ) {
        match result {
            Ok(values) => {
                assert_eq!(status, 0, "{source}");
                assert_eq!(values, expected, "{source}");
            }
            Err(Error::Status(actual)) => assert_eq!(actual, status, "{source}"),
            Err(_) => panic!("unexpected expansion fault: {source}"),
        }
    }

    #[test]
    fn list_names_and_lazy_positionals_share_admission_and_cancellation() {
        let mut state = State::default();
        state
            .replace_positional(vec!["a".into(), "b".into()])
            .unwrap();
        state
            .assign_parameter("param_a".into(), "value".into())
            .unwrap();
        let state = state.shared();
        assert_list_budgets("${!param_@}", &state, &["param_a"]);
        assert_list_budgets("${@:-unused}", &state, &["a", "b"]);
    }

    #[test]
    fn pattern_frames_admit_actual_bytes_before_construction() {
        let bytes = std::mem::size_of::<std::future::Ready<Result<usize, Error>>>();
        let mut work = Work::new(8, bytes - 1, 1);
        let called = std::cell::Cell::new(false);
        let rejected = work.frame(|_| {
            called.set(true);
            std::future::ready(Ok(7usize))
        });
        assert!(matches!(
            rejected.now_or_never(),
            Some(Err(Error::Status(2)))
        ));
        assert!(!called.get());
        assert_eq!(work.storage_left(), bytes - 1);
        let mut work = Work::new(8, bytes, 1);
        assert!(matches!(
            work.frame(|_| std::future::ready(Ok(7usize)))
                .now_or_never(),
            Some(Ok(7))
        ));
        assert_eq!(work.storage_left(), 0);
    }

    #[test]
    fn pattern_frames_share_and_refund_live_execution_admission() {
        let execution = crate::exec::StorageBudget::new(4096);
        let scope =
            crate::exec::Scope::new(128, crate::exec::StorageBudget::new(128), execution.clone());
        let mut work = Work::new(8, 0, 1).with_frame_scope(scope.clone());
        let frame = work.frame(|_| std::future::pending::<Result<(), Error>>());
        assert!(scope.execution_available() < 4096);
        drop(frame);
        assert_eq!(scope.execution_available(), 4096);
        assert!(matches!(
            work.frame(|_| std::future::ready(Ok(7))).now_or_never(),
            Some(Ok(7))
        ));
        assert_eq!(scope.execution_available(), 4096);
        assert_eq!(work.storage_left(), 0);
    }

    #[test]
    fn admitted_fields_share_segment_output_and_slot_storage_without_changing_argv() {
        let state = State::default().shared();
        let cancel = Cancel::new();
        let word = Word::literal("abc");
        let storage = std::mem::size_of::<Segment>() + 8 + 8 + std::mem::size_of::<String>();
        for (bytes, accepted) in [(storage - 1, false), (storage, true)] {
            let mut work = Work::new(128, bytes, 1);
            let result = fields(
                &word,
                &state,
                &cancel,
                FieldContext::ForList,
                (16, 1, 16),
                &mut work,
            )
            .now_or_never()
            .expect("short literal must not suspend");
            if accepted {
                assert!(matches!(result, Ok(value) if value == ["abc"]));
                assert_eq!(work.storage_remaining, 0);
            } else {
                assert!(matches!(result, Err(Error::Status(2))));
            }
        }
        // Ordinary argv keeps its existing separate allocation accounting.
        let mut work = Work::new(128, 0, 1);
        assert!(
            matches!(poll_argv(&word, &state, &cancel, (16, 1, 16), &mut work), Some(Ok(value)) if value == ["abc"])
        );
    }

    #[test]
    fn admitted_fields_preserve_splitting_quotes_and_brace_reparse() {
        let state = State::default().shared();
        state
            .borrow_mut()
            .assign_parameter("v".into(), "one two".into())
            .unwrap();
        let cancel = Cancel::new();
        for source in ["$v", "\"$v\"", "{a,b}$v", "{a,b}\"$v\""] {
            let word = shell_parser::Parser::parse_word_string_with_limits(source, 16, 4096);
            let mut legacy = Work::new(65536, 1024 * 1024, 16);
            let expected = poll_argv(&word, &state, &cancel, (4096, 16, 4096), &mut legacy)
                .expect("short fixture must not suspend")
                .unwrap_or_else(|_| panic!("legacy fixture must expand: {source}"));
            let mut admitted = Work::new(65536, 1024 * 1024, 16);
            let actual = fields(
                &word,
                &state,
                &cancel,
                FieldContext::ForList,
                (4096, 16, 4096),
                &mut admitted,
            )
            .now_or_never()
            .expect("short fixture must not suspend")
            .unwrap_or_else(|_| panic!("admitted fixture must expand: {source}"));
            assert_eq!(actual, expected, "{source}");
            assert!(
                admitted.storage_remaining < legacy.storage_remaining,
                "{source}"
            );
        }
        cancel.cancel();
        let mut work = Work::new(128, 0, 1);
        assert!(matches!(
            fields(
                &Word::literal("abc"),
                &state,
                &cancel,
                FieldContext::ForList,
                (16, 1, 16),
                &mut work
            )
            .now_or_never(),
            Some(Err(Error::Status(130)))
        ));
    }

    #[test]
    fn conditional_capture_admits_storage_before_growing_and_keeps_empty_valid() {
        let state = State::default().shared();
        let cancel = Cancel::new();
        let word = Word::literal("abc");
        let mut work = Work::new(64, 7, 1);
        assert!(matches!(
            conditional_word(&word, &state, &cancel, 16, &mut work).now_or_never(),
            Some(Err(Error::Status(2)))
        ));
        assert_eq!(work.storage_remaining, 7);
        let mut work = Work::new(64, 8, 1);
        assert!(
            matches!(conditional_word(&word, &state, &cancel, 16, &mut work).now_or_never(), Some(Ok(value)) if value == "abc")
        );
        assert_eq!(work.storage_remaining, 0);
        let mut work = Work::new(64, 0, 1);
        assert!(
            matches!(conditional_word(&Word::literal(""), &state, &cancel, 16, &mut work).now_or_never(), Some(Ok(value)) if value.is_empty())
        );
        cancel.cancel();
        assert!(matches!(
            conditional_word(&word, &state, &cancel, 16, &mut work).now_or_never(),
            Some(Err(Error::Status(130)))
        ));
        assert_eq!(work.storage_remaining, 0);
    }

    #[test]
    fn ifs_snapshot_rejects_unadmitted_storage_before_owning_a_custom_value() {
        let state = State::default().shared();
        state
            .borrow_mut()
            .assign_parameter("IFS".into(), ":".into())
            .unwrap();
        let cancel = Cancel::new();
        let mut work = Work::new(64, 0, 1);
        assert!(matches!(
            Ifs::new(&state, &cancel, 64, &mut work).now_or_never(),
            Some(Err(Error::Status(2)))
        ));
        assert_eq!(state.borrow().scalar_parameter("IFS"), Some(":"));
    }

    #[test]
    fn reference_ifs_snapshots_admit_exact_peak_storage_and_duplicate_delimiters() {
        let node = (std::mem::size_of::<char>() + std::mem::size_of::<usize>()) * 16;
        for (value, peak, temporary) in [
            (None, 0, 0),
            (Some(""), 0, 0),
            (Some(" \t\n"), 0, 0),
            (Some(":"), 1, 1),
            (Some("::"), 2, 2),
            (Some("ç"), 2, 2),
            (Some("abcd"), 4 + node, 4),
            (Some("abcdd"), 5 + node, 5),
        ] {
            let state = State::default().shared();
            state
                .borrow_mut()
                .declare_nameref("IFS".into(), "sep".into(), false)
                .unwrap();
            if let Some(value) = value {
                state
                    .borrow_mut()
                    .assign_parameter("sep".into(), value.into())
                    .unwrap();
            }
            let cancel = Cancel::new();
            if peak != 0 {
                let mut small = Work::new(64, peak - 1, 1);
                assert!(matches!(
                    Ifs::new(&state, &cancel, 64, &mut small).now_or_never(),
                    Some(Err(Error::Status(2)))
                ));
            }
            let mut exact = Work::new(64, peak, 1);
            let ifs = Ifs::new(&state, &cancel, 64, &mut exact)
                .now_or_never()
                .expect("short IFS setup needs fewer than 64 checkpoints")
                .unwrap_or_else(|_| panic!("exact IFS admission fits"));
            assert_eq!(ifs.is_empty(), value == Some(""));
            assert_eq!(exact.storage_remaining, temporary);
        }
    }

    #[test]
    fn reference_ifs_raw_bounds_and_cancellation_do_not_mutate_the_binding() {
        let state = State::default().shared();
        state
            .borrow_mut()
            .declare_nameref("IFS".into(), "sep".into(), false)
            .unwrap();
        state
            .borrow_mut()
            .assign_parameter("sep".into(), ":".repeat(4096))
            .unwrap();
        let cancel = Cancel::new();
        let mut work = Work::new(16_384, 8192, 1);
        // Reference admission yields before the effective value's raw bound
        // is checked. Poll the finite operation without assuming readiness.
        let mut bounded = Box::pin(Ifs::new(&state, &cancel, 64, &mut work));
        let mut rejected = false;
        for _ in 0..512 {
            if let Some(result) = bounded.as_mut().now_or_never() {
                assert!(matches!(result, Err(Error::Status(2))));
                rejected = true;
                break;
            }
        }
        assert!(rejected, "bounded IFS read must reject its raw overflow");
        drop(bounded);
        assert_eq!(work.storage_remaining, 8192);
        let mut snapshot = Box::pin(Ifs::new(&state, &cancel, 4096, &mut work));
        assert!(snapshot.as_mut().now_or_never().is_none());
        assert!(state.try_borrow_mut().is_ok());
        cancel.cancel();
        assert!(matches!(
            snapshot.now_or_never(),
            Some(Err(Error::Status(130)))
        ));
        assert_eq!(
            state.borrow().scalar_parameter("IFS").map(str::len),
            Some(4096)
        );
        assert_eq!(state.borrow().namerefs()["IFS"], "sep");
    }

    #[test]
    fn nounset_admits_its_owned_diagnostic_at_the_exact_storage_boundary() {
        let state = crate::state::State::default().shared();
        state.borrow_mut().nounset = true;
        let token = shell_parser::Parser::parse_word_string_with_limits("$missing", 10, 1000);
        let storage = "missing".len() * 2 + 128;
        let cancel = Cancel::new();
        let mut work = Work::new(64, storage - 1, 1);
        assert!(matches!(
            poll_argv(&token, &state, &cancel, (64, 1, 64), &mut work),
            Some(Err(Error::Status(2))),
        ));
        let mut work = Work::new(64, storage, 1);
        assert!(matches!(
            poll_argv(&token, &state, &cancel, (64, 1, 64), &mut work),
            Some(Err(Error::Unbound { name, line: None })) if name == "missing",
        ));
        assert_eq!(work.storage_remaining, 0);
    }

    #[test]
    fn nounset_long_name_yields_and_cancels_before_owning_a_diagnostic() {
        let state = crate::state::State::default().shared();
        state.borrow_mut().nounset = true;
        let source = format!("${}", "v".repeat(1024));
        let token = shell_parser::Parser::parse_word_string_with_limits(&source, 10, 16384);
        let cancel = Cancel::new();
        let mut work = Work::new(8192, 4096, 1);
        let mut expansion = Box::pin(fields(
            &token,
            &state,
            &cancel,
            FieldContext::Argv,
            (4096, 1, 4096),
            &mut work,
        ));
        assert!(expansion.as_mut().now_or_never().is_none());
        cancel.cancel();
        assert!(matches!(
            expansion.now_or_never(),
            Some(Err(Error::Status(130)))
        ));
        assert_eq!(work.storage_remaining, 4096);
    }

    #[test]
    fn substring_special_snapshots_admit_decimal_storage_before_formatting() {
        let mut state = crate::state::State::default();
        state.publish_status(i32::MIN);
        state.replace_positional(vec![String::new(); 12]).unwrap();
        for (name, expected) in [("?", "-2147483648"), ("#", "12")] {
            let mut work = Work::new(64, 0, 1);
            assert!(matches!(
                substring_snapshot(&state, name, 32, &mut work),
                Err(Error::Status(2))
            ));
            let mut work = Work::new(64, expected.len(), 1);
            assert_eq!(
                substring_snapshot(&state, name, 32, &mut work)
                    .ok()
                    .as_deref(),
                Some(expected)
            );
            assert_eq!(work.storage_remaining, 0);
        }
    }

    fn join_with_storage(storage: usize, max_fields: usize) -> Result<(Fields, usize), Error> {
        let mut work = Work::new(64, storage, max_fields);
        let mut segments = Segments {
            needs_split: true,
            account_storage: true,
            ..Segments::default()
        };
        for ch in "a:b".chars() {
            segments.character(ch, false, false, &mut work)?;
        }
        let mut fields = Fields::new(3, max_fields);
        fields.joined = true;
        let cancel = Cancel::new();
        let fields = segments
            .collect(Ifs::single(':'), fields, &mut work, &cancel)
            .now_or_never()
            .expect("the tiny join uses fewer than 64 checkpoints")?;
        Ok((fields, work.storage_remaining))
    }

    #[test]
    fn diagnostic_join_admits_coexisting_storage_at_the_exact_boundary() {
        // One retained segment slot and both eight-byte String capacities.
        let storage = std::mem::size_of::<Segment>() + 8 + 8;
        assert!(matches!(
            join_with_storage(storage - 1, 2),
            Err(Error::Status(2))
        ));
        let (fields, remaining) = join_with_storage(storage, 2)
            .unwrap_or_else(|_| panic!("exactly admitted segment and output must fit"));
        assert_eq!(fields.current, "a b");
        assert_eq!(fields.count, 2);
        assert_eq!(
            fields.out.capacity(),
            0,
            "joined fields never allocate slots"
        );
        assert_eq!(remaining, 0);
        assert!(matches!(
            join_with_storage(storage, 1),
            Err(Error::Status(2))
        ));
    }

    #[test]
    fn diagnostic_join_yields_and_cancels_without_returning_partial_text() {
        let segments = Segments {
            parts: vec![Segment::Text {
                value: "a:".repeat(1024),
                protected: false,
                glob_protected: false,
            }],
            needs_split: true,
            ..Segments::default()
        };
        let cancel = Cancel::new();
        let mut work = Work::new(16_384, 8192, 2048);
        let mut join = Box::pin(segments.join(Ifs::single(':'), 8192, 2048, &mut work, &cancel));
        assert!(join.as_mut().now_or_never().is_none());
        cancel.cancel();
        assert!(matches!(join.now_or_never(), Some(Err(Error::Status(130)))));
    }
}
