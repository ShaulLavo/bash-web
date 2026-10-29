use super::*;

fn context(bytes: usize) -> (Session, Context) {
    let (session, group) = isolated_session(
        Limits {
            expansion_bytes: bytes,
            ..Limits::default()
        },
        0,
    );
    let core = session.core.clone();
    let evaluation = crate::exec::Scope::new(
        core.limits.source_bytes,
        core.eval_storage.clone(),
        core.execution_storage.clone(),
    );
    let context = Context::root(
        core,
        crate::exec::Source::root(""),
        evaluation,
        Cancel::new(),
        group,
        Strand::untracked(),
    );
    (session, context)
}

fn ready<T>(future: impl std::future::Future<Output = T>) -> T {
    let mut future = std::pin::pin!(future);
    let waker = futures::task::noop_waker();
    let mut task = std::task::Context::from_waker(&waker);
    for _ in 0..100_000 {
        if let std::task::Poll::Ready(result) = future.as_mut().poll(&mut task) {
            return result;
        }
    }
    panic!("timing formatter exceeded bounded polls");
}

#[test]
fn static_formats_borrow_and_custom_formats_charge_their_capacity() {
    let (session, context) = context(4096);
    let mut work = expansion_work(&context);
    let default = ready(configured_format(&session.state, &context, &mut work))
        .ok()
        .flatten()
        .unwrap();
    assert!(matches!(default, Cow::Borrowed(DEFAULT_FORMAT)));
    assert_eq!(work.storage_left(), 4096);
    session
        .state
        .borrow_mut()
        .assign_parameter("TIMEFORMAT".into(), "%U".into())
        .unwrap();
    let custom = ready(configured_format(&session.state, &context, &mut work))
        .ok()
        .flatten()
        .unwrap();
    let Cow::Owned(custom) = custom else {
        panic!("custom format must be owned")
    };
    assert_eq!(custom.capacity(), 2);
    assert_eq!(work.storage_left(), 4094);
}

#[test]
fn report_capacity_and_directive_diagnostics_use_one_original_allowance() {
    for (format, expected) in [
        (
            "%U",
            "/usr/bin/bash: TIMEFORMAT: `U': CPU time is unavailable\n",
        ),
        (
            "%S",
            "/usr/bin/bash: TIMEFORMAT: `S': CPU time is unavailable\n",
        ),
        (
            "%P",
            "/usr/bin/bash: TIMEFORMAT: `P': CPU time is unavailable\n",
        ),
        (
            "%X",
            "/usr/bin/bash: TIMEFORMAT: `X': invalid format character\n",
        ),
        (
            "%💥",
            "/usr/bin/bash: TIMEFORMAT: `💥': invalid format character\n",
        ),
        (
            "%l",
            "/usr/bin/bash: TIMEFORMAT: `': invalid format character\n",
        ),
        ("%0R|%0lR|%%|x%", "1|0m1s|%|x%\n"),
    ] {
        check_capacity(format, expected);
    }
    check_capacity(
        &format!("{}%X", "💥".repeat(1024)),
        "/usr/bin/bash: TIMEFORMAT: `X': invalid format character\n",
    );
}

fn check_capacity(format: &str, expected: &str) {
    let reserve = format.len() * REPORT_BYTES_PER_FORMAT_BYTE + 1;
    let bytes = format.len() + reserve.max(expected.len());
    let (_session, context) = context(bytes);
    let mut work = expansion_work(&context);
    work.admit_storage(format.len())
        .unwrap_or_else(|_| panic!("format charge"));
    let text = ready(render(
        format,
        Duration::from_millis(1234),
        &context,
        &mut work,
    ))
    .ok()
    .unwrap();
    assert_eq!(text, expected);
    assert_eq!(
        text.capacity(),
        if format.ends_with('%') {
            reserve
        } else {
            expected.len()
        }
    );
    assert_eq!(bytes - work.storage_left(), format.len() + text.capacity());
    println!(
        "format-bytes={} first-capacity={reserve} final-capacity={} admitted-live={}",
        format.len(),
        text.capacity(),
        bytes - work.storage_left()
    );
    let mut short = expansion_work(&context);
    short
        .admit_storage(bytes - reserve + 1)
        .unwrap_or_else(|_| panic!("short charge"));
    assert!(matches!(
        ready(render(format, Duration::ZERO, &context, &mut short)),
        Err(Error::Status(2))
    ));
}

#[test]
fn default_and_posix_exact_capacity_has_no_owned_format_overlap() {
    for format in [DEFAULT_FORMAT, POSIX_FORMAT] {
        let bytes = format.len() * REPORT_BYTES_PER_FORMAT_BYTE + 1;
        let (_session, context) = context(bytes);
        let mut work = expansion_work(&context);
        let text = ready(render(
            format,
            Duration::from_millis(1234),
            &context,
            &mut work,
        ))
        .ok()
        .unwrap();
        assert_eq!(text.capacity(), bytes);
        assert_eq!(work.storage_left(), 0);
        assert!(text.contains("1.23"));
    }
}

#[test]
fn render_does_not_refresh_work_or_ignore_context_cancellation() {
    let (_session, context) = context(256);
    let mut work = expansion_work(&context);
    work.remaining = 0;
    assert!(matches!(
        ready(render("x", Duration::ZERO, &context, &mut work)),
        Err(Error::Status(2))
    ));
    context.cancel.cancel();
    let mut work = expansion_work(&context);
    assert!(matches!(
        ready(render("x", Duration::ZERO, &context, &mut work)),
        Err(Error::Status(130))
    ));
}
