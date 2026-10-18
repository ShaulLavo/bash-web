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

/// Metadata is the only truthful path-query capability: opening a file cannot
/// establish executability, and a query must never spawn a process as a probe.
pub(super) async fn executable(
    name: &str,
    state: &SharedState,
    default_path: bool,
    context: &Context,
    work: &mut expand::Work,
) -> Result<Option<String>, i32> {
    let (cwd, path) = {
        let state = state.borrow();
        let path = if default_path {
            "/usr/bin:/bin"
        } else {
            state.scalar_parameter("PATH").unwrap_or("/usr/bin:/bin")
        };
        work.admit_storage(cwd_storage(&state.cwd, path)?)
            .map_err(admission_status)?;
        (state.cwd.clone(), path.to_owned())
    };
    let mut entries = path.split(':');
    loop {
        let candidate = if name.contains('/') {
            work.admit_storage(name.len()).map_err(admission_status)?;
            name.to_owned()
        } else {
            let Some(directory) = entries.next() else {
                return Ok(None);
            };
            let bytes = directory
                .len()
                .checked_add(name.len())
                .and_then(|bytes| bytes.checked_add(1))
                .ok_or(2)?;
            work.admit_storage(bytes).map_err(admission_status)?;
            if directory.is_empty() {
                name.to_owned()
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
        let absolute = absolute(&cwd, &candidate);
        let metadata = context
            .cancel
            .run(context.fs().stat(&absolute, true))
            .await
            .map_err(|_| context.cancel_status())?;
        match metadata {
            Ok(metadata) if metadata.kind != io::FileKind::Directory => match metadata.executable {
                Some(true) => return Ok(Some(candidate)),
                Some(false) => {}
                None => return Err(2),
            },
            Ok(_) | Err(io::IoError::NotFound | io::IoError::NotDirectory) => {}
            Err(error) => return Err(error.status().max(2)),
        }
        if name.contains('/') {
            return Ok(None);
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
        } else if let Some(path) =
            executable(name, state, options.default_path, context, work).await?
        {
            if options.verbose {
                output(fds, context, name.as_bytes()).await?;
                output(fds, context, b" is ").await?;
            }
            output(fds, context, path.as_bytes()).await?;
            output(fds, context, b"\n").await?;
        } else {
            if options.verbose {
                diagnostic(fds, context, b"command: ").await?;
                diagnostic(fds, context, name.as_bytes()).await?;
                diagnostic(fds, context, b": not found\n").await?;
            }
            continue;
        }
        found = true;
    }
    Ok(Outcome::status(i32::from(!found)))
}
