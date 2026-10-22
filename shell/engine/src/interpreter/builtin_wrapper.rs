use super::*;
use std::io::Write;

pub(super) async fn options(
    args: &[String],
    line: Option<usize>,
    fds: &Descriptors,
    context: &Context,
) -> Result<command_builtin::Options, i32> {
    let first = args.first().map(String::as_str);
    if let Some(flag) = first.and_then(invalid_option) {
        let delivery = async {
            prefix(line, fds, context).await?;
            command_builtin::diagnostic(fds, context, b"-").await?;
            command_builtin::diagnostic(fds, context, &[flag]).await?;
            command_builtin::diagnostic(
                fds,
                context,
                b": invalid option\nbuiltin: usage: builtin [shell-builtin [arg ...]]\n",
            )
            .await
        }
        .await;
        return Err(match delivery {
            Err(status @ (130 | 141)) => status,
            _ => 2,
        });
    }
    Ok(command_builtin::Options {
        query: false,
        verbose: false,
        default_path: false,
        operands: usize::from(first == Some("--")),
    })
}

fn invalid_option(arg: &str) -> Option<u8> {
    if arg == "--" || !arg.starts_with('-') {
        return None;
    }
    arg.as_bytes().get(1).copied()
}

async fn prefix(line: Option<usize>, fds: &Descriptors, context: &Context) -> Result<(), i32> {
    let Some(line) = line else {
        return command_builtin::diagnostic(fds, context, b"/usr/bin/bash: builtin: ").await;
    };
    let mut digits = [0u8; 20];
    let capacity = digits.len();
    let mut remaining = digits.as_mut_slice();
    write!(&mut remaining, "{}", line).map_err(|_| 2)?;
    let length = capacity - remaining.len();
    command_builtin::diagnostic(fds, context, b"/usr/bin/bash: line ").await?;
    command_builtin::diagnostic(fds, context, &digits[..length]).await?;
    command_builtin::diagnostic(fds, context, b": builtin: ").await
}

pub(super) async fn missing(
    name: &str,
    line: Option<usize>,
    fds: &Descriptors,
    context: &Context,
) -> Result<(), i32> {
    prefix(line, fds, context).await?;
    command_builtin::diagnostic(fds, context, name.as_bytes()).await?;
    command_builtin::diagnostic(fds, context, b": not a shell builtin\n").await
}
