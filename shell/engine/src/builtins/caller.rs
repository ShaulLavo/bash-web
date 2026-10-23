use super::{Context, FdTable, Outcome, SharedState, Work, error_status, scan_bytes, write};

pub(super) async fn run(
    args: &[String],
    state: &SharedState,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<Outcome, i32> {
    let operand = args
        .first()
        .filter(|arg| arg.as_str() != "--")
        .or_else(|| args.get(1));
    let index = match operand {
        Some(value) => parse_index(value)?,
        None => 0,
    };
    let bytes = state
        .borrow()
        .caller(index, operand.is_some())
        .map(|(line, name, source)| {
            line.len() + name.map_or(0, |name| name.len() + 1) + source.len() + 2
        })
        .ok_or(1)?;
    work.admit_storage(bytes).map_err(error_status)?;
    scan_bytes(bytes, context, work).await?;
    let line = {
        let state = state.borrow();
        let (line, name, source) = state.caller(index, operand.is_some()).ok_or(1)?;
        match name {
            Some(name) => format!("{line} {name} {source}\n"),
            None => format!("{line} {source}\n"),
        }
    };
    write(fds, line.as_bytes(), context).await?;
    Ok(Outcome::status(0))
}

fn parse_index(value: &str) -> Result<usize, i32> {
    let value = value.parse::<i64>().map_err(|_| 2)?;
    if value < 0 {
        return Err(2);
    }
    usize::try_from(value).map_err(|_| 1)
}
