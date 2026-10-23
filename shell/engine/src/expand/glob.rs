//! Original, bounded pathname expansion for argv and control-flow word lists.
//! Directory entries are streamed from the shell filesystem, never the host's
//! working directory. Quote protection survives IFS splitting byte for byte.
use super::{Error, Protection, Work, admit_vec_slot, pattern::Pattern};
use crate::{
    executor::Cancel,
    io::{FileKind, FileSystem, IoError, MAX_PATH_BYTES},
    state::SharedState,
};
use futures::{
    FutureExt,
    future::{Either, select},
};
use std::{cmp::Ordering, rc::Rc};

fn io_error(error: IoError) -> Error {
    Error::Status(if error == IoError::Cancelled { 130 } else { 2 })
}
fn discard(value: String, work: &mut Work) {
    let bytes = value.capacity();
    drop(value);
    work.release_storage(bytes);
}
fn absent(error: &IoError) -> bool {
    matches!(
        error,
        IoError::NotFound | IoError::NotDirectory | IoError::Runtime(2 | 63)
    )
}

/// Pathname characters of one component after Pattern's pathname
/// normalization (`normalize_glob` without extglob), read in place.
#[derive(Clone, Copy)]
struct Normalized<'a> {
    text: &'a str,
    protection: &'a [bool],
    offset: usize,
    /// A backslash kept as a literal unprotects the glob character after it.
    unprotected: bool,
}
impl Iterator for Normalized<'_> {
    type Item = (char, bool);
    fn next(&mut self) -> Option<(char, bool)> {
        let ch = self.text[self.offset..].chars().next()?;
        let protected = self.protection[self.offset] && !std::mem::take(&mut self.unprotected);
        let after = self.offset + ch.len_utf8();
        self.offset = after;
        if ch != '\\' || protected {
            return Some((ch, protected));
        }
        let Some(next) = self.text[after..].chars().next() else {
            return Some((ch, protected));
        };
        if self.protection[after] && matches!(next, '*' | '?' | '[' | ']' | '\\') {
            self.unprotected = true;
            return Some(('\\', true));
        }
        self.offset = after + next.len_utf8();
        Some((next, true))
    }
}
fn active<'a>(chars: Normalized<'a>, set: &[char]) -> Option<Normalized<'a>> {
    let mut after = chars;
    after
        .next()
        .is_some_and(|(ch, protected)| !protected && set.contains(&ch))
        .then_some(after)
}
enum Bracket<'a> {
    Closed(Normalized<'a>),
    Open,
    Unsupported,
}
/// Pattern::bracket over normalized characters following an active `[`.
async fn bracket<'a>(
    chars: Normalized<'a>,
    work: &mut Work,
    cancel: &Cancel,
) -> Result<Bracket<'a>, Error> {
    let mut chars = active(chars, &['!', '^']).unwrap_or(chars);
    // A leading ']' belongs to the class, including after negation.
    chars = active(chars, &[']']).unwrap_or(chars);
    loop {
        work.checkpoint(cancel).await?;
        if let Some(after) = active(chars, &[']']) {
            return Ok(Bracket::Closed(after));
        }
        if active(chars, &['['])
            .and_then(|after| active(after, &[':', '.', '=']))
            .is_some()
        {
            return Ok(Bracket::Unsupported);
        }
        if chars.next().is_none() {
            return Ok(Bracket::Open);
        }
    }
}
/// A long component's pathname magic and the fewest characters a name must
/// have to match it, without building a Pattern: unprotected `*` matches
/// none, a bracket expression or any other character one. None leaves inputs
/// the Pattern compiler rejects (character classes, extglob operators) to it.
struct Shape {
    magic: bool,
    min_chars: usize,
}
async fn shape(
    text: &str,
    protection: &[bool],
    work: &mut Work,
    cancel: &Cancel,
) -> Result<Option<Shape>, Error> {
    let mut chars = Normalized {
        text,
        protection,
        offset: 0,
        unprotected: false,
    };
    let mut shape = Shape {
        magic: false,
        min_chars: 0,
    };
    // Once one `[` finds no closing `]`, no later `[` can find one either.
    let mut closable = true;
    while let Some((ch, protected)) = chars.next() {
        work.checkpoint(cancel).await?;
        if !protected
            && matches!(ch, '@' | '?' | '*' | '+' | '!')
            && active(chars, &['(']).is_some()
        {
            return Ok(None);
        }
        if !protected && ch == '*' {
            shape.magic = true;
            continue;
        }
        shape.min_chars += 1;
        if protected || ch != '[' || !closable {
            shape.magic |= !protected && ch == '?';
            continue;
        }
        match bracket(chars, work, cancel).await? {
            Bracket::Closed(after) => {
                shape.magic = true;
                chars = after;
            }
            Bracket::Open => closable = false,
            Bracket::Unsupported => return Ok(None),
        }
    }
    Ok(Some(shape))
}
/// Components longer than any path are read in place by `shape`. Most need
/// more characters than any name has; building their Pattern costs 8 bytes
/// per character, over the expansion budget past about 64K characters.
async fn long_shape(
    component: &str,
    protection: &[bool],
    work: &mut Work,
    cancel: &Cancel,
) -> Result<Option<Shape>, Error> {
    if component.len() <= MAX_PATH_BYTES {
        return Ok(None);
    }
    shape(component, protection, work, cancel).await
}
async fn component_magic(
    component: &str,
    protection: &[bool],
    work: &mut Work,
    cancel: &Cancel,
) -> Result<bool, Error> {
    if let Some(shape) = long_shape(component, protection, work, cancel).await? {
        return Ok(shape.magic);
    }
    let storage = work.storage_left();
    let mut pattern = Pattern::default();
    for (index, ch) in component.char_indices() {
        work.checkpoint(cancel).await?;
        pattern.push(
            ch,
            if protection[index] {
                Protection::All
            } else {
                Protection::None
            },
            work,
        )?;
    }
    let magic = pattern.has_pathname_magic(work, cancel).await?;
    drop(pattern);
    let released = storage.saturating_sub(work.storage_left());
    work.release_storage(released);
    Ok(magic)
}
/// Each `/`-separated component with its slice of the protection mask.
fn components<'a>(
    text: &'a str,
    protection: &'a [bool],
) -> impl Iterator<Item = (&'a str, &'a [bool])> {
    text.split('/').scan(0, move |offset, component| {
        let start = *offset;
        *offset += component.len() + 1;
        Some((component, &protection[start..start + component.len()]))
    })
}
async fn magic(
    text: &str,
    protection: &[bool],
    work: &mut Work,
    cancel: &Cancel,
) -> Result<bool, Error> {
    for (component, protection) in components(text, protection) {
        if component_magic(component, protection, work, cancel).await? {
            return Ok(true);
        }
    }
    Ok(false)
}
/// No directory entry or path is longer than MAX_PATH_BYTES, so a component
/// needing more characters matches nothing; Bash finds no entry for it either.
async fn unmatchable(
    text: &str,
    protection: &[bool],
    work: &mut Work,
    cancel: &Cancel,
) -> Result<bool, Error> {
    for (component, protection) in components(text, protection) {
        let shape = long_shape(component, protection, work, cancel).await?;
        if shape.is_some_and(|shape| shape.min_chars > MAX_PATH_BYTES) {
            return Ok(true);
        }
    }
    Ok(false)
}

async fn extglob_group(
    text: &str,
    protection: &[bool],
    work: &mut Work,
    cancel: &Cancel,
) -> Result<bool, Error> {
    let bytes = text.as_bytes();
    let mut index = 0;
    while index + 1 < bytes.len() {
        work.checkpoint(cancel).await?;
        if !protection[index] {
            if bytes[index] == b'\\' {
                index += 2;
                continue;
            }
            if matches!(bytes[index], b'@' | b'+' | b'!' | b'?' | b'*')
                && bytes[index + 1] == b'('
                && !protection[index + 1]
            {
                return Ok(true);
            }
        }
        index += 1;
    }
    Ok(false)
}

fn copied(value: &str, limit: usize, work: &mut Work) -> Result<String, Error> {
    if value.len() > limit {
        return Err(2.into());
    }
    work.admit_storage(value.len())?;
    Ok(value.to_owned())
}
fn joined(
    prefix: &str,
    value: &str,
    slash: bool,
    limit: usize,
    work: &mut Work,
) -> Result<Option<String>, Error> {
    let length = prefix
        .len()
        .checked_add(value.len())
        .and_then(|n| n.checked_add(usize::from(slash)))
        .ok_or(2)?;
    // A trailing slash only asks for a directory; the path itself excludes it.
    if length - usize::from(slash) > MAX_PATH_BYTES {
        return Ok(None);
    }
    if length > limit {
        return Err(2.into());
    }
    work.admit_storage(length)?;
    let mut result = String::new();
    result
        .try_reserve_exact(length)
        .map_err(|_| Error::Status(2))?;
    result.push_str(prefix);
    result.push_str(value);
    if slash {
        result.push('/');
    }
    Ok(Some(result))
}
/// The absolute form of a candidate path; None when it is longer than any
/// path, which the filesystem would refuse as too long: an absent candidate.
fn absolute(cwd: &str, path: &str, limit: usize, work: &mut Work) -> Result<Option<String>, Error> {
    let whole = if path.starts_with('/') {
        Some(path)
    } else if path.is_empty() {
        Some(cwd)
    } else {
        None
    };
    if let Some(whole) = whole {
        if whole.len() > MAX_PATH_BYTES {
            return Ok(None);
        }
        return copied(whole, limit, work).map(Some);
    }
    let separator = usize::from(!cwd.ends_with('/'));
    let length = cwd
        .len()
        .checked_add(separator)
        .and_then(|n| n.checked_add(path.len()))
        .ok_or(2)?;
    if length > MAX_PATH_BYTES {
        return Ok(None);
    }
    if length > limit {
        return Err(2.into());
    }
    work.admit_storage(length)?;
    let mut output = String::new();
    output
        .try_reserve_exact(length)
        .map_err(|_| Error::Status(2))?;
    output.push_str(cwd);
    if separator != 0 {
        output.push('/');
    }
    output.push_str(path);
    Ok(Some(output))
}
async fn literal(
    text: &str,
    protection: &[bool],
    work: &mut Work,
    cancel: &Cancel,
) -> Result<String, Error> {
    let storage = work.storage_left();
    let mut pattern = Pattern::default();
    for (index, ch) in text.char_indices() {
        work.checkpoint(cancel).await?;
        pattern.push(
            ch,
            if protection[index] {
                Protection::All
            } else {
                Protection::None
            },
            work,
        )?;
    }
    let output = pattern.pathname_literal(text.len(), work, cancel).await?;
    drop(pattern);
    let released = storage
        .saturating_sub(work.storage_left())
        .saturating_sub(output.capacity());
    work.release_storage(released);
    Ok(output)
}
fn push(
    paths: &mut Vec<String>,
    value: String,
    bytes: &mut usize,
    limit: usize,
    count: usize,
    work: &mut Work,
) -> Result<(), Error> {
    if paths.len() >= count || value.len() > limit.saturating_sub(*bytes) {
        return Err(2.into());
    }
    admit_vec_slot(paths, work)?;
    *bytes += value.len();
    paths.push(value);
    Ok(())
}

async fn compare(
    left: &str,
    right: &str,
    work: &mut Work,
    cancel: &Cancel,
) -> Result<Ordering, Error> {
    for (a, b) in left.bytes().zip(right.bytes()) {
        work.checkpoint(cancel).await?;
        if a != b {
            return Ok(a.cmp(&b));
        }
    }
    Ok(left.len().cmp(&right.len()))
}
async fn sift(
    paths: &mut [String],
    mut root: usize,
    work: &mut Work,
    cancel: &Cancel,
) -> Result<(), Error> {
    while let Some(mut child) = root
        .checked_mul(2)
        .and_then(|n| n.checked_add(1))
        .filter(|&n| n < paths.len())
    {
        work.checkpoint(cancel).await?;
        if child + 1 < paths.len()
            && compare(&paths[child], &paths[child + 1], work, cancel).await? == Ordering::Less
        {
            child += 1;
        }
        if compare(&paths[root], &paths[child], work, cancel).await? != Ordering::Less {
            break;
        }
        paths.swap(root, child);
        root = child;
    }
    Ok(())
}
pub(crate) async fn sort(
    paths: &mut [String],
    work: &mut Work,
    cancel: &Cancel,
) -> Result<(), Error> {
    for root in (0..paths.len() / 2).rev() {
        sift(paths, root, work, cancel).await?;
    }
    for end in (1..paths.len()).rev() {
        work.checkpoint(cancel).await?;
        paths.swap(0, end);
        sift(&mut paths[..end], 0, work, cancel).await?;
    }
    Ok(())
}

/// Whether a candidate path exists, as a directory when it ends in a slash.
/// The slash is not part of the path that is looked up. Missing and too-long
/// paths are absent; other errors stay errors.
async fn exists(
    value: &str,
    slash: bool,
    cwd: &str,
    fs: &Rc<dyn FileSystem>,
    raw: usize,
    work: &mut Work,
    cancel: &Cancel,
) -> Result<bool, Error> {
    let path = value
        .strip_suffix('/')
        .filter(|path| slash && !path.is_empty())
        .unwrap_or(value);
    let Some(full) = absolute(cwd, path, raw, work)? else {
        return Ok(false);
    };
    let stat_storage = full.len().saturating_mul(2).saturating_add(256);
    work.admit_storage(stat_storage)?;
    let stat = fs.stat(&full, true);
    let result = match select(stat, cancel.cancelled().boxed_local()).await {
        Either::Left((result, _)) => result,
        Either::Right(_) => return Err(130.into()),
    };
    work.release_storage(stat_storage);
    let freed = full.capacity();
    drop(full);
    work.release_storage(freed);
    match result {
        Ok(metadata) => Ok(!slash || metadata.kind == FileKind::Directory),
        Err(error) if absent(&error) => Ok(false),
        Err(error) => Err(io_error(error)),
    }
}

/// Candidate paths that survive one component, within the field limits.
struct Survivors<'a> {
    paths: Vec<String>,
    bytes: usize,
    limits: (usize, usize),
    cwd: &'a str,
    fs: &'a Rc<dyn FileSystem>,
    raw: usize,
}
impl Survivors<'_> {
    /// Keep `prefix` + `name`, after checking that it exists when `check` is
    /// set. Missing and too-long paths are skipped.
    async fn extend(
        &mut self,
        prefix: &str,
        name: &str,
        slash: bool,
        check: bool,
        work: &mut Work,
        cancel: &Cancel,
    ) -> Result<(), Error> {
        let Some(value) = joined(prefix, name, slash, self.raw, work)? else {
            return Ok(());
        };
        let (cwd, fs, raw) = (self.cwd, self.fs, self.raw);
        if check && !exists(&value, slash, cwd, fs, raw, work, cancel).await? {
            discard(value, work);
            return Ok(());
        }
        let (max_bytes, max_fields) = self.limits;
        push(
            &mut self.paths,
            value,
            &mut self.bytes,
            max_bytes,
            max_fields,
            work,
        )
    }
}

async fn matches(
    text: &str,
    protection: &[bool],
    cwd: &str,
    fs: &Rc<dyn FileSystem>,
    limits: (usize, usize, usize),
    work: &mut Work,
    cancel: &Cancel,
) -> Result<Vec<String>, Error> {
    let (max_bytes, max_fields, raw) = limits;
    if unmatchable(text, protection, work, cancel).await? {
        return Ok(Vec::new());
    }
    let mut prefixes = Vec::new();
    admit_vec_slot(&mut prefixes, work)?;
    prefixes.push(String::new());
    let scratch = raw.min(MAX_PATH_BYTES).checked_add(24).ok_or(2)?;
    work.admit_storage(scratch)?;
    let mut buffer = Vec::new();
    buffer
        .try_reserve_exact(scratch)
        .map_err(|_| Error::Status(2))?;
    buffer.resize(scratch, 0);
    let mut start = 0;
    let mut components = 0;
    for component in text.split_inclusive('/') {
        work.checkpoint(cancel).await?;
        components += 1;
        // A fixed structural bound, not recursion or a command execution fuel.
        if components > 256 {
            return Err(2.into());
        }
        let slash = component.ends_with('/');
        let part = if slash {
            &component[..component.len() - 1]
        } else {
            component
        };
        let protection = &protection[start..start + part.len()];
        start += component.len();
        let wildcard = magic(part, protection, work, cancel).await?;
        let pattern_storage = work.storage_left();
        let mut pattern = Pattern::default();
        let literal = if wildcard {
            for (index, ch) in part.char_indices() {
                work.checkpoint(cancel).await?;
                pattern.push(
                    ch,
                    if protection[index] {
                        Protection::All
                    } else {
                        Protection::None
                    },
                    work,
                )?;
            }
            None
        } else {
            Some(literal(part, protection, work, cancel).await?)
        };
        let pattern_storage = pattern_storage.saturating_sub(work.storage_left());
        let explicit_dot = part.starts_with('.') || (part.starts_with("\\.") && !protection[0]);
        let mut next = Survivors {
            paths: Vec::new(),
            bytes: 0,
            limits: (max_bytes.min(raw), max_fields),
            cwd,
            fs,
            raw,
        };
        for prefix in &prefixes {
            work.checkpoint(cancel).await?;
            if !wildcard {
                let name = literal.as_deref().ok_or(2)?;
                // Empty root components only introduce the leading slash.
                let check = !part.is_empty();
                next.extend(prefix, name, slash, check, work, cancel)
                    .await?;
                continue;
            }
            // The reader and its host descriptor are dropped before changing
            // directories, on errors, or when cancellation wins either await.
            let Some(path) = absolute(cwd, prefix, raw, work)? else {
                continue;
            };
            let open_storage = path.len().saturating_mul(2).saturating_add(512);
            work.admit_storage(open_storage)?;
            let open = fs.open_dir(&path);
            let opened = match select(open, cancel.cancelled().boxed_local()).await {
                Either::Left((result, _)) => result,
                Either::Right(_) => return Err(130.into()),
            };
            let directory = match opened {
                Ok(directory) => directory,
                Err(error) if absent(&error) => {
                    let freed = path.capacity();
                    drop(path);
                    work.release_storage(open_storage + freed);
                    continue;
                }
                Err(error) => return Err(io_error(error)),
            };
            let mut cookie = 0;
            loop {
                work.checkpoint(cancel).await?;
                work.admit_storage(256)?;
                let read = directory.read_entry(cookie, &mut buffer);
                let entry = match select(read, cancel.cancelled().boxed_local()).await {
                    Either::Left((result, _)) => result.map_err(io_error)?,
                    Either::Right(_) => return Err(130.into()),
                };
                work.release_storage(256);
                let Some(entry) = entry else {
                    break;
                };
                if entry.next_cookie == cookie {
                    return Err(2.into());
                }
                cookie = entry.next_cookie;
                let name = buffer.get(entry.name).ok_or(2)?;
                let name = std::str::from_utf8(name).map_err(|_| Error::Status(2))?;
                if name.is_empty() || name.contains(['/', '\0']) {
                    return Err(2.into());
                }
                if name == "." || name == ".." || (name.starts_with('.') && !explicit_dot) {
                    continue;
                }
                // matches_pathname's compiler/state buffers are temporary. Return
                // their exact charge only after the future has dropped them.
                let storage = work.storage_left();
                let matched = pattern.matches_pathname(name, work, cancel).await?;
                let released = storage.saturating_sub(work.storage_left());
                work.release_storage(released);
                if !matched {
                    continue;
                }
                next.extend(prefix, name, slash, slash, work, cancel)
                    .await?;
            }
            drop(directory);
            let freed = path.capacity();
            drop(path);
            work.release_storage(open_storage + freed);
        }
        drop(pattern);
        drop(literal);
        work.release_storage(pattern_storage);
        let freed = prefixes.capacity() * std::mem::size_of::<String>()
            + prefixes.iter().map(String::capacity).sum::<usize>();
        drop(prefixes);
        work.release_storage(freed);
        prefixes = next.paths;
        if prefixes.is_empty() {
            break;
        }
    }
    drop(buffer);
    work.release_storage(scratch);
    sort(&mut prefixes, work, cancel).await?;
    Ok(prefixes)
}

/// Output bookkeeping. Unadmitted argv fields are never charged: their slots
/// are not admitted, discarded text is not released and matches are released.
struct Output {
    values: Vec<String>,
    bytes: usize,
    limits: (usize, usize),
    admitted: bool,
}
impl Output {
    fn keep(&mut self, value: String, work: &mut Work) -> Result<(), Error> {
        let (max_bytes, max_fields) = self.limits;
        if self.admitted {
            return push(
                &mut self.values,
                value,
                &mut self.bytes,
                max_bytes,
                max_fields,
                work,
            );
        }
        if self.values.len() >= max_fields || value.len() > max_bytes.saturating_sub(self.bytes) {
            return Err(2.into());
        }
        self.bytes += value.len();
        self.values.push(value);
        Ok(())
    }
    fn keep_match(&mut self, value: String, work: &mut Work) -> Result<(), Error> {
        if !self.admitted {
            work.release_storage(value.capacity());
        }
        self.keep(value, work)
    }
    fn discard(&self, value: String, work: &mut Work) {
        if self.admitted {
            discard(value, work);
        }
    }
}

/// Split fields with the masks of their pathname candidates only, in field
/// order. `admitted` says whether the fields and their slots were charged.
/// Admitted lists reject pathname extglob groups with status 2; unadmitted
/// argv keeps such fields literal, as it did before argv globbing.
pub(super) struct Candidates {
    pub(super) fields: Vec<String>,
    pub(super) patterns: Vec<(usize, Vec<bool>)>,
    pub(super) admitted: bool,
}

pub(super) async fn expand_fields(
    candidates: Candidates,
    state: &SharedState,
    limits: (usize, usize),
    raw_remaining: &mut usize,
    work: &mut Work,
    cancel: &Cancel,
) -> Result<Vec<String>, Error> {
    let Candidates {
        fields,
        patterns,
        admitted,
    } = candidates;
    if patterns.is_empty() {
        return Ok(fields);
    }
    let fs = work.substitutions.as_ref().ok_or(2)?.filesystem();
    let (nullglob, extglob) = {
        let state = state.borrow();
        (state.nullglob, state.extglob)
    };
    let field_slots = fields.capacity() * std::mem::size_of::<String>();
    let pattern_slots = patterns.capacity() * std::mem::size_of::<(usize, Vec<bool>)>();
    let mut output = Output {
        values: Vec::new(),
        bytes: 0,
        limits,
        admitted,
    };
    let mut patterns = patterns.into_iter().peekable();
    for (index, field) in fields.into_iter().enumerate() {
        work.checkpoint(cancel).await?;
        let Some((_, protection)) = patterns.next_if(|(at, _)| *at == index) else {
            output.keep(field, work)?;
            continue;
        };
        if field.len() != protection.len() {
            return Err(2.into());
        }
        let group = extglob && extglob_group(&field, &protection, work, cancel).await?;
        if group && admitted {
            return Err(2.into());
        }
        if group || !magic(&field, &protection, work, cancel).await? {
            output.keep(field, work)?;
            let freed = protection.capacity();
            drop(protection);
            work.release_storage(freed);
            continue;
        }
        let cwd = copied(&state.borrow().cwd, *raw_remaining, work)?;
        let (max_bytes, max_fields) = limits;
        let values = matches(
            &field,
            &protection,
            &cwd,
            &fs,
            (
                max_bytes.saturating_sub(output.bytes),
                max_fields.saturating_sub(output.values.len()),
                *raw_remaining,
            ),
            work,
            cancel,
        )
        .await?;
        let freed = cwd.capacity() + protection.capacity();
        drop(cwd);
        drop(protection);
        work.release_storage(freed);
        let slots = values.capacity() * std::mem::size_of::<String>();
        if values.is_empty() && !nullglob {
            output.keep(field, work)?;
        } else {
            output.discard(field, work);
            for value in values {
                work.checkpoint(cancel).await?;
                *raw_remaining = raw_remaining.checked_sub(value.len()).ok_or(2)?;
                output.keep_match(value, work)?;
            }
        }
        work.release_storage(slots);
    }
    if patterns.next().is_some() {
        return Err(2.into());
    }
    work.release_storage(pattern_slots);
    if admitted {
        work.release_storage(field_slots);
    }
    Ok(output.values)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::io::{Directory, DirectoryEntry, Endpoint, FileMetadata, MemoryFs, OpenOptions};
    use futures::future::LocalBoxFuture;
    use std::{
        cell::Cell,
        future::Future,
        task::{Context, Poll},
    };

    fn finish<T>(future: impl Future<Output = T>) -> T {
        let mut future = Box::pin(future);
        let mut context = Context::from_waker(futures::task::noop_waker_ref());
        for _ in 0..100_000 {
            if let Poll::Ready(value) = future.as_mut().poll(&mut context) {
                return value;
            }
        }
        panic!("bounded pathname expansion did not finish");
    }

    fn pattern_magic(text: &str, protection: &[bool]) -> Option<bool> {
        let cancel = Cancel::new();
        let mut work = Work::new(1_000_000, 1 << 20, 16);
        let mut pattern = Pattern::default();
        for (index, ch) in text.char_indices() {
            let protection = if protection[index] {
                Protection::All
            } else {
                Protection::None
            };
            assert!(pattern.push(ch, protection, &mut work).is_ok());
        }
        finish(pattern.has_pathname_magic(&mut work, &cancel)).ok()
    }
    fn long_shape_of(text: &str, protection: &[bool]) -> Option<(bool, usize)> {
        let cancel = Cancel::new();
        let mut work = Work::new(1_000_000, 0, 16);
        let shape = finish(shape(text, protection, &mut work, &cancel))
            .ok()
            .flatten()?;
        Some((shape.magic, shape.min_chars))
    }

    const SHAPE_ALPHABET: [char; 10] = ['a', '*', '?', '[', ']', '!', '^', '\\', ':', '('];
    /// Case `index` of all `length`-character texts over SHAPE_ALPHABET, each
    /// under every protection mask: the low `length` bits are the mask.
    fn shape_case(length: u32, index: usize) -> (String, Vec<bool>) {
        let code = index >> length;
        let radix = SHAPE_ALPHABET.len();
        let text = (0..length)
            .map(|place| SHAPE_ALPHABET[code / radix.pow(place) % radix])
            .collect();
        let protection = (0..length).map(|bit| index >> bit & 1 == 1).collect();
        (text, protection)
    }

    #[test]
    fn long_component_shape_agrees_with_pattern_magic() {
        let cases = (1..=4u32).flat_map(|length| {
            (0..SHAPE_ALPHABET.len().pow(length) << length).map(move |index| (length, index))
        });
        let mut checked = 0;
        for (length, index) in cases {
            let (text, protection) = shape_case(length, index);
            let Some((magic, _)) = long_shape_of(&text, &protection) else {
                continue;
            };
            let mask = index & ((1 << length) - 1);
            assert_eq!(
                Some(magic),
                pattern_magic(&text, &protection),
                "{text:?} {mask:b}"
            );
            checked += 1;
        }
        assert!(checked > 100_000);
        for (text, protection, expected) in [
            ("a*b", &[false; 3][..], (true, 2)),
            ("[ab]c", &[false; 5], (true, 2)),
            ("[!]]x", &[false; 5], (true, 2)),
            ("[a", &[false; 2], (false, 2)),
            ("a[b[c]", &[false; 6], (true, 2)),
            ("\\*x", &[false; 3], (false, 2)),
            ("\\*x", &[false, true, false], (true, 2)),
            ("a*", &[true, true], (false, 2)),
        ] {
            assert_eq!(long_shape_of(text, protection), Some(expected), "{text:?}");
        }
        assert_eq!(long_shape_of("a[[:alpha:]]", &[false; 12]), None);
        assert_eq!(long_shape_of("*(a)", &[false; 4]), None);
    }

    #[test]
    fn a_trailing_slash_is_not_part_of_the_path_limit() {
        let memory = MemoryFs::new(0);
        let parent =
            |name: &str| -> String { (0..19).map(|_| format!("/{}", name.repeat(200))).collect() };
        let (a, b) = (parent("a"), parent("b"));
        let leaf = |parent: &str, total: usize| {
            format!("{parent}/{}", "m".repeat(total - parent.len() - 1))
        };
        let (exact, shorter) = (leaf(&a, MAX_PATH_BYTES), leaf(&b, MAX_PATH_BYTES - 1));
        memory.mkdir(&exact, true).unwrap();
        memory.mkdir(&shorter, true).unwrap();
        let fs: Rc<dyn FileSystem> = Rc::new(memory);
        let cancel = Cancel::new();
        let first = &a[..201];
        let relative = &exact[202..];
        for (cwd, text, expected) in [
            ("/", format!("{a}/*/"), vec![format!("{exact}/")]),
            (
                first,
                format!("{}/*/", &a[202..]),
                vec![format!("{relative}/")],
            ),
            ("/", format!("{b}/*/"), vec![format!("{shorter}/")]),
            ("/", format!("{a}/*"), vec![exact.clone()]),
            ("/", format!("{a}/*/*/"), Vec::new()),
            ("/", format!("{a}/*/*"), Vec::new()),
        ] {
            let mut work = Work::new(10_000_000, 1 << 20, 16);
            let protection = vec![false; text.len()];
            let limits = (1 << 20, 16, 1 << 20);
            let found = finish(matches(
                &text,
                &protection,
                cwd,
                &fs,
                limits,
                &mut work,
                &cancel,
            ));
            assert_eq!(found.ok(), Some(expected), "{} {}", cwd.len(), text.len());
        }
    }

    #[test]
    fn components_and_paths_longer_than_any_path_match_nothing() {
        let memory = MemoryFs::new(0);
        memory.write_file("/a", b"").unwrap();
        memory.mkdir("/d", false).unwrap();
        let fs: Rc<dyn FileSystem> = Rc::new(memory);
        let cancel = Cancel::new();
        let long = "a".repeat(70_000);
        let path = "b".repeat(MAX_PATH_BYTES);
        for text in [
            format!("{long}*"),
            format!("{long}["),
            format!("*/{long}"),
            format!("/{path}/*"),
            format!("d*/{path}"),
        ] {
            let mut work = Work::new(10_000_000, 1 << 20, 16);
            let storage = work.storage_left();
            let protection = vec![false; text.len()];
            let found = finish(matches(
                &text,
                &protection,
                "/",
                &fs,
                (1 << 20, 16, 1 << 20),
                &mut work,
                &cancel,
            ));
            assert_eq!(found.ok(), Some(Vec::new()), "{}", text.len());
            assert_eq!(work.storage_left(), storage);
        }
        let mut work = Work::new(10_000_000, 1 << 20, 16);
        let protection = vec![false; long.len() + 1];
        let text = format!("{long}*");
        assert!(finish(magic(&text, &protection, &mut work, &cancel)).is_ok_and(|magic| magic));
        assert!(
            finish(magic(&text[..long.len()], &protection, &mut work, &cancel))
                .is_ok_and(|magic| !magic)
        );
    }

    #[test]
    fn glob_scratch_and_matches_are_admitted_before_growth() {
        let memory = MemoryFs::new(0);
        memory.write_file("/a.txt", b"").unwrap();
        memory.write_file("/b.txt", b"").unwrap();
        let fs: Rc<dyn FileSystem> = Rc::new(memory);
        let cancel = Cancel::new();
        for (storage, bytes, fields, raw) in [
            (0, 1024, 16, 1024),
            (65536, 4, 16, 1024),
            (65536, 1024, 1, 1024),
            (65536, 1024, 16, 1),
        ] {
            let mut work = Work::new(65536, storage, fields);
            assert!(matches!(
                finish(matches(
                    "*.txt",
                    &[false; 5],
                    "/",
                    &fs,
                    (bytes, fields, raw),
                    &mut work,
                    &cancel
                )),
                Err(Error::Status(2))
            ));
        }
        let mut work = Work::new(65536, 65536, 16);
        assert_eq!(
            finish(matches(
                "*.txt",
                &[false; 5],
                "/",
                &fs,
                (1024, 16, 1024),
                &mut work,
                &cancel
            ))
            .ok(),
            Some(vec!["a.txt".into(), "b.txt".into()])
        );
    }

    struct ParkedDirectory {
        reads: Rc<Cell<usize>>,
        drops: Rc<Cell<usize>>,
    }
    impl Drop for ParkedDirectory {
        fn drop(&mut self) {
            self.drops.set(self.drops.get() + 1);
        }
    }
    impl Directory for ParkedDirectory {
        fn read_entry<'a>(
            &'a self,
            _cookie: u64,
            _output: &'a mut [u8],
        ) -> LocalBoxFuture<'a, Result<Option<DirectoryEntry>, IoError>> {
            Box::pin(async move {
                self.reads.set(self.reads.get() + 1);
                futures::future::pending().await
            })
        }
    }
    struct ParkedFs {
        reads: Rc<Cell<usize>>,
        drops: Rc<Cell<usize>>,
    }
    impl FileSystem for ParkedFs {
        fn mkdir<'a>(
            &'a self,
            _path: &'a str,
            _parents: bool,
        ) -> LocalBoxFuture<'a, Result<(), IoError>> {
            Box::pin(async { Err(IoError::Unsupported) })
        }
        fn stat<'a>(
            &'a self,
            _path: &'a str,
            _follow: bool,
        ) -> LocalBoxFuture<'a, Result<FileMetadata, IoError>> {
            Box::pin(async { Err(IoError::Unsupported) })
        }
        fn open<'a>(
            &'a self,
            _path: &'a str,
            _options: &'a OpenOptions,
        ) -> LocalBoxFuture<'a, Result<Endpoint, IoError>> {
            Box::pin(async { Err(IoError::Unsupported) })
        }
        fn open_dir<'a>(
            &'a self,
            _path: &'a str,
        ) -> LocalBoxFuture<'a, Result<Rc<dyn Directory>, IoError>> {
            Box::pin(async move {
                Ok(Rc::new(ParkedDirectory {
                    reads: self.reads.clone(),
                    drops: self.drops.clone(),
                }) as Rc<dyn Directory>)
            })
        }
    }
    #[test]
    fn glob_cancel_drops_a_parked_directory_reader_without_partial_fields() {
        let reads = Rc::new(Cell::new(0));
        let drops = Rc::new(Cell::new(0));
        let fs: Rc<dyn FileSystem> = Rc::new(ParkedFs {
            reads: reads.clone(),
            drops: drops.clone(),
        });
        let cancel = Cancel::new();
        let mut work = Work::new(65536, 65536, 16);
        let mut future = Box::pin(matches(
            "*",
            &[false],
            "/",
            &fs,
            (1024, 16, 1024),
            &mut work,
            &cancel,
        ));
        let mut context = Context::from_waker(futures::task::noop_waker_ref());
        for _ in 0..100 {
            assert!(future.as_mut().poll(&mut context).is_pending());
            if reads.get() > 0 {
                break;
            }
        }
        assert_eq!(reads.get(), 1);
        assert_eq!(drops.get(), 0);
        cancel.cancel();
        assert!(matches!(finish(future), Err(Error::Status(130))));
        assert_eq!(drops.get(), 1);
    }

    #[test]
    fn glob_cancel_interrupts_a_ready_directory_scan() {
        let memory = MemoryFs::new(0);
        for index in 0..256 {
            memory
                .write_file(&format!("/long-name-{index:03}.txt"), b"")
                .unwrap();
        }
        let fs: Rc<dyn FileSystem> = Rc::new(memory);
        let cancel = Cancel::new();
        let mut work = Work::new(1_000_000, 1_000_000, 1024);
        let mut future = Box::pin(matches(
            "*.txt",
            &[false; 5],
            "/",
            &fs,
            (65536, 1024, 65536),
            &mut work,
            &cancel,
        ));
        let mut context = Context::from_waker(futures::task::noop_waker_ref());
        assert!(future.as_mut().poll(&mut context).is_pending());
        cancel.cancel();
        assert!(matches!(finish(future), Err(Error::Status(130))));
    }
}

/// Completion -G uses literal glob syntax without another shell expansion pass.
pub(crate) async fn completion_matches(
    text: &str,
    state: &SharedState,
    limits: (usize, usize),
    work: &mut Work,
    cancel: &Cancel,
) -> Result<Vec<String>, Error> {
    work.admit_storage(text.len().saturating_add(state.borrow().cwd.len()))?;
    let protection = vec![false; text.len()];
    let cwd = state.borrow().cwd.clone();
    let fs = work.substitutions.as_ref().ok_or(2)?.filesystem();
    matches(
        text,
        &protection,
        &cwd,
        &fs,
        (limits.0, limits.1, limits.0),
        work,
        cancel,
    )
    .await
}
