//! Validate literal function declaration names when they execute.
use super::*;

enum PreparedFunction {
    Ready { name: String, line: usize },
    Done(Outcome),
}

async fn prepare(
    function: &FunctionDef,
    state: &SharedState,
    fds: &Descriptors,
    context: &Context,
) -> PreparedFunction {
    let line = match declaration_line(function, &context.cancel).await {
        Ok(line) => line,
        Err(_) => return PreparedFunction::Done(Outcome::status(context.cancel_status())),
    };
    let (name, valid) = match normalize(function.name.clone(), &context.cancel).await {
        Ok(result) => result,
        Err(_) => return PreparedFunction::Done(Outcome::status(context.cancel_status())),
    };
    if !valid {
        let code = invalid_name(&name, line, fds, context)
            .await
            .err()
            .unwrap_or(1);
        let mut result = Outcome::status(code);
        if result.flow == Flow::Normal && !context.ignore_errexit && state.borrow().errexit {
            result.flow = Flow::Abort;
        }
        return PreparedFunction::Done(result);
    }
    if context
        .source
        .retain_root(&context.core.execution_storage)
        .is_err()
    {
        return PreparedFunction::Done(
            abort_diagnostic(
                fds,
                context,
                b"function source live-memory limit exceeded",
                2,
            )
            .await,
        );
    }
    PreparedFunction::Ready { name, line }
}

/// Move a top-level parsed function body without cloning or charging an extra AST copy.
pub(super) async fn declare_owned(
    function: FunctionDef,
    state: SharedState,
    fds: Descriptors,
    context: Context,
) -> Outcome {
    let (name, line) = match prepare(&function, &state, &fds, &context).await {
        PreparedFunction::Ready { name, line } => (name, line),
        PreparedFunction::Done(outcome) => return outcome,
    };
    state.borrow_mut().define_function(
        name,
        StoredFunction {
            body: Rc::new(*function.body),
            source: context.source.clone(),
            line,
            storage: context.evaluation.retained(),
            reader: context.reader.clone(),
        },
    );
    Outcome::status(0)
}

pub(super) async fn declare(
    function: &FunctionDef,
    state: SharedState,
    fds: Descriptors,
    context: Context,
) -> Outcome {
    let (name, line) = match prepare(function, &state, &fds, &context).await {
        PreparedFunction::Ready { name, line } => (name, line),
        PreparedFunction::Done(outcome) => return outcome,
    };
    // Borrowed definitions (inside loops or other functions) allocate a fresh
    // AST copy. Admit it against the shared live-memory pool and keep that
    // ticket with the stored function until its final owner drops it.
    let bytes = shell_parser::limits::ExecutionLimits::default().max_work_units as usize;
    let mut copy_work = crate::exec::Work::new(bytes, bytes, 0);
    if let Err(error) =
        crate::ast_copy::command(&function.body, &context.cancel, &mut copy_work).await
    {
        return expansion_failure(error.into(), &fds, &context).await;
    }
    let body_bytes = (bytes - copy_work.storage_left())
        .saturating_add(std::mem::size_of::<Command>())
        .saturating_add(2 * std::mem::size_of::<usize>());
    let Ok(body_storage) = context.core.execution_storage.admit(body_bytes) else {
        return abort_diagnostic(
            &fds,
            &context,
            b"function body live-memory limit exceeded",
            2,
        )
        .await;
    };
    state.borrow_mut().define_function(
        name,
        StoredFunction {
            body: Rc::new(function.body.as_ref().clone()),
            source: context.source.clone(),
            line,
            storage: Some(Rc::new(body_storage)),
            reader: context.reader.clone(),
        },
    );
    Outcome::status(0)
}

#[derive(Default)]
struct Spelling {
    backtick: bool,
    escaped: bool,
}
impl Spelling {
    fn literal(&mut self, byte: u8) -> bool {
        if self.escaped {
            self.escaped = false;
            return true;
        }
        if byte == b'`' {
            self.backtick = !self.backtick;
            return true;
        }
        if self.backtick {
            self.escaped = byte == b'\\';
            return true;
        }
        !matches!(byte, b'$' | b'\'' | b'"' | b'\\')
    }
}

/// Reuse the owned token buffer. Only line continuations disappear; backticks
/// and their contents are literal name bytes, never command substitutions.
async fn normalize(
    name: String,
    cancel: &Cancel,
) -> Result<(String, bool), crate::executor::Cancelled> {
    let mut bytes = name.into_bytes();
    let mut read = 0;
    let mut written = 0;
    let mut spelling = Spelling::default();
    let mut valid = true;
    let mut budget = Budget::default();
    while read < bytes.len() {
        budget.checkpoint(cancel).await?;
        if !spelling.escaped && bytes[read..].starts_with(b"\\\n") {
            read += 2;
            continue;
        }
        valid &= spelling.literal(bytes[read]);
        bytes[written] = bytes[read];
        read += 1;
        written += 1;
    }
    bytes.truncate(written);
    // Removing the two ASCII continuation bytes cannot change UTF-8 validity.
    Ok((
        String::from_utf8(bytes).expect("literal name stays UTF-8"),
        valid,
    ))
}

fn header_space(source: &str) -> &str {
    let mut source = source;
    loop {
        source = source.trim_start_matches(char::is_whitespace);
        let Some(rest) = source.strip_prefix("\\\n") else {
            return source;
        };
        source = rest;
    }
}

/// Locate the declaration header in its retained source without re-lexing it.
async fn declaration_line(
    function: &FunctionDef,
    cancel: &Cancel,
) -> Result<usize, crate::executor::Cancelled> {
    let mut budget = Budget::default();
    budget.checkpoint(cancel).await?;
    let Some(source) = function.source.as_deref() else {
        return Ok(function.span.start.line);
    };
    let Some(offset) = source.find(&function.name) else {
        return Ok(function.span.start.line);
    };
    let rest = header_space(&source[offset + function.name.len()..]);
    let parentheses = rest
        .strip_prefix('(')
        .map(header_space)
        .and_then(|rest| rest.strip_prefix(')'));
    let body = header_space(parentheses.unwrap_or(rest));
    let header = &source[..source.len() - body.len()];
    let mut line = function.span.start.line;
    for byte in header.bytes() {
        budget.checkpoint(cancel).await?;
        line += usize::from(byte == b'\n');
    }
    Ok(line)
}

async fn invalid_name(
    name: &str,
    line: usize,
    fds: &Descriptors,
    context: &Context,
) -> Result<(), i32> {
    command_builtin::diagnostic(fds, context, b"/usr/bin/bash: line ").await?;
    command_builtin::diagnostic(fds, context, line.to_string().as_bytes()).await?;
    command_builtin::diagnostic(fds, context, b": `").await?;
    command_builtin::diagnostic(fds, context, name.as_bytes()).await?;
    command_builtin::diagnostic(fds, context, b"': not a valid identifier\n").await
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::FutureExt;

    fn finish<T>(operation: impl std::future::Future<Output = T>) -> T {
        futures::pin_mut!(operation);
        (0..2048)
            .find_map(|_| operation.as_mut().now_or_never())
            .expect("function-name operation exceeded bounded polls")
    }

    #[test]
    fn normalization_reuses_storage_and_preserves_literal_backtick_bytes() {
        for (raw, expected, valid) in [
            ("foo\\\nbar", "foobar", true),
            ("`echo $x`", "`echo $x`", true),
            ("`echo\\\\\nhi`", "`echo\\\\\nhi`", true),
            ("`echo\\\nhi`", "`echohi`", true),
            ("`echo 'a\\\nb'`", "`echo 'ab'`", true),
            ("`echo \\`x`", "`echo \\`x`", true),
            ("$foo\\\n-bar", "$foo-bar", false),
            ("foo'bar'", "foo'bar'", false),
            (r"f\oo", r"f\oo", false),
        ] {
            let name = raw.to_owned();
            let pointer = name.as_ptr();
            let result = finish(normalize(name, &Cancel::new())).unwrap();
            assert_eq!(result.0.as_ptr(), pointer);
            assert_eq!(result, (expected.to_owned(), valid));
        }
    }

    #[test]
    fn large_name_validation_yields_and_cancels_without_a_partial_name() {
        let executor = Executor::new();
        let cancel = Cancel::new();
        let operation = cancel.clone();
        let name = "x".repeat(128 * 1024);
        let handle = executor.spawn(async move { normalize(name, &operation).await });
        assert_eq!(executor.drive(1).pending, 1);
        cancel.cancel();
        executor.drive(64);
        assert!(handle.now_or_never().unwrap().is_err());
        assert_eq!(executor.drive(1).pending, 0);
    }

    fn copy_bytes(name: &str) -> usize {
        let source = format!("function {name} {{ :; }}");
        let mut command = shell_parser::Parser::new(&source)
            .parse()
            .unwrap()
            .commands
            .remove(0);
        let Command::Function(function) = &mut command else {
            panic!("expected function");
        };
        assert_eq!(function.name, name);
        function.source = None;
        let mut work = crate::exec::Work::new(100_000, 100_000, 0);
        assert!(
            finish(crate::ast_copy::command(
                &command,
                &Cancel::new(),
                &mut work,
            ))
            .is_ok()
        );
        let cloned = command.clone();
        assert!(matches!(cloned, Command::Function(function) if function.name == name));
        100_000 - work.storage_left()
    }

    #[test]
    fn ast_copy_admission_counts_all_retained_raw_name_bytes() {
        let plain = copy_bytes("f");
        for raw in [
            r#"foo"bar""#,
            r"f\oo",
            "`echo $x`",
            "foo\\\nbar",
            "`echo\\\\\nhi`",
        ] {
            assert_eq!(copy_bytes(raw) - plain, raw.len() - 1);
        }
    }
}
