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

fn keyword(name: &str) -> bool {
    matches!(
        name,
        "if" | "then"
            | "else"
            | "elif"
            | "fi"
            | "case"
            | "esac"
            | "for"
            | "select"
            | "while"
            | "until"
            | "do"
            | "done"
            | "in"
            | "function"
            | "time"
            | "{"
            | "}"
            | "!"
            | "[["
            | "]]"
            | "coproc"
    )
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

async fn output(fds: &Descriptors, context: &Context, bytes: &[u8]) -> Result<(), i32> {
    let output = fds.borrow().get(1).ok_or(1)?;
    output
        .write_all(bytes, &context.cancel)
        .await
        .map_err(|error| error.status())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Resolution {
    Executable(String),
    NonExecutable(String),
    Missing,
}

/// Ask the process host's executable registry for X_OK. This is deliberately
/// not a spawn probe: each request is cancellable and uses the host's shared
/// admission and readiness path.
pub(super) async fn executable(
    name: &str,
    state: &SharedState,
    default_path: bool,
    context: &Context,
    work: &mut expand::Work,
) -> Result<Resolution, i32> {
    let (cwd, path, path_unset, path_empty) = {
        let state = state.borrow();
        let path_unset = state.scalar_parameter("PATH").is_none() && !default_path;
        let path = if default_path {
            "/usr/bin:/bin"
        } else {
            state.scalar_parameter("PATH").unwrap_or(if default_path {
                "/usr/bin:/bin"
            } else {
                "."
            })
        };
        work.admit_storage(cwd_storage(&state.cwd, path)?)
            .map_err(admission_status)?;
        (
            state.cwd.clone(),
            path.to_owned(),
            path_unset,
            path.is_empty(),
        )
    };
    let explicit = name.contains('/');
    let mut entries = path.split(':');
    let mut non_executable = None;
    let mut blocked = false;
    let mut blocked_before_non_executable = false;
    loop {
        let candidate = if explicit {
            work.admit_storage(name.len()).map_err(admission_status)?;
            name.to_owned()
        } else {
            let Some(directory) = entries.next() else {
                return Ok(if blocked_before_non_executable {
                    Resolution::Missing
                } else {
                    non_executable
                        .map(Resolution::NonExecutable)
                        .unwrap_or(Resolution::Missing)
                });
            };
            let bytes = directory
                .len()
                .checked_add(name.len())
                .and_then(|bytes| bytes.checked_add(1))
                .ok_or(2)?;
            work.admit_storage(bytes).map_err(admission_status)?;
            if directory.is_empty() {
                format!("./{name}")
            } else if (path_unset || path_empty) && directory == "." {
                absolute(&cwd, name)
            } else {
                format!("{directory}/{name}")
            }
        };
        for _ in candidate.bytes() {
            work.checkpoint(&context.cancel)
                .await
                .map_err(admission_status)?;
        }
        work.admit_storage(
            cwd.len()
                .checked_add(candidate.len())
                .and_then(|bytes| bytes.checked_add(1))
                .ok_or(2)?,
        )
        .map_err(admission_status)?;
        let result = context
            .cancel
            .run(context.core.host.access(candidate.clone(), cwd.clone()))
            .await
            .map_err(|_| context.cancel_status())?;
        match result {
            Ok(()) => return Ok(Resolution::Executable(candidate)),
            Err(ProcessError::Runtime(2)) => {
                if non_executable.is_none() {
                    blocked_before_non_executable = blocked;
                    non_executable = Some(candidate);
                }
            }
            Err(ProcessError::Runtime(54)) if explicit => {
                non_executable = Some(candidate);
            }
            Err(ProcessError::Runtime(54)) => {
                blocked = true;
            }
            Err(ProcessError::Runtime(44)) if explicit => {
                let absolute = absolute(&cwd, &candidate);
                match context
                    .cancel
                    .run(context.fs().stat(&absolute, true))
                    .await
                    .map_err(|_| context.cancel_status())?
                {
                    Ok(_) | Err(io::IoError::NotDirectory) => {
                        non_executable = Some(candidate);
                    }
                    Err(io::IoError::NotFound) => {}
                    Err(_) => {}
                }
            }
            Err(ProcessError::Runtime(44)) => {}
            Err(ProcessError::Runtime(errno)) => return Err(errno.max(2)),
            Err(_) => return Err(2),
        }
        if explicit {
            return Ok(non_executable
                .map(Resolution::NonExecutable)
                .unwrap_or(Resolution::Missing));
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
    for name in args {
        for _ in name.bytes() {
            work.checkpoint(&context.cancel)
                .await
                .map_err(admission_status)?;
        }
        let function = state.borrow().functions.get(name).cloned();
        if keyword(name) {
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
                    Err(_) => {
                        if context.cancel.is_cancelled() {
                            return Err(context.cancel_status());
                        }
                        diagnostic(
                            fds,
                            context,
                            b"command: function description exceeds memory or print-work limit\n",
                        )
                        .await?;
                        return Err(2);
                    }
                };
                work.admit_storage(rendered.len())
                    .map_err(admission_status)?;
                output(fds, context, rendered.as_bytes()).await?;
                output(fds, context, b"\n").await?;
            }
        } else if (builtins::is_builtin(name)
            && !matches!(name.as_str(), "cat" | "grep" | "mkdir" | "seq"))
            || matches!(name.as_str(), "exec" | "eval" | "let")
        {
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
            let resolution = executable(name, state, options.default_path, context, work).await?;
            let path = match resolution {
                Resolution::Executable(path) => path,
                Resolution::NonExecutable(path) if name.contains('/') => {
                    if options.verbose {
                        diagnostic(fds, context, b"command: ").await?;
                        diagnostic(fds, context, name.as_bytes()).await?;
                        diagnostic(fds, context, b": not found\n").await?;
                    }
                    continue;
                }
                Resolution::NonExecutable(path) => path,
                Resolution::Missing => {
                    if options.verbose {
                        diagnostic(fds, context, b"command: ").await?;
                        diagnostic(fds, context, name.as_bytes()).await?;
                        diagnostic(fds, context, b": not found\n").await?;
                    }
                    continue;
                }
            };
            let display_path = if options.verbose && !name.contains('/') && !path.starts_with('/') {
                let cwd = state.borrow().cwd.clone();
                format!("{cwd}/{path}")
            } else {
                path
            };
            if options.verbose {
                output(fds, context, name.as_bytes()).await?;
                output(fds, context, b" is ").await?;
            }
            output(fds, context, display_path.as_bytes()).await?;
            output(fds, context, b"\n").await?;
        }
        found = true;
    }
    Ok(Outcome::status(i32::from(!found)))
}
