//! Original `command` adapter. Dispatch stays in the interpreter so bypassing a
//! function does not create a subshell or change positional/local ownership.
use super::*;

pub(super) struct Options {
    pub(super) query: bool,
    pub(super) verbose: bool,
    pub(super) default_path: bool,
    pub(super) operands: usize,
}

pub(super) async fn options(
    args: &[String],
    fds: &Descriptors,
    context: &Context,
    work: &mut expand::Work,
) -> Result<Options, i32> {
    let mut options = Options {
        query: false,
        verbose: false,
        default_path: false,
        operands: 0,
    };
    for arg in args {
        if arg == "--" {
            options.operands += 1;
            break;
        }
        if !arg.starts_with('-') || arg == "-" {
            break;
        }
        for flag in arg[1..].bytes() {
            work.checkpoint(&context.cancel)
                .await
                .map_err(admission_status)?;
            match flag {
                b'p' => options.default_path = true,
                b'v' => {
                    options.query = true;
                    options.verbose = false;
                }
                b'V' => {
                    options.query = true;
                    options.verbose = true;
                }
                _ => {
                    diagnostic(fds, context, b"command: invalid option\ncommand: usage: command [-pVv] command [arg ...]\n").await?;
                    return Err(2);
                }
            }
        }
        options.operands += 1;
    }
    Ok(options)
}

pub(super) async fn diagnostic(
    fds: &Descriptors,
    context: &Context,
    bytes: &[u8],
) -> Result<(), i32> {
    let error = fds.borrow().get(2);
    if let Some(error) = error {
        error
            .write_all(bytes, &context.cancel)
            .await
            .map_err(|error| error.status())?;
    }
    Ok(())
}

/// Stream the diagnostic without allocating another copy of an admitted path.
pub(super) async fn execution_failure(
    fds: &Descriptors,
    context: &Context,
    name: &str,
    reason: &[u8],
) -> Result<(), i32> {
    diagnostic(fds, context, b"/usr/bin/bash: ").await?;
    diagnostic(fds, context, name.as_bytes()).await?;
    diagnostic(fds, context, b": ").await?;
    diagnostic(fds, context, reason).await?;
    diagnostic(fds, context, b"\n").await
}

pub(super) async fn output(fds: &Descriptors, context: &Context, bytes: &[u8]) -> Result<(), i32> {
    let output = fds.borrow().get(1).ok_or(1)?;
    output
        .write_all(bytes, &context.cancel)
        .await
        .map_err(|error| error.status())
}

pub(super) struct PathStorage {
    _local: crate::exec::StorageAllocation,
    _global: crate::exec::Allocation,
}

pub(super) struct PathString {
    pub(super) text: String,
    storage: PathStorage,
}
impl PathString {
    pub(super) fn into_parts(self) -> (String, PathStorage) {
        (self.text, self.storage)
    }
}

/// PATH has its own live-byte ceiling, independent from argv admission. Scan
/// fuel is cumulative for the whole command; string tickets refund on drop and
/// also reserve the session-wide execution budget before each allocation.
pub(super) struct LookupWork {
    storage: crate::exec::StorageBudget,
    scan: expand::Work,
}
impl LookupWork {
    pub(super) fn new(limits: &Limits) -> Self {
        Self {
            storage: crate::exec::StorageBudget::new(limits.path_bytes),
            scan: expand::Work::new(limits.path_bytes.saturating_add(limits.arguments), 0, 0),
        }
    }
    fn admit(&self, bytes: usize, context: &Context) -> Result<PathStorage, i32> {
        let local = self.storage.admit(bytes)?;
        let global = context.evaluation.admit_execution(bytes)?;
        Ok(PathStorage {
            _local: local,
            _global: global,
        })
    }
    fn copy(&self, text: &str, context: &Context) -> Result<PathString, i32> {
        let storage = self.admit(text.len(), context)?;
        Ok(PathString {
            text: text.to_owned(),
            storage,
        })
    }
    fn join(&self, prefix: &str, name: &str, context: &Context) -> Result<PathString, i32> {
        let separator = if prefix.ends_with('/') { "" } else { "/" };
        let bytes = prefix
            .len()
            .checked_add(separator.len())
            .and_then(|bytes| bytes.checked_add(name.len()))
            .ok_or(2)?;
        let storage = self.admit(bytes, context)?;
        let mut text = String::with_capacity(bytes);
        text.push_str(prefix);
        text.push_str(separator);
        text.push_str(name);
        Ok(PathString { text, storage })
    }
}

pub(super) enum Resolution {
    Executable(PathString),
    NonExecutable(PathString, &'static [u8]),
    Missing,
}

/// Ask the process host's executable registry for X_OK. This is deliberately
/// not a spawn probe: each request is cancellable and uses the host's shared
/// admission and readiness path.
pub(super) async fn executable(
    name: &str,
    state: &SharedState,
    default_path: bool,
    path_override: Option<&str>,
    context: &Context,
    work: &mut LookupWork,
) -> Result<Resolution, i32> {
    if name.is_empty() {
        return Ok(Resolution::Missing);
    }
    ExecutableSearch::new(name, state, default_path, path_override, context, work)?
        .next(name, context, work)
        .await
}

/// One admitted cwd/PATH snapshot and a resumable cursor over that same search.
/// Repeated `type -a` hits must not recopy the whole PATH for every result.
pub(super) struct ExecutableSearch {
    cwd: String,
    path: String,
    path_unset: bool,
    explicit: bool,
    cursor: usize,
    _storage: PathStorage,
}
impl ExecutableSearch {
    pub(super) fn new(
        name: &str,
        state: &SharedState,
        default_path: bool,
        path_override: Option<&str>,
        context: &Context,
        work: &LookupWork,
    ) -> Result<Self, i32> {
        let explicit = name.contains('/');
        let state = state.borrow();
        let environment_path = path_override.or_else(|| state.scalar_parameter("PATH"));
        let path_unset = environment_path.is_none() && !default_path;
        // Slash operands do not consult PATH, even for resource admission.
        let path = if explicit {
            ""
        } else if default_path {
            "/usr/bin:/bin"
        } else {
            environment_path.unwrap_or(".")
        };
        let storage = work.admit(cwd_storage(&state.cwd, path)?, context)?;
        Ok(Self {
            cwd: state.cwd.clone(),
            path: path.to_owned(),
            path_unset,
            explicit,
            cursor: 0,
            _storage: storage,
        })
    }
    pub(super) async fn next(
        &mut self,
        name: &str,
        context: &Context,
        work: &mut LookupWork,
    ) -> Result<Resolution, i32> {
        if name.is_empty() {
            return Ok(Resolution::Missing);
        }
        let cwd = &self.cwd;
        let path = &self.path;
        let path_unset = self.path_unset;
        let explicit = self.explicit;
        let cursor = &mut self.cursor;
        let Some(remaining) = path.get(*cursor..) else {
            return Ok(Resolution::Missing);
        };
        let mut entries = remaining.split(':');
        let mut non_executable = None;
        // Bash remembers the first existing candidate, including a directory. A
        // directory before a non-runnable regular file suppresses that fallback;
        // failed metadata lookups (e.g. ENOTDIR ancestors) do not.
        let mut directory_seen = false;
        let mut directory_before_fallback = false;
        loop {
            let candidate = if explicit {
                work.copy(name, context)?
            } else {
                let Some(directory) = entries.next() else {
                    return Ok(if directory_before_fallback {
                        Resolution::Missing
                    } else {
                        non_executable
                            .map(|path| Resolution::NonExecutable(path, b"Permission denied"))
                            .unwrap_or(Resolution::Missing)
                    });
                };
                *cursor = cursor.saturating_add(directory.len()).saturating_add(1);
                let prefix = if path_unset {
                    cwd.as_str()
                } else if directory.is_empty() {
                    "."
                } else {
                    directory
                };
                work.join(prefix, name, context)?
            };
            for _ in candidate.text.bytes() {
                work.scan
                    .checkpoint(&context.cancel)
                    .await
                    .map_err(admission_status)?;
            }
            // Both owned copies are admitted before crossing the host boundary.
            // Retire their tickets with the completed/cancelled request, not after
            // the whole search. A retained fallback keeps its own separate ticket.
            let result = {
                let _request_storage = work.admit(cwd_storage(cwd, &candidate.text)?, context)?;
                context
                    .cancel
                    .run(
                        context
                            .core
                            .host
                            .access(candidate.text.clone(), cwd.clone()),
                    )
                    .await
                    .map_err(|_| context.cancel_status())?
            };
            match result {
                Ok(()) => return Ok(Resolution::Executable(candidate)),
                Err(ProcessError::Runtime(errno @ (2 | 31 | 44))) => {
                    // Metadata only classifies failure; it NEVER admits execution.
                    // Absolute candidates can be borrowed without another copy.
                    let absolute = if candidate.text.starts_with('/') {
                        None
                    } else {
                        Some(work.join(cwd, &candidate.text, context)?)
                    };
                    let path = absolute
                        .as_ref()
                        .map(|path| path.text.as_str())
                        .unwrap_or(&candidate.text);
                    let metadata = context
                        .cancel
                        .run(context.fs().stat(path, true))
                        .await
                        .map_err(|_| context.cancel_status())?;
                    match metadata {
                        Ok(metadata) if metadata.kind == io::FileKind::Directory => {
                            if explicit {
                                return Ok(Resolution::NonExecutable(candidate, b"Is a directory"));
                            }
                            directory_seen = true;
                        }
                        Ok(_) => {
                            if non_executable.is_none() {
                                directory_before_fallback = directory_seen;
                                non_executable = Some(candidate);
                            }
                        }
                        Err(io::IoError::NotDirectory) if explicit => {
                            return Ok(Resolution::NonExecutable(candidate, b"Not a directory"));
                        }
                        Err(io::IoError::NotFound) if errno == 44 => {}
                        Err(_) if explicit => {
                            let reason = if errno == 31 {
                                b"Is a directory".as_slice()
                            } else {
                                b"Permission denied".as_slice()
                            };
                            return Ok(Resolution::NonExecutable(candidate, reason));
                        }
                        Err(_) => {}
                    }
                }
                Err(ProcessError::Runtime(54)) if explicit => {
                    return Ok(Resolution::NonExecutable(candidate, b"Not a directory"));
                }
                Err(ProcessError::Runtime(54)) => {}
                Err(_) => return Err(2),
            }
            if explicit {
                return Ok(non_executable
                    .map(|path| Resolution::NonExecutable(path, b"Permission denied"))
                    .unwrap_or(Resolution::Missing));
            }
        }
    }
}

fn cwd_storage(cwd: &str, path: &str) -> Result<usize, i32> {
    cwd.len().checked_add(path.len()).ok_or(2)
}

pub(super) async fn query(
    args: &[String],
    options: &Options,
    state: &SharedState,
    fds: &Descriptors,
    context: &Context,
    work: &mut expand::Work,
) -> Result<Outcome, i32> {
    let mut found = args.is_empty();
    let mut lookup = LookupWork::new(context.limits());
    for name in args {
        for _ in name.bytes() {
            work.checkpoint(&context.cancel)
                .await
                .map_err(admission_status)?;
        }
        let function = state.borrow().functions().get(name).cloned();
        let command = commands::lookup(name);
        if command.is_some_and(commands::Command::query_keyword) {
            output(fds, context, name.as_bytes()).await?;
            output(
                fds,
                context,
                if options.verbose {
                    b" is a shell keyword\n"
                } else {
                    b"\n"
                },
            )
            .await?;
        } else if let Some(function) = function {
            output(fds, context, name.as_bytes()).await?;
            output(
                fds,
                context,
                if options.verbose {
                    b" is a function\n"
                } else {
                    b"\n"
                },
            )
            .await?;
            if options.verbose {
                function_description(name, &function, fds, context, work).await?;
            }
        } else if command.is_some_and(commands::Command::query_builtin) {
            output(fds, context, name.as_bytes()).await?;
            output(
                fds,
                context,
                if options.verbose {
                    b" is a shell builtin\n"
                } else {
                    b"\n"
                },
            )
            .await?;
        } else {
            let resolution = executable(
                name,
                state,
                options.default_path,
                None,
                context,
                &mut lookup,
            )
            .await?;
            let path = match resolution {
                Resolution::Executable(path) => path,
                Resolution::NonExecutable(_, _) if name.contains('/') => {
                    if options.verbose {
                        diagnostic(fds, context, b"command: ").await?;
                        diagnostic(fds, context, name.as_bytes()).await?;
                        diagnostic(fds, context, b": not found\n").await?;
                    }
                    continue;
                }
                Resolution::NonExecutable(path, _) => path,
                Resolution::Missing => {
                    if options.verbose {
                        diagnostic(fds, context, b"command: ").await?;
                        diagnostic(fds, context, name.as_bytes()).await?;
                        diagnostic(fds, context, b": not found\n").await?;
                    }
                    continue;
                }
            };
            let display_path =
                if options.verbose && !name.contains('/') && !path.text.starts_with('/') {
                    let state = state.borrow();
                    // Remove only the initial ./; retain remaining PATH spelling.
                    let relative = path.text.strip_prefix("./").unwrap_or(&path.text);
                    lookup.join(&state.cwd, relative, context)?
                } else {
                    path
                };
            if options.verbose {
                output(fds, context, name.as_bytes()).await?;
                output(fds, context, b" is ").await?;
            }
            output(fds, context, display_path.text.as_bytes()).await?;
            output(fds, context, b"\n").await?;
        }
        found = true;
    }
    Ok(Outcome::status(i32::from(!found)))
}

#[cfg(test)]
mod tests;

/// Shared AST rendering and admission for command/type function descriptions.
pub(super) async fn function_description(
    name: &str,
    function: &StoredFunction,
    fds: &Descriptors,
    context: &Context,
    work: &mut expand::Work,
) -> Result<(), i32> {
    let limit = context
        .limits()
        .expansion_bytes
        .min(work.storage_left())
        .min(context.evaluation.execution_available());
    // The printer enforces its ceiling before appending. Reserve
    // that full possible live buffer before it allocates anything.
    let _render_storage = context.evaluation.admit_execution(limit)?;
    let rendered = match function_string_bounded(
        name,
        &function.body,
        &Cell::new(limit),
        limit,
        Some(&context.parser_budget()),
    ) {
        Ok(rendered) => rendered,
        Err(_) => return function_description_failure(fds, context).await,
    };
    work.admit_storage(rendered.len())
        .map_err(admission_status)?;
    output(fds, context, rendered.as_bytes()).await?;
    output(fds, context, b"\n").await?;
    Ok(())
}

async fn function_description_failure(fds: &Descriptors, context: &Context) -> Result<(), i32> {
    if context.cancel.is_cancelled() {
        return Err(context.cancel_status());
    }
    diagnostic(
        fds,
        context,
        b"command: function description exceeds memory or print-work limit\n",
    )
    .await?;
    Err(2)
}
