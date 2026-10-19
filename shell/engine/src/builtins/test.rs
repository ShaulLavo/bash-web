//! Original argv-based Bash `test` / `[` evaluator. Unlike `[[`, operands are
//! already split/globbed, string equality is literal, and integers are decimal
//! strings rather than arithmetic expressions. No host process or host std FS.
use super::error_status;
use crate::{
    executor::Cancel,
    expand::Work,
    interpreter::{Context, Outcome},
    io::{DescriptorKind, Endpoint, FdTable, FileKind, FileMetadata, IoError, MAX_PATH_BYTES},
    state::{SharedState, State},
};
use std::cmp::Ordering;

#[derive(Debug)]
enum Failure<'a> {
    Status(i32),
    Unary(&'a str),
    Binary(&'a str),
    Argument,
    CloseParen,
    Integer(&'a str),
    TerminalInteger(&'a str),
    Unsupported(&'a str),
    Missing(&'static str),
    TooMany,
}
impl From<i32> for Failure<'_> {
    fn from(status: i32) -> Self {
        Self::Status(status)
    }
}

pub(super) async fn run(
    name: &str,
    args: &[String],
    state: &SharedState,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<Outcome, i32> {
    let args = if name == "[" {
        if args.last().map(String::as_str) != Some("]") {
            diagnose(name, Failure::Missing("]"), fds, context)
                .await
                .map_err(|error| error.status())?;
            return Err(2);
        }
        &args[..args.len() - 1]
    } else {
        args
    };
    match evaluate(args, state, fds, context, work).await {
        Ok(value) => Ok(Outcome::status(i32::from(!value))),
        Err(Failure::Status(status)) => Err(status),
        Err(Failure::TerminalInteger(operand)) => {
            integer_diagnostic(name, operand, fds, context).await?;
            Err(2)
        }
        Err(error) => {
            diagnose(name, error, fds, context)
                .await
                .map_err(|error| error.status())?;
            Err(2)
        }
    }
}

async fn diagnose(
    name: &str,
    error: Failure<'_>,
    fds: &FdTable,
    context: &Context,
) -> Result<(), IoError> {
    // Borrow error operands and stream each piece; even a very large invalid
    // integer does not allocate a second copy merely to print its diagnostic.
    let pieces = match error {
        Failure::Unary(value) => [value, ": unary operator expected", ""],
        Failure::Binary(value) => [value, ": binary operator expected", ""],
        Failure::Argument => ["argument expected", "", ""],
        Failure::CloseParen => ["`)' expected", "", ""],
        Failure::Integer(value) | Failure::TerminalInteger(value) => {
            [value, ": integer expected", ""]
        }
        Failure::Unsupported(value) => [value, ": unsupported predicate", ""],
        Failure::Missing(value) => ["missing `", value, "'"],
        Failure::TooMany => ["too many arguments", "", ""],
        Failure::Status(_) => return Ok(()),
    };
    let output = fds.get(2).ok_or(IoError::BadDescriptor)?;
    for piece in ["/usr/bin/bash: ", name, ": "]
        .into_iter()
        .chain(pieces)
        .chain(["\n"])
    {
        output.write_all(piece.as_bytes(), &context.cancel).await?;
    }
    Ok(())
}

async fn step(context: &Context, work: &mut Work) -> Result<(), i32> {
    work.checkpoint(&context.cancel).await.map_err(error_status)
}

async fn evaluate<'a>(
    mut args: &'a [String],
    state: &SharedState,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<bool, Failure<'a>> {
    // Bash gives 0..4 operands special rules before its expression grammar.
    // In particular `test ! = !` is equality, and `test '(' '!' ')'`
    // tests the nonempty string `!`, not an incomplete negation expression.
    let mut negate = false;
    loop {
        step(context, work).await?;
        let value = match args.len() {
            0 => false,
            1 => !args[0].is_empty(),
            2 if args[0] == "!" => args[1].is_empty(),
            2 => {
                if !is_unary(&args[0]) {
                    return Err(Failure::Unary(&args[0]));
                }
                predicate(&args[0], &args[1], state, fds, context, work).await?
            }
            3 if is_binary(&args[1]) => {
                binary(&args[0], &args[1], &args[2], state, fds, context, work).await?
            }
            3 if args[1] == "-a" => !args[0].is_empty() && !args[2].is_empty(),
            3 if args[1] == "-o" => !args[0].is_empty() || !args[2].is_empty(),
            3 | 4 if args[0] == "!" => {
                negate = !negate;
                args = &args[1..];
                continue;
            }
            3 | 4 if args[0] == "(" && args[args.len() - 1] == ")" => {
                args = &args[1..args.len() - 1];
                continue;
            }
            3 => return Err(Failure::Binary(&args[1])),
            _ => expression(args, state, fds, context, work).await?,
        };
        return Ok(value ^ negate);
    }
}

#[derive(Clone, Copy)]
enum Operator {
    Open,
    Not,
    And(bool),
    Or(bool),
}
impl Operator {
    fn precedence(self) -> u8 {
        match self {
            Self::Open => 0,
            Self::Or(_) => 1,
            Self::And(_) => 2,
            Self::Not => 3,
        }
    }
    fn apply(self, right: bool) -> bool {
        match self {
            Self::And(left) => left && right,
            Self::Or(left) => left || right,
            Self::Not => !right,
            Self::Open => unreachable!("group marker is never reduced"),
        }
    }
}
fn push(stack: &mut Vec<Operator>, operator: Operator, work: &mut Work) -> Result<(), i32> {
    if stack.len() == stack.capacity() {
        let capacity = stack.capacity().saturating_mul(2).max(4);
        let bytes = (capacity - stack.capacity())
            .checked_mul(std::mem::size_of::<Operator>())
            .ok_or(2)?;
        work.admit_storage(bytes).map_err(error_status)?;
        stack
            .try_reserve_exact(capacity - stack.len())
            .map_err(|_| 2)?;
    }
    stack.push(operator);
    Ok(())
}

async fn expression<'a>(
    args: &'a [String],
    state: &SharedState,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<bool, Failure<'a>> {
    // Explicit operator frames instead of recursive Rust futures: deeply nested
    // untrusted argv must consume admitted storage, not the WASM call stack.
    let mut operators = Vec::new();
    let mut index = 0;
    let mut need_value = true;
    let mut value = false;
    while index < args.len() {
        step(context, work).await?;
        let token = args[index].as_str();
        if need_value {
            // Binary recognition takes priority even when the left operand
            // looks like a unary operator, negation or opening parenthesis.
            if index + 2 < args.len() && is_binary(&args[index + 1]) {
                value = binary(
                    token,
                    &args[index + 1],
                    &args[index + 2],
                    state,
                    fds,
                    context,
                    work,
                )
                .await?;
                index += 3;
            } else if token == "!" {
                push(&mut operators, Operator::Not, work)?;
                index += 1;
                continue;
            } else if token == "(" && args.get(index + 2).is_some_and(|arg| arg == ")") {
                value = !args[index + 1].is_empty();
                index += 3;
            } else if token == "(" {
                push(&mut operators, Operator::Open, work)?;
                index += 1;
                continue;
            } else if is_unary(token) && index + 1 < args.len() {
                let operand = &args[index + 1];
                value = predicate(token, operand, state, fds, context, work).await?;
                index += 2;
            } else {
                value = !token.is_empty();
                index += 1;
            }
            need_value = false;
            while matches!(operators.last(), Some(Operator::Not)) {
                step(context, work).await?;
                operators.pop();
                value = !value;
            }
            continue;
        }
        if token == ")" {
            loop {
                step(context, work).await?;
                match operators.pop() {
                    Some(Operator::Open) => break,
                    Some(operator) => value = operator.apply(value),
                    None => return Err(Failure::TooMany),
                }
            }
            while matches!(operators.last(), Some(Operator::Not)) {
                step(context, work).await?;
                operators.pop();
                value = !value;
            }
        } else {
            let precedence = match token {
                "-a" => 2,
                "-o" => 1,
                _ => return Err(Failure::TooMany),
            };
            while operators
                .last()
                .is_some_and(|op| op.precedence() >= precedence)
            {
                step(context, work).await?;
                value = operators.pop().unwrap().apply(value);
            }
            let operator = if token == "-a" {
                Operator::And(value)
            } else {
                Operator::Or(value)
            };
            push(&mut operators, operator, work)?;
            need_value = true;
        }
        index += 1;
    }
    if need_value {
        return Err(Failure::Argument);
    }
    while let Some(operator) = operators.pop() {
        step(context, work).await?;
        if matches!(operator, Operator::Open) {
            return Err(Failure::CloseParen);
        }
        value = operator.apply(value);
    }
    // Deliberately evaluate both sides of -a/-o. Bash test diagnoses bad
    // integers even on a logically unselected side; [[ ]] does short circuit.
    Ok(value)
}

pub(crate) fn is_unary(operator: &str) -> bool {
    matches!(
        operator,
        "-a" | "-b"
            | "-c"
            | "-d"
            | "-e"
            | "-f"
            | "-g"
            | "-h"
            | "-k"
            | "-L"
            | "-N"
            | "-O"
            | "-G"
            | "-p"
            | "-r"
            | "-s"
            | "-S"
            | "-t"
            | "-u"
            | "-v"
            | "-w"
            | "-x"
            | "-R"
            | "-o"
            | "-z"
            | "-n"
    )
}
fn is_binary(operator: &str) -> bool {
    matches!(
        operator,
        "=" | "=="
            | "!="
            | "<"
            | ">"
            | "-eq"
            | "-ne"
            | "-lt"
            | "-le"
            | "-gt"
            | "-ge"
            | "-nt"
            | "-ot"
            | "-ef"
    )
}
async fn predicate<'a>(
    operator: &'a str,
    operand: &'a str,
    state: &SharedState,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<bool, Failure<'a>> {
    unary(operator, operand, state, fds, context, work)
        .await
        .map_err(|error| match error {
            UnaryError::Integer => Failure::TerminalInteger(operand),
            UnaryError::Status(2) => Failure::Unsupported(operator),
            UnaryError::Status(status) => Failure::Status(status),
        })
}

pub(crate) enum UnaryError {
    Status(i32),
    Integer,
}
impl From<i32> for UnaryError {
    fn from(status: i32) -> Self {
        Self::Status(status)
    }
}

pub(crate) async fn integer_diagnostic(
    name: &str,
    operand: &str,
    fds: &FdTable,
    context: &Context,
) -> Result<(), i32> {
    if context.cancel.is_cancelled() {
        return Err(130);
    }
    match diagnose(name, Failure::TerminalInteger(operand), fds, context).await {
        // An unavailable stderr must not replace the malformed -t status.
        Ok(()) | Err(IoError::BadDescriptor) => Ok(()),
        Err(error) => Err(error.status()),
    }
}

pub(crate) async fn unary(
    operator: &str,
    operand: &str,
    state: &SharedState,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<bool, UnaryError> {
    if operator != "-t" {
        return unary_value(operator, operand, state, fds, context, work)
            .await
            .map_err(UnaryError::Status);
    }
    step(context, work).await?;
    let fd = decimal(operand, &context.cancel, work)
        .await?
        .ok_or(UnaryError::Integer)?;
    let Ok(fd) = u32::try_from(fd) else {
        return Ok(false);
    };
    let Some(endpoint) = fds.get(fd) else {
        return Ok(false);
    };
    descriptor_is(&endpoint, DescriptorKind::Terminal).map_err(UnaryError::Status)
}

fn descriptor_is(endpoint: &Endpoint, expected: DescriptorKind) -> Result<bool, i32> {
    match endpoint.descriptor_kind() {
        Ok(kind) => Ok(kind == expected),
        Err(IoError::BadDescriptor) => Ok(false),
        Err(IoError::Cancelled) => Err(130),
        Err(_) => Err(2),
    }
}

/// Shared with [[ ]]. File predicates use real host metadata, never open/read
/// probes (which misclassify directories and can block on FIFOs/devices).
/// Optional metadata that the host cannot supply is a capability error.
async fn unary_value(
    operator: &str,
    operand: &str,
    state: &SharedState,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<bool, i32> {
    step(context, work).await?;
    match operator {
        "-n" => Ok(!operand.is_empty()),
        "-z" => Ok(operand.is_empty()),
        "-v" => {
            for _ in operand.bytes() {
                step(context, work).await?;
            }
            if !super::valid_name(operand) {
                return Ok(false);
            }
            State::admit_scalar_access(state, operand, &context.cancel, work)
                .await
                .map_err(error_status)?;
            Ok(state.borrow().scalar_is_set(operand))
        }
        "-R" => {
            for _ in operand.bytes() {
                step(context, work).await?;
            }
            Ok(state.borrow().is_nameref(operand))
        }
        "-o" => {
            let state = state.borrow();
            Ok(match operand {
                "nounset" => state.nounset,
                "pipefail" => state.pipefail,
                "errexit" => state.errexit,
                _ => false,
            })
        }
        operator if is_unary(operator) => {
            if let Some(endpoint) = crate::io::device_endpoint(operand, fds) {
                let Ok(endpoint) = endpoint else {
                    return Ok(false);
                };
                if operator == "-p" {
                    return descriptor_is(&endpoint, DescriptorKind::Pipe);
                }
                return if matches!(operator, "-a" | "-e") {
                    Ok(true)
                } else {
                    Err(2)
                };
            }
            let Some(metadata) = stat(
                operand,
                !matches!(operator, "-h" | "-L"),
                state,
                context,
                work,
            )
            .await?
            else {
                return Ok(false);
            };
            let kind = |expected| {
                if metadata.kind == FileKind::Unknown {
                    Err(2)
                } else {
                    Ok(metadata.kind == expected)
                }
            };
            match operator {
                "-a" | "-e" => Ok(true),
                "-b" => kind(FileKind::BlockDevice),
                "-c" => kind(FileKind::CharacterDevice),
                "-d" => kind(FileKind::Directory),
                "-f" => kind(FileKind::Regular),
                "-h" | "-L" => kind(FileKind::Symlink),
                "-p" => kind(FileKind::Fifo),
                "-S" => kind(FileKind::Socket),
                "-s" => Ok(metadata.size > 0),
                "-r" => metadata.readable.ok_or(2),
                "-w" => metadata.writable.ok_or(2),
                "-x" => metadata.executable.ok_or(2),
                "-O" => metadata.owned_by_effective_uid.ok_or(2),
                "-G" => metadata.owned_by_effective_gid.ok_or(2),
                "-u" => Ok(metadata.mode.ok_or(2)? & 0o4000 != 0),
                "-g" => Ok(metadata.mode.ok_or(2)? & 0o2000 != 0),
                "-k" => Ok(metadata.mode.ok_or(2)? & 0o1000 != 0),
                "-N" => Ok(metadata.modified_ns.ok_or(2)? > metadata.accessed_ns.ok_or(2)?),
                _ => Err(2),
            }
        }
        _ => Err(2),
    }
}

/// Admit the complete absolute-path buffer before allocation. Preserve path
/// components and trailing slashes: removing `link/..` before stat would follow
/// the wrong node, and `regular-file/` must not become an ordinary file test.
async fn stat(
    operand: &str,
    follow_symlinks: bool,
    state: &SharedState,
    context: &Context,
    work: &mut Work,
) -> Result<Option<FileMetadata>, i32> {
    if operand.is_empty() {
        return Ok(None);
    }
    for _ in operand.bytes() {
        step(context, work).await?;
    }
    if operand.contains('\0') {
        return Ok(None);
    }
    let relative = !operand.starts_with('/');
    let cwd_bytes = if relative {
        state.borrow().cwd.len()
    } else {
        0
    };
    let bytes = cwd_bytes
        .checked_add(operand.len())
        .and_then(|n| n.checked_add(usize::from(relative)))
        .ok_or(2)?;
    if bytes > MAX_PATH_BYTES {
        return Ok(None);
    }
    for _ in 0..cwd_bytes {
        step(context, work).await?;
    }
    work.admit_storage(bytes).map_err(error_status)?;
    let mut path = String::new();
    path.try_reserve_exact(bytes).map_err(|_| 2)?;
    if relative {
        path.push_str(&state.borrow().cwd);
        path.push('/');
    }
    path.push_str(operand);
    step(context, work).await?;
    match context
        .cancel
        .run(context.fs().stat(&path, follow_symlinks))
        .await
        .map_err(|_| 130)?
    {
        Ok(metadata) => Ok(Some(metadata)),
        Err(IoError::Unsupported | IoError::LimitExceeded) => Err(2),
        Err(IoError::Cancelled) => Err(130),
        Err(_) => Ok(None),
    }
}

/// Shared file comparisons for test and [[ ]]. Neither a missing optional
/// metadata field nor an unsupported filesystem is silently treated as false.
pub(crate) async fn file_binary(
    left: &str,
    operator: &str,
    right: &str,
    state: &SharedState,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<bool, i32> {
    step(context, work).await?;
    if crate::io::device_endpoint(left, fds).is_some()
        || crate::io::device_endpoint(right, fds).is_some()
    {
        return Err(2);
    } // Endpoint identity is not filesystem inode identity.
    let left = stat(left, true, state, context, work).await?;
    let right = stat(right, true, state, context, work).await?;
    match (operator, left, right) {
        ("-nt", Some(_), None) | ("-ot", None, Some(_)) => Ok(true),
        ("-nt" | "-ot" | "-ef", None, None)
        | ("-nt" | "-ef", None, Some(_))
        | ("-ot" | "-ef", Some(_), None) => Ok(false),
        ("-nt", Some(left), Some(right)) => {
            Ok(left.modified_ns.ok_or(2)? > right.modified_ns.ok_or(2)?)
        }
        ("-ot", Some(left), Some(right)) => {
            Ok(left.modified_ns.ok_or(2)? < right.modified_ns.ok_or(2)?)
        }
        ("-ef", Some(left), Some(right)) => Ok(left.device.ok_or(2)? == right.device.ok_or(2)?
            && left.inode.ok_or(2)? == right.inode.ok_or(2)?),
        _ => Err(2),
    }
}

async fn binary<'a>(
    left: &'a str,
    operator: &'a str,
    right: &'a str,
    state: &SharedState,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<bool, Failure<'a>> {
    if matches!(operator, "-nt" | "-ot" | "-ef") {
        return file_binary(left, operator, right, state, fds, context, work)
            .await
            .map_err(Failure::Status);
    }
    let order = if matches!(operator, "=" | "==" | "!=" | "<" | ">") {
        let mut order = Ordering::Equal;
        for (left, right) in left.bytes().zip(right.bytes()) {
            step(context, work).await?;
            order = left.cmp(&right);
            if order != Ordering::Equal {
                break;
            }
        }
        order.then_with(|| left.len().cmp(&right.len()))
    } else {
        let left = decimal(left, &context.cancel, work)
            .await?
            .ok_or(Failure::Integer(left))?;
        let right = decimal(right, &context.cancel, work)
            .await?
            .ok_or(Failure::Integer(right))?;
        left.cmp(&right)
    };
    Ok(match operator {
        "=" | "==" | "-eq" => order.is_eq(),
        "!=" | "-ne" => !order.is_eq(),
        "<" | "-lt" => order.is_lt(),
        ">" | "-gt" => order.is_gt(),
        "-le" => !order.is_gt(),
        "-ge" => !order.is_lt(),
        _ => unreachable!("recognized binary operator"),
    })
}

/// Signed decimal intmax_t syntax, including surrounding ASCII whitespace.
/// Test does not evaluate variables, octal/base syntax, or arithmetic here.
/// None is a syntax/range error; resource/cancellation statuses stay distinct.
pub(super) async fn decimal(
    value: &str,
    cancel: &Cancel,
    work: &mut Work,
) -> Result<Option<i64>, i32> {
    let mut magnitude = 0u64;
    let mut negative = false;
    let mut started = false;
    let mut digits = false;
    let mut trailing = false;
    for byte in value.bytes() {
        work.checkpoint(cancel).await.map_err(error_status)?;
        if matches!(byte, b' ' | b'\t' | b'\n' | b'\r' | 0x0b | 0x0c) {
            trailing |= started;
            continue;
        }
        if trailing {
            return Ok(None);
        }
        if !started && matches!(byte, b'+' | b'-') {
            started = true;
            negative = byte == b'-';
            continue;
        }
        started = true;
        if !byte.is_ascii_digit() {
            return Ok(None);
        }
        digits = true;
        let Some(next) = magnitude
            .checked_mul(10)
            .and_then(|n| n.checked_add(u64::from(byte - b'0')))
        else {
            return Ok(None);
        };
        if next > (i64::MAX as u64) + u64::from(negative) {
            return Ok(None);
        }
        magnitude = next;
    }
    Ok(if !digits {
        None
    } else if negative && magnitude == (1u64 << 63) {
        Some(i64::MIN)
    } else if negative {
        Some(-(magnitude as i64))
    } else {
        Some(magnitude as i64)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::FutureExt;

    #[test]
    fn decimal_syntax_and_signed_range() {
        for (text, expected) in [
            ("08", Some(8)),
            (" +001 \n", Some(1)),
            ("-0", Some(0)),
            ("9223372036854775807", Some(i64::MAX)),
            ("-9223372036854775808", Some(i64::MIN)),
            ("9223372036854775808", None),
            ("-9223372036854775809", None),
            ("0x10", None),
            ("1+1", None),
            ("x", None),
            ("1 2", None),
            ("+ 1", None),
            ("", None),
            ("  ", None),
            ("-", None),
        ] {
            let mut work = Work::new(100, 0, 0);
            assert_eq!(
                decimal(text, &Cancel::new(), &mut work).now_or_never(),
                Some(Ok(expected)),
                "{text:?}"
            );
        }
    }

    #[test]
    fn decimal_keeps_work_exhaustion_and_cancellation() {
        let cancel = Cancel::new();
        assert_eq!(
            decimal("123", &cancel, &mut Work::new(2, 0, 0)).now_or_never(),
            Some(Err(2))
        );
        cancel.cancel();
        assert_eq!(
            decimal("123", &cancel, &mut Work::new(100, 0, 0)).now_or_never(),
            Some(Err(130))
        );
    }

    #[test]
    fn operator_frames_are_admitted_before_growth() {
        let mut operators = Vec::new();
        assert_eq!(
            push(&mut operators, Operator::Not, &mut Work::new(100, 0, 0)),
            Err(2)
        );
        assert!(operators.is_empty());
        assert_eq!(operators.capacity(), 0);
    }
}
