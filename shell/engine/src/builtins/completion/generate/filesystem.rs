//! Host-dependent candidates come only from the embedding runtime.
use super::{Candidates, error_status, scan_bytes};
use crate::{
    expand::Work,
    interpreter::Context,
    io::{FileKind, IoError, MAX_PATH_BYTES, OpenOptions},
    state::SharedState,
};
use std::rc::Rc;

#[derive(Clone, Copy)]
pub(super) enum Mode {
    Files,
    Directories,
    Executables,
    CommandPath,
}
struct Query<'a> {
    directory: &'a str,
    spelling: &'a str,
    prefix: &'a str,
    mode: Mode,
}
fn absent(error: &IoError) -> bool {
    matches!(
        error,
        IoError::NotFound | IoError::NotDirectory | IoError::Runtime(2 | 44 | 54)
    )
}
fn io_status(error: IoError) -> i32 {
    if error == IoError::Cancelled { 130 } else { 2 }
}
fn copy(value: &str, work: &mut Work) -> Result<String, i32> {
    work.admit_storage(value.len()).map_err(error_status)?;
    Ok(value.to_owned())
}
fn join(directory: &str, name: &str, work: &mut Work) -> Result<String, i32> {
    let slash = !directory.is_empty() && !directory.ends_with('/');
    let bytes = directory
        .len()
        .checked_add(name.len())
        .and_then(|n| n.checked_add(usize::from(slash)))
        .ok_or(2)?;
    if bytes > MAX_PATH_BYTES {
        return Err(2);
    }
    work.admit_storage(bytes).map_err(error_status)?;
    let mut path = String::with_capacity(bytes);
    path.push_str(directory);
    if slash {
        path.push('/');
    }
    path.push_str(name);
    Ok(path)
}
pub(super) async fn paths(
    prefix: &str,
    mode: Mode,
    state: &SharedState,
    output: &mut Candidates,
    context: &Context,
    work: &mut Work,
) -> Result<(), i32> {
    let (spelling, basename) = prefix.rfind('/').map_or(("", prefix), |index| {
        (&prefix[..=index], &prefix[index + 1..])
    });
    let cwd = copy(&state.borrow().cwd, work)?;
    let directory = lookup_directory(spelling, &cwd, state, work)?;
    let mut generated = Candidates::new(context);
    scan(
        Query {
            directory: &directory,
            spelling,
            prefix: basename,
            mode,
        },
        &cwd,
        &mut generated,
        context,
        work,
    )
    .await?;
    for path in generated.values {
        output.add(&path, "", work)?;
    }
    Ok(())
}
fn lookup_directory(
    spelling: &str,
    cwd: &str,
    state: &SharedState,
    work: &mut Work,
) -> Result<String, i32> {
    if spelling.starts_with('/') {
        return copy(spelling, work);
    }
    let Some(suffix) = spelling.strip_prefix("~/") else {
        return join(cwd, spelling, work);
    };
    let state = state.borrow();
    let Some(home) = state.scalar_parameter("HOME") else {
        return join(cwd, spelling, work);
    };
    if home.starts_with('/') {
        return join(home, suffix, work);
    }
    let home = join(cwd, home, work)?;
    join(&home, suffix, work)
}
pub(super) async fn commands(
    prefix: &str,
    state: &SharedState,
    output: &mut Candidates,
    context: &Context,
    work: &mut Work,
) -> Result<(), i32> {
    if prefix.contains('/') {
        return paths(prefix, Mode::CommandPath, state, output, context, work).await;
    }
    let (cwd, path) = {
        let state = state.borrow();
        (
            copy(&state.cwd, work)?,
            state
                .scalar_parameter("PATH")
                .map(|value| copy(value, work))
                .transpose()?,
        )
    };
    let Some(path) = path else {
        return Ok(());
    };
    let mut generated = Candidates::new(context);
    for directory in path.split(':') {
        scan_bytes(directory.len(), context, work).await?;
        let absolute = if directory.starts_with('/') {
            copy(directory, work)?
        } else {
            join(&cwd, directory, work)?
        };
        scan(
            Query {
                directory: &absolute,
                spelling: "",
                prefix,
                mode: Mode::Executables,
            },
            &cwd,
            &mut generated,
            context,
            work,
        )
        .await?;
        let released = absolute.capacity();
        drop(absolute);
        work.release_storage(released);
    }
    for value in generated.values {
        output.add(&value, "", work)?;
    }
    Ok(())
}
async fn scan(
    query: Query<'_>,
    cwd: &str,
    output: &mut Candidates,
    context: &Context,
    work: &mut Work,
) -> Result<(), i32> {
    work.checkpoint(&context.cancel)
        .await
        .map_err(error_status)?;
    let storage = 2 * (MAX_PATH_BYTES + 24);
    work.admit_storage(storage).map_err(error_status)?;
    let opened = context
        .cancel
        .run(context.fs().open_dir(query.directory))
        .await;
    let directory = match opened {
        Ok(Ok(directory)) => directory,
        Ok(Err(error)) if absent(&error) => {
            work.release_storage(storage);
            return Ok(());
        }
        Ok(Err(error)) => {
            work.release_storage(storage);
            return Err(io_status(error));
        }
        Err(_) => {
            work.release_storage(storage);
            return Err(130);
        }
    };
    let mut buffer = vec![0; MAX_PATH_BYTES + 24];
    let result = entries(directory, &query, cwd, output, &mut buffer, context, work).await;
    drop(buffer);
    work.release_storage(storage);
    result
}
async fn entries(
    directory: Rc<dyn crate::io::Directory>,
    query: &Query<'_>,
    cwd: &str,
    output: &mut Candidates,
    buffer: &mut [u8],
    context: &Context,
    work: &mut Work,
) -> Result<(), i32> {
    let mut cookie = 0;
    loop {
        work.checkpoint(&context.cancel)
            .await
            .map_err(error_status)?;
        let entry = context
            .cancel
            .run(directory.read_entry(cookie, buffer))
            .await
            .map_err(|_| 130)?
            .map_err(io_status)?;
        let Some(entry) = entry else {
            return Ok(());
        };
        if entry.next_cookie == cookie {
            return Err(2);
        }
        cookie = entry.next_cookie;
        let name = std::str::from_utf8(buffer.get(entry.name).ok_or(2)?).map_err(|_| 2)?;
        if name.is_empty() || name.contains(['/', '\0']) {
            return Err(2);
        }
        scan_bytes(name.len(), context, work).await?;
        if !name.starts_with(query.prefix)
            || matches!(name, "." | "..") && !query.prefix.starts_with('.')
        {
            continue;
        }
        candidate(name, query, cwd, output, context, work).await?;
    }
}
async fn candidate(
    name: &str,
    query: &Query<'_>,
    cwd: &str,
    output: &mut Candidates,
    context: &Context,
    work: &mut Work,
) -> Result<(), i32> {
    let storage = work.storage_left();
    let accepted = accepts(name, query, cwd, context, work).await?;
    let released = storage.saturating_sub(work.storage_left());
    work.release_storage(released);
    if !accepted {
        return Ok(());
    }
    let value = join(query.spelling, name, work)?;
    output.add(&value, "", work)?;
    let released = value.capacity();
    drop(value);
    work.release_storage(released);
    Ok(())
}
async fn accepts(
    name: &str,
    query: &Query<'_>,
    cwd: &str,
    context: &Context,
    work: &mut Work,
) -> Result<bool, i32> {
    if matches!(query.mode, Mode::Files) {
        return Ok(true);
    }
    let path = join(query.directory, name, work)?;
    let stat = context
        .cancel
        .run(context.fs().stat(&path, true))
        .await
        .map_err(|_| 130)?;
    let metadata = match stat {
        Ok(metadata) => metadata,
        Err(error) if absent(&error) => return Ok(false),
        Err(error) => return Err(io_status(error)),
    };
    if matches!(query.mode, Mode::Directories) {
        return Ok(metadata.kind == FileKind::Directory);
    }
    if metadata.kind == FileKind::Directory {
        return Ok(matches!(query.mode, Mode::CommandPath));
    }
    let cwd = copy(cwd, work)?;
    context.executable_path(path, cwd).await
}
pub(super) async fn database(
    action: &str,
    prefix: &str,
    state: &SharedState,
    output: &mut Candidates,
    context: &Context,
    work: &mut Work,
) -> Result<(), i32> {
    let path = database_path(action, state, work)?;
    let text = read(&path, context, work).await?;
    for line in text.lines() {
        scan_bytes(line.len(), context, work).await?;
        database_line(action, line, prefix, output, work)?;
    }
    Ok(())
}
fn database_path(action: &str, state: &SharedState, work: &mut Work) -> Result<String, i32> {
    let state = state.borrow();
    let path = match action {
        "user" => "/etc/passwd",
        "group" => "/etc/group",
        "service" => "/etc/services",
        _ => state.scalar_parameter("HOSTFILE").unwrap_or("/etc/hosts"),
    };
    if path.starts_with('/') {
        return copy(path, work);
    }
    join(&state.cwd, path, work)
}
fn database_line(
    action: &str,
    line: &str,
    prefix: &str,
    output: &mut Candidates,
    work: &mut Work,
) -> Result<(), i32> {
    let line = line.split('#').next().unwrap_or_default();
    if action == "user" || action == "group" {
        let Some((name, _)) = line.split_once(':') else {
            return Ok(());
        };
        return output.add(name, prefix, work);
    }
    let mut fields = line.split_whitespace();
    if action == "service" {
        let Some(name) = fields.next() else {
            return Ok(());
        };
        return output.add(name, prefix, work);
    }
    fields.next();
    for name in fields {
        output.add(name, prefix, work)?;
    }
    Ok(())
}

async fn read(path: &str, context: &Context, work: &mut Work) -> Result<String, i32> {
    let options = OpenOptions {
        read: true,
        ..OpenOptions::default()
    };
    let endpoint = context
        .cancel
        .run(context.fs().open(path, &options))
        .await
        .map_err(|_| 130)?;
    let endpoint = match endpoint {
        Ok(endpoint) => endpoint,
        Err(error) if absent(&error) => return Ok(String::new()),
        Err(error) => return Err(io_status(error)),
    };
    let mut buffer = [0; 1024];
    let mut bytes = Vec::new();
    loop {
        work.checkpoint(&context.cancel)
            .await
            .map_err(error_status)?;
        let count = endpoint
            .read_cancelled(&mut buffer, &context.cancel)
            .await
            .map_err(io_status)?;
        if count == 0 {
            break;
        }
        if count > context.limits().expansion_bytes.saturating_sub(bytes.len()) {
            return Err(2);
        }
        let capacity = bytes.capacity();
        let growth = (bytes.len() + count).saturating_sub(capacity);
        work.admit_storage(growth).map_err(error_status)?;
        bytes.try_reserve_exact(count).map_err(|_| 2)?;
        work.admit_storage(bytes.capacity() - capacity - growth)
            .map_err(error_status)?;
        bytes.extend_from_slice(&buffer[..count]);
    }
    String::from_utf8(bytes).map_err(|_| 2)
}
