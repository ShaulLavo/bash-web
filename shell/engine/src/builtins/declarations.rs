use super::{
    Context, FdTable, Outcome, SharedState, State, Work, diagnose, error_status, scan_bytes, write,
};
use crate::{
    expand::Printability,
    state::{DeclarationView, ScalarResolution},
};

pub(super) async fn local_append_target(
    name: String,
    state: &SharedState,
    context: &Context,
    work: &mut Work,
) -> Result<String, i32> {
    State::admit_scalar_access(state, &name, &context.cancel, work)
        .await
        .map_err(error_status)?;
    let state = state.borrow();
    let ScalarResolution::Target(target) = state.resolve_scalar_target(&name) else {
        return Err(1);
    };
    if target != name {
        work.admit_storage(target.len()).map_err(error_status)?;
    }
    state.assignment_name(name)
}

pub(super) async fn append_scalar(
    name: &str,
    value: String,
    local: bool,
    state: &SharedState,
    context: &Context,
    work: &mut Work,
) -> Result<String, i32> {
    if !local {
        State::admit_scalar_access(state, name, &context.cancel, work)
            .await
            .map_err(error_status)?;
    }
    let bytes = state
        .borrow()
        .declaration_append_base(name, local)
        .map_or(0, str::len);
    scan_bytes(bytes, context, work).await?;
    let state = state.borrow();
    let old = state.declaration_append_base(name, local).unwrap_or("");
    let bytes = old.len().checked_add(value.len()).ok_or(2)?;
    if bytes > context.limits().expansion_bytes {
        return Err(2);
    }
    work.admit_storage(bytes).map_err(error_status)?;
    let mut joined = String::with_capacity(bytes);
    joined.push_str(old);
    joined.push_str(&value);
    Ok(joined)
}

struct DeclarationSnapshot {
    value: Option<String>,
    attributes: [bool; 5],
}

pub(super) async fn print<'a>(
    builtin: &str,
    names: impl Iterator<Item = &'a String>,
    state: &SharedState,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<Outcome, i32> {
    let utf8 = super::printf::character_locale(state, context, work).await?;
    let printability = Printability::new(utf8)?;
    let mut status = 0;
    let mut count = 0;
    for name in names {
        count += 1;
        scan_bytes(name.len(), context, work).await?;
        if name == "PIPESTATUS" {
            print_pipeline_status(state, fds, context, work).await?;
            continue;
        }
        if state.borrow().stack_array(name) && !state.borrow().is_nameref(name) {
            print_stack_array(name, state, fds, context, work).await?;
            continue;
        }
        let Some(DeclarationSnapshot { value, attributes }) =
            snapshot(name, state, context, work).await?
        else {
            missing(builtin, name, fds, context, work).await?;
            status = 1;
            continue;
        };
        let line = render(
            name,
            value.as_deref(),
            attributes,
            utf8,
            &printability,
            context,
            work,
        )
        .await?;
        write(fds, line.as_bytes(), context).await?;
        let bytes = line.len() + value.as_ref().map_or(0, String::len);
        drop((line, value));
        work.release_storage(bytes);
    }
    if count == 0 {
        return Err(2);
    }
    Ok(Outcome::status(status))
}

async fn snapshot(
    name: &str,
    state: &SharedState,
    context: &Context,
    work: &mut Work,
) -> Result<Option<DeclarationSnapshot>, i32> {
    let bytes = state
        .borrow()
        .declaration(name)
        .map_err(|()| 2)?
        .and_then(|view| view.value)
        .map_or(0, str::len);
    scan_bytes(bytes, context, work).await?;
    let state = state.borrow();
    let Some(view) = state.declaration(name).map_err(|()| 2)? else {
        return Ok(None);
    };
    work.admit_storage(view.value.map_or(0, str::len))
        .map_err(error_status)?;
    Ok(Some(DeclarationSnapshot {
        value: view.value.map(str::to_owned),
        attributes: declaration_attributes(view),
    }))
}

fn declaration_attributes(view: DeclarationView<'_>) -> [bool; 5] {
    [
        view.nameref,
        view.readonly,
        view.exported,
        view.case == crate::state::CaseMapping::Lower,
        view.case == crate::state::CaseMapping::Upper,
    ]
}

async fn missing(
    builtin: &str,
    name: &str,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<(), i32> {
    let bytes = builtin.len().saturating_add(name.len()).saturating_add(14);
    work.admit_storage(bytes).map_err(error_status)?;
    scan_bytes(bytes, context, work).await?;
    let message = format!("{builtin}: {name}: not found\n");
    let result = diagnose(fds, &message, context).await;
    drop(message);
    work.release_storage(bytes);
    result
}

async fn render(
    name: &str,
    value: Option<&str>,
    attributes: [bool; 5],
    utf8: bool,
    printability: &Printability,
    context: &Context,
    work: &mut Work,
) -> Result<String, i32> {
    let mut ansi = false;
    for ch in value.unwrap_or("").chars() {
        scan_bytes(ch.len_utf8(), context, work).await?;
        ansi |= !printable(ch, utf8, printability);
    }
    work.admit_storage(name.len().saturating_add(16))
        .map_err(error_status)?;
    let mut line = String::from("declare -");
    for (set, flag) in attributes.into_iter().zip(['n', 'r', 'x', 'l', 'u']) {
        if set {
            line.push(flag);
        }
    }
    if line.ends_with('-') {
        line.push('-');
    }
    line.push(' ');
    line.push_str(name);
    work.release_storage(name.len() + 16 - (line.len() + 1));
    if let Some(value) = value {
        quoted(&mut line, value, ansi, utf8, printability, context, work).await?;
    }
    line.push('\n');
    Ok(line)
}

fn printable(ch: char, utf8: bool, printability: &Printability) -> bool {
    if ch.is_ascii() {
        return (' '..='~').contains(&ch);
    }
    utf8 && !ch.is_control() && !matches!(ch, '\u{2028}' | '\u{2029}') && printability.printable(ch)
}

async fn quoted(
    line: &mut String,
    value: &str,
    ansi: bool,
    utf8: bool,
    printability: &Printability,
    context: &Context,
    work: &mut Work,
) -> Result<(), i32> {
    let delimiters = if ansi { "=$'" } else { "=\"" };
    work.admit_storage(delimiters.len() + 1)
        .map_err(error_status)?;
    line.push_str(delimiters);
    for ch in value.chars() {
        scan_bytes(ch.len_utf8(), context, work).await?;
        let mut buffer = [0; 16];
        let encoded = encode(ch, ansi, utf8, printability, &mut buffer);
        work.admit_storage(encoded.len()).map_err(error_status)?;
        line.push_str(encoded);
    }
    line.push(if ansi { '\'' } else { '"' });
    Ok(())
}

fn encode<'a>(
    ch: char,
    ansi: bool,
    utf8: bool,
    printability: &Printability,
    buffer: &'a mut [u8; 16],
) -> &'a str {
    let escape = match (ansi, ch) {
        (_, '\\') => Some("\\\\"),
        (false, '"') => Some("\\\""),
        (false, '$') => Some("\\$"),
        (false, '`') => Some("\\`"),
        (true, '\'') => Some("\\'"),
        (true, '\x07') => Some("\\a"),
        (true, '\x08') => Some("\\b"),
        (true, '\t') => Some("\\t"),
        (true, '\n') => Some("\\n"),
        (true, '\x0b') => Some("\\v"),
        (true, '\x0c') => Some("\\f"),
        (true, '\r') => Some("\\r"),
        (true, '\x1b') => Some("\\E"),
        _ => None,
    };
    if let Some(escape) = escape {
        return escape;
    }
    if printable(ch, utf8, printability) {
        return ch.encode_utf8(buffer);
    }
    let mut raw = [0; 4];
    let bytes = ch.encode_utf8(&mut raw).as_bytes();
    for (index, byte) in bytes.iter().copied().enumerate() {
        let offset = index * 4;
        buffer[offset..offset + 4].copy_from_slice(&[
            b'\\',
            b'0' + (byte >> 6),
            b'0' + ((byte >> 3) & 7),
            b'0' + (byte & 7),
        ]);
    }
    std::str::from_utf8(&buffer[..bytes.len() * 4]).expect("octal escapes are ASCII")
}

async fn print_pipeline_status(
    state: &SharedState,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<(), i32> {
    let bytes = state
        .borrow()
        .pipeline_status()
        .len()
        .checked_mul(std::mem::size_of::<i32>())
        .and_then(|bytes| bytes.checked_add(std::mem::size_of::<[bool; 5]>()))
        .ok_or(2)?;
    work.admit_storage(bytes).map_err(error_status)?;
    scan_bytes(bytes, context, work).await?;
    let (statuses, attributes) = {
        let state = state.borrow();
        let attributes = state
            .declaration("PIPESTATUS")
            .map_err(|()| 2)?
            .map(declaration_attributes)
            .unwrap_or([false; 5]);
        (state.pipeline_status().to_vec(), attributes)
    };
    write(fds, b"declare -a", context).await?;
    for (set, flag) in attributes.into_iter().zip(*b"nrxlu") {
        if set {
            write(fds, &[flag], context).await?;
        }
    }
    write(fds, b" PIPESTATUS=(", context).await?;
    for (index, code) in statuses.iter().enumerate() {
        work.admit_storage(48).map_err(error_status)?;
        scan_bytes(48, context, work).await?;
        let separator = if index == 0 { "" } else { " " };
        let line = format!("{separator}[{index}]=\"{code}\"");
        write(fds, line.as_bytes(), context).await?;
        drop(line);
        work.release_storage(48);
    }
    write(fds, b")\n", context).await?;
    drop(statuses);
    work.release_storage(bytes);
    Ok(())
}

async fn print_stack_array(
    name: &str,
    state: &SharedState,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<(), i32> {
    crate::state::State::admit_scalar_access(state, name, &context.cancel, work)
        .await
        .map_err(error_status)?;
    write(fds, b"declare -a ", context).await?;
    write(fds, name.as_bytes(), context).await?;
    let count = state.borrow().array_count(name);
    if count == 0 {
        return write(
            fds,
            if name == "FUNCNAME" { b"\n" } else { b"=()\n" },
            context,
        )
        .await;
    }
    write(fds, b"=(", context).await?;
    let utf8 = super::printf::character_locale(state, context, work).await?;
    let printability = Printability::new(utf8)?;
    for index in 0..count {
        print_stack_element(name, index, &printability, utf8, state, fds, context, work).await?;
    }
    write(fds, b")\n", context).await
}

#[allow(clippy::too_many_arguments)]
async fn print_stack_element(
    name: &str,
    index: usize,
    printability: &Printability,
    utf8: bool,
    state: &SharedState,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<(), i32> {
    let bytes = state
        .borrow()
        .array_element(name, index as i64)
        .ok_or(2)?
        .len();
    work.admit_storage(bytes + 24).map_err(error_status)?;
    scan_bytes(bytes + 24, context, work).await?;
    let value = state
        .borrow()
        .array_element(name, index as i64)
        .ok_or(2)?
        .to_owned();
    let mut line = if index == 0 {
        format!("[{index}]")
    } else {
        format!(" [{index}]")
    };
    let prefix = line.len();
    let ansi = value.chars().any(|ch| !printable(ch, utf8, printability));
    quoted(&mut line, &value, ansi, utf8, printability, context, work).await?;
    write(fds, line.as_bytes(), context).await?;
    let retained = bytes + 24 + line.len() - prefix;
    drop((line, value));
    work.release_storage(retained);
    Ok(())
}

pub(super) async fn function_names<'a>(
    names: impl Iterator<Item = &'a String>,
    state: &SharedState,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<Outcome, i32> {
    let mut status = 0;
    for name in names {
        scan_bytes(name.len(), context, work).await?;
        let Some(line) = state
            .borrow()
            .functions()
            .get(name)
            .map(|function| function.line)
        else {
            status = 1;
            continue;
        };
        let bytes = name.len() + state.borrow().shell_name.len() + 24;
        work.admit_storage(bytes).map_err(error_status)?;
        scan_bytes(bytes, context, work).await?;
        let output = if state.borrow().extdebug {
            format!("{name} {line} {}\n", state.borrow().shell_name)
        } else {
            format!("{name}\n")
        };
        write(fds, output.as_bytes(), context).await?;
        drop(output);
        work.release_storage(bytes);
    }
    Ok(Outcome::status(status))
}
