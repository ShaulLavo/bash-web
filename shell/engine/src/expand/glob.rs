//! Original, bounded pathname expansion for admitted control-flow word lists.
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

async fn magic(
    text: &str,
    protection: &[bool],
    work: &mut Work,
    cancel: &Cancel,
) -> Result<bool, Error> {
    let mut offset = 0;
    for component in text.split('/') {
        let storage = work.storage_left();
        let mut pattern = Pattern::default();
        for (index, ch) in component.char_indices() {
            work.checkpoint(cancel).await?;
            pattern.push(
                ch,
                if protection[offset + index] {
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
        if magic {
            return Ok(true);
        }
        offset += component.len() + 1;
    }
    Ok(false)
}

async fn reject_extglob(
    text: &str,
    protection: &[bool],
    work: &mut Work,
    cancel: &Cancel,
) -> Result<(), Error> {
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
                return Err(2.into());
            }
        }
        index += 1;
    }
    Ok(())
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
) -> Result<String, Error> {
    let length = prefix
        .len()
        .checked_add(value.len())
        .and_then(|n| n.checked_add(usize::from(slash)))
        .ok_or(2)?;
    if length > limit || length > MAX_PATH_BYTES {
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
    Ok(result)
}
fn absolute(cwd: &str, path: &str, limit: usize, work: &mut Work) -> Result<String, Error> {
    if path.starts_with('/') {
        return copied(path, limit.min(MAX_PATH_BYTES), work);
    }
    if path.is_empty() {
        return copied(cwd, limit.min(MAX_PATH_BYTES), work);
    }
    let separator = usize::from(!cwd.ends_with('/'));
    let length = cwd
        .len()
        .checked_add(separator)
        .and_then(|n| n.checked_add(path.len()))
        .ok_or(2)?;
    if length > limit || length > MAX_PATH_BYTES {
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
    Ok(output)
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
async fn sort(paths: &mut [String], work: &mut Work, cancel: &Cancel) -> Result<(), Error> {
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
        let mut next = Vec::new();
        let mut next_bytes = 0;
        for prefix in &prefixes {
            work.checkpoint(cancel).await?;
            if !wildcard {
                let value = joined(prefix, literal.as_deref().ok_or(2)?, slash, raw, work)?;
                // Empty root components only introduce the leading slash.
                if !part.is_empty() {
                    let full = absolute(cwd, &value, raw, work)?;
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
                        Ok(metadata) if !slash || metadata.kind == FileKind::Directory => {}
                        Ok(_) => {
                            discard(value, work);
                            continue;
                        }
                        Err(error) if absent(&error) => {
                            discard(value, work);
                            continue;
                        }
                        Err(error) => return Err(io_error(error)),
                    }
                }
                push(
                    &mut next,
                    value,
                    &mut next_bytes,
                    max_bytes.min(raw),
                    max_fields,
                    work,
                )?;
                continue;
            }
            // The reader and its host descriptor are dropped before changing
            // directories, on errors, or when cancellation wins either await.
            let path = absolute(cwd, prefix, raw, work)?;
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
                // matches_full's compiler/state buffers are temporary. Return
                // their exact charge only after the future has dropped them.
                let storage = work.storage_left();
                let matched = pattern.matches_full(name, work, cancel).await?;
                let released = storage.saturating_sub(work.storage_left());
                work.release_storage(released);
                if !matched {
                    continue;
                }
                let value = joined(prefix, name, slash, raw, work)?;
                if slash {
                    let full = absolute(cwd, &value, raw, work)?;
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
                        Ok(metadata) if metadata.kind == FileKind::Directory => {}
                        Ok(_) => {
                            discard(value, work);
                            continue;
                        }
                        Err(error) if absent(&error) => {
                            discard(value, work);
                            continue;
                        }
                        Err(error) => return Err(io_error(error)),
                    }
                }
                push(
                    &mut next,
                    value,
                    &mut next_bytes,
                    max_bytes.min(raw),
                    max_fields,
                    work,
                )?;
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
        prefixes = next;
        if prefixes.is_empty() {
            break;
        }
    }
    drop(buffer);
    work.release_storage(scratch);
    sort(&mut prefixes, work, cancel).await?;
    Ok(prefixes)
}

pub(super) async fn expand_fields(
    fields: Vec<String>,
    protections: Vec<Vec<bool>>,
    state: &SharedState,
    limits: (usize, usize),
    raw_remaining: &mut usize,
    work: &mut Work,
    cancel: &Cancel,
) -> Result<Vec<String>, Error> {
    let (max_bytes, max_fields) = limits;
    let fs = work.substitutions.as_ref().ok_or(2)?.filesystem();
    let (nullglob, extglob) = {
        let state = state.borrow();
        (state.nullglob, state.extglob)
    };
    let input_slots = fields.capacity() * std::mem::size_of::<String>()
        + protections.capacity() * std::mem::size_of::<Vec<bool>>();
    let mut output = Vec::new();
    let mut bytes = 0;
    if fields.len() != protections.len() {
        return Err(2.into());
    }
    for (field, protection) in fields.into_iter().zip(protections) {
        work.checkpoint(cancel).await?;
        if field.len() != protection.len() {
            return Err(2.into());
        }
        if extglob {
            reject_extglob(&field, &protection, work, cancel).await?;
        }
        if !magic(&field, &protection, work, cancel).await? {
            push(&mut output, field, &mut bytes, max_bytes, max_fields, work)?;
            let freed = protection.capacity();
            drop(protection);
            work.release_storage(freed);
            continue;
        }
        let cwd = copied(&state.borrow().cwd, *raw_remaining, work)?;
        let values = matches(
            &field,
            &protection,
            &cwd,
            &fs,
            (
                max_bytes.saturating_sub(bytes),
                max_fields.saturating_sub(output.len()),
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
            push(&mut output, field, &mut bytes, max_bytes, max_fields, work)?;
        } else {
            let freed = field.capacity();
            drop(field);
            work.release_storage(freed);
            for value in values {
                work.checkpoint(cancel).await?;
                *raw_remaining = raw_remaining.checked_sub(value.len()).ok_or(2)?;
                push(&mut output, value, &mut bytes, max_bytes, max_fields, work)?;
            }
        }
        work.release_storage(slots);
    }
    work.release_storage(input_slots);
    Ok(output)
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
