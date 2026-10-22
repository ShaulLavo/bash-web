//! cd, pushd, popd and dirs written for this engine. Behavior follows recorded
//! GNU Bash 5.3.15 runs; Bash's cd_builtin, change_to_directory, bindpwd and
//! pushd.def are named as semantic references only. Only logical paths are
//! supported. Bash's physical modes (`cd -P`, and the raw-path chdir after
//! logical canonicalization fails) need symlink resolution, which the host
//! filesystem contract does not offer, so they fail explicitly.
use super::{diagnose, error_status, write};
use crate::{
    expand::Work,
    interpreter::{Context, Outcome},
    io::{FdTable, FileKind, FileMetadata, IoError, MAX_PATH_BYTES},
    state::{SharedState, State},
};

const CD_USAGE: &str = "cd: usage: cd [-L|[-P [-e]]] [-@] [dir]\n";
const PUSHD_USAGE: &str = "pushd: usage: pushd [-n] [+N | -N | dir]\n";
const POPD_USAGE: &str = "popd: usage: popd [-n] [+N | -N]\n";
const DIRS_USAGE: &str = "dirs: usage: dirs [-clpv] [+N] [-N]\n";

/// Why a directory change was refused: a host failure, or a local path-length
/// or capability refusal. Successful opens are never used as metadata.
enum Refusal {
    Missing,
    NotDirectory,
    Denied,
    TooLong,
    /// The host does not report search permission for the directory.
    PermissionUnknown,
    /// Bash would retry the raw path physically and adopt getcwd's answer.
    Physical,
    Host(IoError),
}
impl Refusal {
    fn from_error(error: IoError) -> Self {
        match error {
            IoError::NotFound => Self::Missing,
            IoError::NotDirectory => Self::NotDirectory,
            // WASI errno 2 is EACCES.
            IoError::Runtime(2) => Self::Denied,
            error => Self::Host(error),
        }
    }
    fn message(&self) -> String {
        match self {
            Self::Missing => "No such file or directory".into(),
            Self::NotDirectory => "Not a directory".into(),
            Self::Denied => "Permission denied".into(),
            Self::TooLong => "File name too long".into(),
            Self::PermissionUnknown => "directory search permission unavailable".into(),
            Self::Physical => "physical directory resolution unsupported".into(),
            Self::Host(error) => error.to_string(),
        }
    }
}

async fn step(context: &Context, work: &mut Work) -> Result<(), i32> {
    work.checkpoint(&context.cancel).await.map_err(error_status)
}

async fn complain(
    name: &str,
    message: &str,
    usage: Option<&str>,
    fds: &FdTable,
    context: &Context,
) -> Result<(), i32> {
    let mut text = format!("/usr/bin/bash: {name}: {message}\n");
    text.push_str(usage.unwrap_or(""));
    diagnose(fds, &text, context).await
}

async fn fail(
    name: &str,
    message: &str,
    usage: Option<&str>,
    status: i32,
    fds: &FdTable,
    context: &Context,
) -> Result<Outcome, i32> {
    complain(name, message, usage, fds, context).await?;
    Ok(Outcome::status(status))
}

/// Output on a closed stdout is reported like Bash's sh_chkwrite. It never
/// undoes a directory change; callers decide whether it fails the command.
async fn emit(name: &str, text: &str, fds: &FdTable, context: &Context) -> Result<bool, i32> {
    match write(fds, text.as_bytes(), context).await {
        Ok(()) => Ok(true),
        Err(1) => {
            complain(name, "write error: Bad file descriptor", None, fds, context).await?;
            Ok(false)
        }
        Err(status) => Err(status),
    }
}

/// cd prints before publishing PWD. A write that fails with status 1 is reported,
/// publication still runs and the command returns 1. Other write failures and
/// cancellation return before anything is published.
async fn announce_and_commit(
    name: &str,
    shown: Option<&str>,
    cwd: String,
    state: &SharedState,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<i32, i32> {
    let printed = match shown {
        Some(text) => emit(name, &format!("{text}\n"), fds, context).await?,
        None => true,
    };
    let status = commit(cwd, state, fds, context, work).await?;
    Ok(if printed { status } else { 1 })
}

async fn variable(
    name: &str,
    state: &SharedState,
    context: &Context,
    work: &mut Work,
) -> Result<Option<String>, i32> {
    State::admit_scalar_access(state, name, &context.cancel, work)
        .await
        .map_err(error_status)?;
    let bytes = state.borrow().scalar_parameter(name).map_or(0, str::len);
    work.admit_storage(bytes).map_err(error_status)?;
    Ok(state.borrow().scalar_parameter(name).map(str::to_owned))
}

async fn stat(
    path: &str,
    context: &Context,
    work: &mut Work,
) -> Result<Result<FileMetadata, IoError>, i32> {
    step(context, work).await?;
    match context
        .cancel
        .run(context.fs().stat(path, true))
        .await
        .map_err(|_| 130)?
    {
        Err(IoError::Cancelled) => Err(130),
        result => Ok(result),
    }
}

async fn directory(
    path: &str,
    context: &Context,
    work: &mut Work,
) -> Result<Option<FileMetadata>, i32> {
    Ok(stat(path, context, work)
        .await?
        .ok()
        .filter(|metadata| metadata.kind == FileKind::Directory))
}

/// chdir's own check: a directory the caller may search. Unknown permission
/// is a capability failure, never a pass.
fn searchable(metadata: &FileMetadata) -> Result<(), Refusal> {
    if metadata.kind != FileKind::Directory {
        return Err(Refusal::NotDirectory);
    }
    match metadata.executable {
        Some(true) => Ok(()),
        Some(false) => Err(Refusal::Denied),
        None => Err(Refusal::PermissionUnknown),
    }
}

/// Bash absolute_pathname: these operands skip CDPATH.
fn explicit(operand: &str) -> bool {
    operand.starts_with('/')
        || operand == "."
        || operand == ".."
        || operand.starts_with("./")
        || operand.starts_with("../")
}

/// sh_canonpath with PATH_CHECKDOTDOT and PATH_CHECKEXISTS: lexical, except
/// that the path before each `..` and the result must be directories.
async fn canonical(
    raw: &str,
    context: &Context,
    work: &mut Work,
) -> Result<Option<(String, FileMetadata)>, i32> {
    // POSIX leaves exactly two leading slashes implementation-defined; Bash keeps them.
    let double = raw.starts_with("//") && !raw.starts_with("///");
    let mut path = String::new();
    for part in raw.split('/') {
        step(context, work).await?;
        if part == ".."
            && directory(&rooted(double, &path), context, work)
                .await?
                .is_none()
        {
            return Ok(None);
        }
        match part {
            "" | "." => {}
            ".." => path.truncate(path.rfind('/').unwrap_or(0)),
            part => path.extend(["/", part]),
        }
    }
    let path = rooted(double, &path);
    Ok(directory(&path, context, work)
        .await?
        .map(|metadata| (path, metadata)))
}

/// Components are kept as `/a/b`; the root itself is `/` or `//`.
fn rooted(double: bool, path: &str) -> String {
    let root = if double { "/" } else { "" };
    if path.is_empty() {
        format!("{root}/")
    } else {
        format!("{root}{path}")
    }
}

/// change_to_directory in logical mode, without changing anything.
async fn resolve(
    target: &str,
    state: &SharedState,
    context: &Context,
    work: &mut Work,
) -> Result<Result<String, Refusal>, i32> {
    let cwd_bytes = if target.starts_with('/') {
        0
    } else {
        state.borrow().cwd.len() + 1
    };
    let bytes = cwd_bytes.saturating_add(target.len());
    if bytes > MAX_PATH_BYTES {
        return Ok(Err(Refusal::TooLong));
    }
    // The raw path, its canonical copy and each prefix probe.
    work.admit_storage(bytes.saturating_mul(3))
        .map_err(error_status)?;
    let raw = if cwd_bytes == 0 {
        target.to_owned()
    } else {
        let cwd = state.borrow().cwd.clone();
        let separator = if cwd.ends_with('/') { "" } else { "/" };
        format!("{cwd}{separator}{target}")
    };
    if let Some((path, metadata)) = canonical(&raw, context, work).await? {
        return Ok(searchable(&metadata).map(|()| path));
    }
    // Bash now tries chdir on the raw path. Its error is the real answer; a
    // success would need the physical working directory.
    Ok(Err(match stat(&raw, context, work).await? {
        Err(error) => Refusal::from_error(error),
        Ok(metadata) => searchable(&metadata).err().unwrap_or(Refusal::Physical),
    }))
}

/// Bash bindpwd. The directory change itself is never undone: a readonly
/// OLDPWD or PWD only fails the command.
async fn commit(
    cwd: String,
    state: &SharedState,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<i32, i32> {
    let previous = variable("PWD", state, context, work)
        .await?
        .unwrap_or_default();
    for (name, bytes) in [("OLDPWD", previous.len()), ("PWD", cwd.len())] {
        State::admit_assignment(state, name, bytes, &context.cancel, work)
            .await
            .map_err(error_status)?;
    }
    work.admit_storage(cwd.len()).map_err(error_status)?;
    state.borrow_mut().cwd = cwd.clone();
    let mut status = 0;
    for (name, value) in [("OLDPWD", previous), ("PWD", cwd)] {
        let result = state.borrow_mut().assign_parameter(name.into(), value);
        status = status.max(published(name, result, fds, context).await?);
    }
    Ok(status)
}

/// A readonly binding is reported and fails the command; other errors abort.
async fn published(
    name: &str,
    result: Result<(), i32>,
    fds: &FdTable,
    context: &Context,
) -> Result<i32, i32> {
    match result {
        Ok(()) => Ok(0),
        Err(1) => {
            let text = format!("/usr/bin/bash: {name}: readonly variable\n");
            diagnose(fds, &text, context).await?;
            Ok(1)
        }
        Err(error) => Err(error),
    }
}

/// Bash cd_builtin after its options, shared by cd, pushd and popd. Failures
/// are reported under `name`; the result is the command status.
async fn change(
    name: &str,
    operand: Option<&str>,
    state: &SharedState,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<i32, i32> {
    let (target, print) = match operand {
        None => match variable("HOME", state, context, work).await? {
            Some(home) => (home, false),
            None => return refuse(name, "HOME not set", fds, context).await,
        },
        Some("") => return refuse(name, "null directory", fds, context).await,
        Some("-") => match variable("OLDPWD", state, context, work).await? {
            Some(previous) => (previous, true),
            None => return refuse(name, "OLDPWD not set", fds, context).await,
        },
        Some(operand) => (operand.to_owned(), false),
    };
    if operand.is_some_and(|operand| operand != "-" && !explicit(operand))
        && let Some(cdpath) = variable("CDPATH", state, context, work).await?
        && let Some(status) = search(name, &target, &cdpath, state, fds, context, work).await?
    {
        return Ok(status);
    }
    match resolve(&target, state, context, work).await? {
        Ok(cwd) => {
            let shown = print.then_some(target.as_str());
            announce_and_commit(name, shown, cwd, state, fds, context, work).await
        }
        Err(refusal) => {
            let message = format!("{target}: {}", refusal.message());
            refuse(name, &message, fds, context).await
        }
    }
}

async fn refuse(name: &str, message: &str, fds: &FdTable, context: &Context) -> Result<i32, i32> {
    complain(name, message, None, fds, context).await?;
    Ok(1)
}

/// CDPATH entries in order; an empty entry means the current directory. A hit
/// through a non-empty entry prints the new directory, as POSIX requires.
async fn search(
    name: &str,
    target: &str,
    cdpath: &str,
    state: &SharedState,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<Option<i32>, i32> {
    if cdpath.is_empty() {
        return Ok(None);
    }
    for entry in cdpath.split(':') {
        step(context, work).await?;
        let candidate = match entry {
            "" => format!("./{target}"),
            entry if entry.ends_with('/') => format!("{entry}{target}"),
            entry => format!("{entry}/{target}"),
        };
        let Ok(cwd) = resolve(&candidate, state, context, work).await? else {
            continue;
        };
        let shown = (!entry.is_empty()).then(|| cwd.clone());
        let status =
            announce_and_commit(name, shown.as_deref(), cwd, state, fds, context, work).await?;
        return Ok(Some(status));
    }
    Ok(None)
}

/// One cd option word; the last of -L and -P wins. Returns an invalid flag.
fn cd_flags(flags: &str, physical: &mut bool) -> Result<(), char> {
    for flag in flags.chars() {
        match flag {
            'L' => *physical = false,
            'P' => *physical = true,
            'e' => {}
            flag => return Err(flag),
        }
    }
    Ok(())
}

pub(super) async fn cd(
    args: &[String],
    state: &SharedState,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<Outcome, i32> {
    let mut physical = false;
    let mut index = 0;
    while let Some(word) = args.get(index) {
        step(context, work).await?;
        if word == "--" {
            index += 1;
            break;
        }
        let Some(flags) = word.strip_prefix('-').filter(|flags| !flags.is_empty()) else {
            break;
        };
        if let Err(flag) = cd_flags(flags, &mut physical) {
            let message = format!("-{flag}: invalid option");
            return fail("cd", &message, Some(CD_USAGE), 2, fds, context).await;
        }
        index += 1;
    }
    let operands = &args[index..];
    if operands.len() > 1 {
        return fail("cd", "too many arguments", None, 2, fds, context).await;
    }
    if physical {
        let message = "-P: physical directory resolution unsupported";
        return fail("cd", message, None, 1, fds, context).await;
    }
    let operand = operands.first().map(String::as_str);
    let status = change("cd", operand, state, fds, context, work).await?;
    Ok(Outcome::status(status))
}

/// Bash legal_number: optional surrounding whitespace and sign, decimal only.
fn legal_number(text: &str) -> Option<i64> {
    text.trim_matches(|c: char| c.is_ascii_whitespace())
        .parse()
        .ok()
}

enum Rejected {
    Number(String),
    Option(String),
    Argument(String),
    Range(String),
}

async fn reject(
    name: &str,
    rejected: Rejected,
    usage: &str,
    stored: usize,
    fds: &FdTable,
    context: &Context,
) -> Result<Outcome, i32> {
    let (word, problem) = match rejected {
        Rejected::Range(word) => return range_error(name, &word, stored, fds, context).await,
        Rejected::Number(word) => (word, "invalid number"),
        Rejected::Option(word) => (word, "invalid option"),
        Rejected::Argument(word) => (word, "invalid argument"),
    };
    let message = format!("{word}: {problem}");
    fail(name, &message, Some(usage), 2, fds, context).await
}

async fn range_error(
    name: &str,
    word: &str,
    stored: usize,
    fds: &FdTable,
    context: &Context,
) -> Result<Outcome, i32> {
    if stored == 0 {
        return fail(name, "directory stack empty", None, 1, fds, context).await;
    }
    let message = format!("{word}: directory stack index out of range");
    fail(name, &message, None, 1, fds, context).await
}

fn signed(word: &str) -> bool {
    word.starts_with(['+', '-'])
}

fn number(word: &str) -> Result<i64, Rejected> {
    legal_number(&word[1..]).ok_or_else(|| Rejected::Number(word.to_owned()))
}

struct PushdOptions {
    nocd: bool,
    rotation: Option<usize>,
    /// Index of the first operand.
    operands: usize,
}

/// pushd_builtin's option loop. Every other signed word is a number, so
/// pushd never reports an invalid option. A bare `-` is an operand, while a
/// bare `+` is an invalid number.
fn pushd_options(args: &[String], stored: usize) -> Result<PushdOptions, Rejected> {
    let mut options = PushdOptions {
        nocd: false,
        rotation: None,
        operands: args.len(),
    };
    for (index, word) in args.iter().enumerate() {
        if !pushd_option(&mut options, word, stored)? {
            options.operands = index + usize::from(word == "--");
            break;
        }
    }
    Ok(options)
}

/// Applies one pushd option word; false ends the options.
fn pushd_option(options: &mut PushdOptions, word: &str, stored: usize) -> Result<bool, Rejected> {
    match word {
        "-n" => options.nocd = true,
        "--" => return Ok(false),
        word if word != "-" && signed(word) => options.rotation = Some(rotation(word, stored)?),
        _ => return Ok(false),
    }
    Ok(true)
}

fn rotation(word: &str, stored: usize) -> Result<usize, Rejected> {
    let count = number(word)?;
    let count = if word.starts_with('-') {
        (stored as i64).saturating_sub(count)
    } else {
        count
    };
    usize::try_from(count)
        .ok()
        .filter(|count| *count <= stored)
        .ok_or_else(|| Rejected::Range(word.to_owned()))
}

pub(super) async fn pushd(
    args: &[String],
    state: &SharedState,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<Outcome, i32> {
    let parse = args.first().is_none_or(|word| word != "--");
    let args = if parse { args } else { &args[1..] };
    if args.is_empty() {
        return swap(state, fds, context, work).await;
    }
    let stored = state.borrow().directories().len();
    let options = if parse {
        pushd_options(args, stored)
    } else {
        Ok(PushdOptions {
            nocd: false,
            rotation: None,
            operands: 0,
        })
    };
    let options = match options {
        Ok(options) => options,
        Err(rejected) => return reject("pushd", rejected, PUSHD_USAGE, stored, fds, context).await,
    };
    if let Some(count) = options.rotation {
        return rotate(count, options.nocd, state, fds, context, work).await;
    }
    let operands = &args[options.operands..];
    let Some(operand) = operands.first() else {
        return Ok(Outcome::status(0));
    };
    if operands.len() > 1 {
        return fail("pushd", "too many arguments", None, 1, fds, context).await;
    }
    // The pushed stack is admitted before cd changes anything and published
    // only after it succeeds; failure or cancellation drops it.
    let entry = if options.nocd {
        operand.clone()
    } else {
        state.borrow().cwd.clone()
    };
    let pushed = state.borrow().prepare_push_directory(entry)?;
    if !options.nocd && change("pushd", Some(operand), state, fds, context, work).await? != 0 {
        return Ok(Outcome::status(1));
    }
    state.borrow_mut().install_directories(pushed);
    print_stack("pushd", state, fds, context, work).await?;
    Ok(Outcome::status(0))
}

/// pushd without operands exchanges the current directory and the top entry.
async fn swap(
    state: &SharedState,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<Outcome, i32> {
    let Some(top) = state.borrow().directories().last().cloned() else {
        return fail("pushd", "no other directory", None, 1, fds, context).await;
    };
    work.admit_storage(top.len()).map_err(error_status)?;
    // Bash swaps before changing directory and keeps the swap when cd fails.
    let cwd = state.borrow().cwd.clone();
    state.borrow_mut().replace_top_directory(cwd)?;
    let status = change("pushd", Some(&top), state, fds, context, work).await?;
    if status != 0 {
        return Ok(Outcome::status(status));
    }
    print_stack("pushd", state, fds, context, work).await?;
    Ok(Outcome::status(0))
}

/// pushd +N/-N rotates the ring of the current directory and the stack. As in
/// Bash, the rotation stays when the following cd fails, and with -n the
/// rotated-out entry is dropped without a cd or a listing.
async fn rotate(
    count: usize,
    nocd: bool,
    state: &SharedState,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<Outcome, i32> {
    let target = if count == 0 {
        state.borrow().cwd.clone()
    } else {
        state.borrow_mut().rotate_directories(count)?
    };
    if nocd {
        return Ok(Outcome::status(0));
    }
    let status = change("pushd", Some(&target), state, fds, context, work).await?;
    if status == 0 {
        print_stack("pushd", state, fds, context, work).await?;
    }
    Ok(Outcome::status(status))
}

#[derive(Default)]
struct PopdOptions {
    nocd: bool,
    which: i64,
    minus: bool,
    word: String,
}
impl PopdOptions {
    fn select(&mut self, word: &str) -> Result<(), Rejected> {
        self.which = number(word)?;
        self.minus = word.starts_with('-');
        self.word = word.to_owned();
        Ok(())
    }
}

fn popd_options(args: &[String]) -> Result<PopdOptions, Rejected> {
    let mut options = PopdOptions::default();
    for word in args {
        match word.as_str() {
            "-n" => options.nocd = true,
            "--" | "" => break,
            word if signed(word) => options.select(word)?,
            word => return Err(Rejected::Argument(word.to_owned())),
        }
    }
    Ok(options)
}

pub(super) async fn popd(
    args: &[String],
    state: &SharedState,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<Outcome, i32> {
    let parsed = popd_options(args);
    let stored = state.borrow().directories().len();
    let options = match parsed {
        Ok(options) => options,
        Err(rejected) => return reject("popd", rejected, POPD_USAGE, stored, fds, context).await,
    };
    let (which, count) = (options.which, stored as i64);
    if which > count || which < -count || (stored == 0 && which == 0) {
        return range_error("popd", &options.word, stored, fds, context).await;
    }
    if (!options.minus && which == 0) || (options.minus && which == count) {
        return pop_top(options.nocd, state, fds, context, work).await;
    }
    let position = if options.minus { which } else { count - which };
    let Some(position) = usize::try_from(position).ok().filter(|p| *p < stored) else {
        return range_error("popd", &options.word, stored, fds, context).await;
    };
    state.borrow_mut().remove_directory(position)?;
    print_stack("popd", state, fds, context, work).await?;
    Ok(Outcome::status(0))
}

/// popd's top entry: change there first and keep the entry if that fails.
async fn pop_top(
    nocd: bool,
    state: &SharedState,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<Outcome, i32> {
    // As in pushd, the shorter stack is admitted before the cd and published
    // only after it succeeds.
    let popped = state.borrow().prepare_pop_directory()?;
    if !nocd {
        let top = state
            .borrow()
            .directories()
            .last()
            .cloned()
            .unwrap_or_default();
        work.admit_storage(top.len()).map_err(error_status)?;
        let status = change("popd", Some(&top), state, fds, context, work).await?;
        if status != 0 {
            return Ok(Outcome::status(status));
        }
    }
    state.borrow_mut().install_directories(popped);
    print_stack("popd", state, fds, context, work).await?;
    Ok(Outcome::status(0))
}

/// pushd and popd list the stack after a change; the change is already done,
/// so a closed stdout is reported without failing them.
async fn print_stack(
    name: &str,
    state: &SharedState,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<(), i32> {
    let text = listing(&Listing::default(), state, context, work).await?;
    emit(name, &text, fds, context).await.map(|_| ())
}

#[derive(Default)]
struct Listing {
    long: bool,
    /// Bash's vflag: 1 prints one entry per line, 2 also numbers them.
    lines: u8,
    /// A single display position, counted from the current directory.
    only: Option<usize>,
}

/// Bash polite_directory_format: a HOME prefix ending at a path boundary
/// becomes `~`. HOME must be longer than `/`.
fn polite(entry: &str, home: &str, long: bool) -> String {
    let tail = entry
        .strip_prefix(home)
        .filter(|tail| tail.is_empty() || tail.starts_with('/'));
    match tail {
        Some(tail) if !long && home.len() > 1 => format!("~{tail}"),
        _ => entry.to_owned(),
    }
}

async fn listing(
    format: &Listing,
    state: &SharedState,
    context: &Context,
    work: &mut Work,
) -> Result<String, i32> {
    let home = variable("HOME", state, context, work)
        .await?
        .unwrap_or_default();
    let entries = {
        let state = state.borrow();
        let stored = state.directories();
        let bytes = stored.iter().map(String::len).sum::<usize>() + state.cwd.len();
        // The copies, tilde forms, numbers and separators.
        work.admit_storage(bytes.saturating_mul(2) + 8 * (stored.len() + 1))
            .map_err(error_status)?;
        let mut entries = vec![state.cwd.clone()];
        entries.extend(stored.iter().rev().cloned());
        entries
    };
    let mut text = String::new();
    for (position, entry) in entries.iter().enumerate() {
        step(context, work).await?;
        if format.only.is_some_and(|only| only != position) {
            continue;
        }
        let entry = polite(entry, &home, format.long);
        let separator = match (position, format.only, format.lines) {
            (0, _, _) | (_, Some(_), _) => "",
            (_, None, 0) => " ",
            _ => "\n",
        };
        text.push_str(separator);
        if format.lines >= 2 {
            text.push_str(&format!("{position:2}  "));
        }
        text.push_str(&entry);
    }
    text.push('\n');
    Ok(text)
}

#[derive(Default)]
struct DirsOptions {
    format: Listing,
    clear: bool,
    /// A requested position, or the number word Bash reports out of range.
    index: Option<Result<usize, String>>,
}

fn dirs_options(args: &[String], stored: usize) -> Result<DirsOptions, Rejected> {
    let mut options = DirsOptions::default();
    for word in args {
        match word.as_str() {
            "-l" => options.format.long = true,
            "-c" => options.clear = true,
            "-v" => options.format.lines |= 2,
            "-p" => options.format.lines |= 1,
            "--" => break,
            word if signed(word) => options.index = Some(position(word, stored)?),
            word => return Err(Rejected::Option(word.to_owned())),
        }
    }
    Ok(options)
}

/// Bash get_dirstack_index in display order: +N counts from the current
/// directory and -N from the bottom entry.
fn position(word: &str, stored: usize) -> Result<Result<usize, String>, Rejected> {
    let count = number(word)?;
    let count = usize::try_from(count).ok().filter(|count| *count <= stored);
    let position = count.map(|count| {
        if word.starts_with('+') {
            count
        } else {
            stored - count
        }
    });
    Ok(position.ok_or_else(|| word[1..].to_owned()))
}

pub(super) async fn dirs(
    args: &[String],
    state: &SharedState,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<Outcome, i32> {
    let stored = state.borrow().directories().len();
    let mut options = match dirs_options(args, stored) {
        Ok(options) => options,
        Err(rejected) => return reject("dirs", rejected, DIRS_USAGE, stored, fds, context).await,
    };
    if options.clear {
        state.borrow_mut().clear_directories();
        return Ok(Outcome::status(0));
    }
    options.format.only = match options.index {
        Some(Err(word)) => return range_error("dirs", &word, stored, fds, context).await,
        Some(Ok(position)) => Some(position),
        None => None,
    };
    let text = listing(&options.format, state, context, work).await?;
    let printed = emit("dirs", &text, fds, context).await?;
    Ok(Outcome::status(if printed { 0 } else { 1 }))
}

#[cfg(test)]
mod tests;
