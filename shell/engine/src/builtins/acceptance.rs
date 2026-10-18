//! Original acceptance stand-ins, compiled only with acceptance-utilities.
use super::{endpoint, grep, write};
use crate::{
    commands::Utility,
    executor::Budget,
    interpreter::{Context, Outcome},
    io::{Endpoint, FdTable, OpenOptions},
    state::{SharedState, absolute},
};
use std::fmt::Write as _;

pub(super) async fn run(
    utility: Utility,
    args: Vec<String>,
    state: &SharedState,
    fds: &FdTable,
    context: &Context,
) -> Result<Outcome, i32> {
    match utility {
        Utility::Cat => cat(args, state, fds, context).await?,
        Utility::Grep => return grep::run(args, state, fds, context).await,
        Utility::Mkdir => return mkdir(args, state, fds, context).await,
        Utility::Seq => seq(&args, fds, context).await?,
    }
    Ok(Outcome::status(0))
}

async fn copy(input: Endpoint, fds: &FdTable, context: &Context) -> Result<(), i32> {
    let mut buffer = [0u8; 8192];
    let mut budget = Budget::default();
    loop {
        budget.checkpoint(&context.cancel).await.map_err(|_| 130)?;
        let n = input
            .read_cancelled(&mut buffer, &context.cancel)
            .await
            .map_err(|e| e.status())?;
        if n == 0 {
            return Ok(());
        }
        write(fds, &buffer[..n], context).await?;
    }
}

async fn cat(
    args: Vec<String>,
    state: &SharedState,
    fds: &FdTable,
    context: &Context,
) -> Result<(), i32> {
    if args.is_empty() {
        return copy(endpoint(fds, 0)?, fds, context).await;
    }
    for path in args {
        cat_path(&path, state, fds, context).await?;
    }
    Ok(())
}
async fn cat_path(
    path: &str,
    state: &SharedState,
    fds: &FdTable,
    context: &Context,
) -> Result<(), i32> {
    if let Some(input) = crate::interpreter::device_endpoint(path, fds) {
        return copy(input?, fds, context).await;
    }
    let path = absolute(&state.borrow().cwd, path);
    let options = OpenOptions::default();
    let input = context
        .cancel
        .run(context.fs().open(&path, &options))
        .await
        .map_err(|_| 130)?
        .map_err(|e| e.status())?;
    copy(input, fds, context).await
}
async fn mkdir(
    args: Vec<String>,
    state: &SharedState,
    fds: &FdTable,
    context: &Context,
) -> Result<Outcome, i32> {
    let mut parents = false;
    let mut operands = Vec::new();
    let mut options = true;
    for arg in args {
        match arg.as_str() {
            "--" if options => options = false,
            "-p" if options => parents = true,
            s if options && s.starts_with('-') && s != "-" => return Err(2),
            _ => operands.push(arg),
        }
    }
    if operands.is_empty() {
        return Err(2);
    }
    let mut status = 0;
    let mut budget = Budget::default();
    for operand in operands {
        budget.checkpoint(&context.cancel).await.map_err(|_| 130)?;
        // Empty operands must not turn into the current directory under -p.
        let path = if operand.is_empty() {
            String::new()
        } else {
            absolute(&state.borrow().cwd, &operand)
        };
        let result = context
            .cancel
            .run(context.fs().mkdir(&path, parents))
            .await
            .map_err(|_| 130)?;
        let Err(error) = result else {
            continue;
        };
        status = 1;
        mkdir_error(&operand, error, fds, context).await?;
    }
    Ok(Outcome::status(status))
}
async fn mkdir_error(
    operand: &str,
    error: crate::io::IoError,
    fds: &FdTable,
    context: &Context,
) -> Result<(), i32> {
    let Some(stderr) = fds.get(2) else {
        return Ok(());
    };
    stderr
        .write_all(
            format!("mkdir: {operand}: {error}\n").as_bytes(),
            &context.cancel,
        )
        .await
        .map_err(|error| error.status())
}
async fn seq(args: &[String], fds: &FdTable, context: &Context) -> Result<(), i32> {
    let (start, end) = match args {
        [end] => (1, end.parse::<i64>().map_err(|_| 2)?),
        [start, end] => (
            start.parse::<i64>().map_err(|_| 2)?,
            end.parse::<i64>().map_err(|_| 2)?,
        ),
        _ => return Err(2),
    };
    let mut buffer = String::new();
    let mut budget = Budget::default();
    for n in start..=end {
        budget.checkpoint(&context.cancel).await.map_err(|_| 130)?;
        writeln!(&mut buffer, "{n}").map_err(|_| 1)?;
        if buffer.len() >= 8192 {
            write(&fds, buffer.as_bytes(), &context).await?;
            buffer.clear();
        }
    }
    write(&fds, buffer.as_bytes(), &context).await?;
    Ok(())
}
