use super::*;
use futures::future::LocalBoxFuture;
use shell_engine::{
    executor::Executor,
    io::{HostEndpoint, IoError, pipe},
};
use std::{cell::RefCell, rc::Rc};

#[derive(Clone)]
struct RecordedEndpoint(Rc<RefCell<Vec<Vec<u8>>>>, usize);
impl HostEndpoint for RecordedEndpoint {
    fn read<'a>(&'a self, _output: &'a mut [u8]) -> LocalBoxFuture<'a, Result<usize, IoError>> {
        async { Ok(0) }.boxed_local()
    }
    fn write<'a>(&'a self, input: &'a [u8]) -> LocalBoxFuture<'a, Result<usize, IoError>> {
        let records = self.0.clone();
        let length = input.len().min(self.1);
        let bytes = input[..length].to_owned();
        async move {
            records.borrow_mut().push(bytes);
            Ok(length)
        }
        .boxed_local()
    }
}

pub(super) fn recorded_endpoint() -> (Endpoint, Rc<RefCell<Vec<Vec<u8>>>>) {
    recorded_endpoint_with_limit(usize::MAX)
}

pub(super) fn recorded_endpoint_with_limit(limit: usize) -> (Endpoint, Rc<RefCell<Vec<Vec<u8>>>>) {
    let records = Rc::new(RefCell::new(Vec::new()));
    (
        Endpoint::host(Rc::new(RecordedEndpoint(records.clone(), limit))),
        records,
    )
}

pub(super) fn replace_output(rig: &Rig, output: Endpoint) {
    let mut fds = FdTable::default();
    fds.insert(0, Endpoint::null());
    fds.insert(1, output);
    fds.insert(2, Endpoint::null());
    rig.shell.set_descriptors(fds).unwrap();
}

pub(super) fn assert_recovery(rig: &Rig, source: &str, status: i32) {
    assert_eq!(rig.run(source), status);
    assert!(rig.output.bytes().is_empty());
    check_recovery(rig);
}

pub(super) fn check_recovery(rig: &Rig) {
    assert_eq!(rig.run("echo recovered"), 0);
    assert_eq!(rig.output.bytes(), b"recovered\n");
}

pub(super) fn interrupt_empty(rig: &Rig, job: JoinHandle<i32>) {
    assert!(!job.is_finished());
    assert!(rig.output.bytes().is_empty());
    rig.shell.interrupt();
    assert_eq!(rig.finish(job), 130);
    assert!(rig.output.bytes().is_empty());
    check_recovery(rig);
}

pub(super) fn interrupt_delivery(rig: &Rig, source: &str) -> Endpoint {
    let (reader, writer) = pipe();
    replace_output(rig, writer);
    let job = rig.shell.start(source).unwrap();
    assert_eq!(read_first_byte(rig, &reader), 0xff);
    assert!(!job.is_finished());
    rig.shell.interrupt();
    assert_eq!(rig.finish(job), 130);
    assert_eq!(rig.run("true"), 0);
    reader
}

pub(super) fn read_first_byte(rig: &Rig, reader: &Endpoint) -> u8 {
    let mut byte = [0];
    for _ in 0..100_000 {
        rig.ex.drive(1);
        if reader.read(&mut byte).now_or_never() == Some(Ok(1)) {
            return byte[0];
        }
    }
    panic!("expected a streamed printf byte");
}

pub(super) fn check_chunks(
    rig: &Rig,
    records: &Rc<RefCell<Vec<Vec<u8>>>>,
    source: &str,
    lengths: &[usize],
) {
    records.borrow_mut().clear();
    assert_eq!(rig.run(source), 0);
    assert_eq!(
        records.borrow().iter().map(Vec::len).collect::<Vec<_>>(),
        lengths
    );
}

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

pub(super) fn check_bytes(source: &str, expected: &[u8]) {
    check_status_bytes(source, expected, 0);
}

pub(super) fn check_status_bytes(source: &str, expected: &[u8], status: i32) {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run(source), status, "{source}");
    assert_eq!(rig.output.bytes(), expected, "{source}");
    assert!(rig.errors.bytes().is_empty(), "{source}");
}

#[test]
fn printf_named_escapes_preserve_raw_bytes_in_both_modes() {
    let input = r#"\a\b\e\E\f\n\r\t\v\\"#;
    let expected = b"\x07\x08\x1b\x1b\x0c\n\r\t\x0b\\";
    check_bytes(&format!("printf {}", quote(input)), expected);
    check_bytes(&format!("printf '%b' {}", quote(input)), expected);
}

#[test]
fn printf_octal_hex_nul_and_high_bytes_are_not_lossy_strings() {
    for (input, format, percent_b) in [
        (r"\0", &b"\0"[..], &b"\0"[..]),
        (r"\0000", &b"\x000"[..], &b"\0"[..]),
        (r"\00000", &b"\x0000"[..], &b"\x000"[..]),
        (r"\0123", &b"\n3"[..], &b"S"[..]),
        (r"\0777", &b"?7"[..], &b"\xff"[..]),
        (r"\1\12\1234", &b"\x01\nS4"[..], &b"\x01\nS4"[..]),
        (r"\08\078", &b"\x008\x078"[..], &b"\x008\x078"[..]),
        (
            r"\177\200\377\400\777",
            &b"\x7f\x80\xff\0\xff"[..],
            &b"\x7f\x80\xff\0\xff"[..],
        ),
        (
            r"\x0\x00\x1b\x7F\x80\xff\x100\x1g",
            &b"\0\0\x1b\x7f\x80\xff\x100\x01g"[..],
            &b"\0\0\x1b\x7f\x80\xff\x100\x01g"[..],
        ),
    ] {
        check_bytes(&format!("printf {}", quote(input)), format);
        check_bytes(&format!("printf '%b' {}", quote(input)), percent_b);
    }
}

#[test]
fn printf_stop_escape_only_stops_percent_b_and_the_entire_printf() {
    check_bytes(
        r"printf 'a\cb%s' X Y; printf '|continued|'",
        b"a\\cbXa\\cbY|continued|",
    );
    check_bytes(
        r"printf '%b:%s\n' 'a\cb' after tail; printf '|continued|'",
        b"a|continued|",
    );
    check_bytes(
        r"printf '%s:%b!' one two three 'a\cignored' five six; echo recovered",
        b"one:two!three:arecovered\n",
    );
}

#[test]
fn printf_unknown_quotes_and_true_trailing_backslash_are_mode_specific() {
    check_bytes(
        &format!("printf {}", quote("\\q\\\"\\'\\?\\")),
        b"\\q\"'?\\",
    );
    check_bytes(
        &format!("printf '%b' {}", quote("\\q\\\"\\'\\?\\")),
        b"\\q\\\"\\'\\?\\",
    );
    check_bytes(r"printf '\000%s\377' one two", b"\0one\xff\0two\xff");
}

#[test]
fn printf_missing_hex_digits_are_diagnostics_not_command_failure() {
    for source in [r"printf 'A\xZ'", r"printf '%b' 'A\xZ'"] {
        let rig = Rig::new(Limits::default());
        assert_eq!(rig.run(source), 0);
        assert_eq!(rig.output.bytes(), b"A\\xZ");
        assert!(
            String::from_utf8(rig.errors.bytes())
                .unwrap()
                .contains("missing hex digit for \\x")
        );
        assert_eq!(rig.run("echo recovered"), 0);
        assert_eq!(rig.output.bytes(), b"A\\xZrecovered\n");
    }
}

#[test]
fn printf_unsupported_conversions_do_not_become_supported_by_escape_decoding() {
    for (source, status) in [
        (r"printf 'prefix%08f' x", 2),
        (r"printf 'prefix%z' x", 1),
        (r"printf 'prefix%'", 1),
    ] {
        let rig = Rig::new(Limits::default());
        assert_eq!(rig.run(source), status, "{source}");
        assert_eq!(rig.run("echo recovered"), 0);
        assert!(rig.output.bytes().ends_with(b"recovered\n"));
    }
    check_bytes(r"printf '\045s' unused", b"%s");
}

#[test]
fn printf_repeated_output_is_admitted_before_writing_and_session_recovers() {
    let rig = Rig::new(Limits {
        expansion_bytes: 1024,
        ..Limits::default()
    });
    let source = format!("printf '{}%s' a b c d", "x".repeat(300));
    assert_recovery(&rig, &source, 2);
}

#[test]
fn printf_cancellation_during_admission_outputs_no_fabricated_success() {
    let rig = Rig::new(Limits::default());
    let source = format!(
        "started=yes; printf '{}%s' {}; echo bad",
        "x".repeat(1000),
        "a ".repeat(300)
    );
    let job = rig.shell.start(&source).unwrap();
    rig.drive_until_variable("started", "yes");
    for _ in 0..500 {
        rig.ex.drive(1);
    }
    interrupt_empty(&rig, job);
}

#[test]
fn printf_unicode_boundaries_preserve_bash_c_locale_spelling() {
    for (input, expected) in [
        (r"\u0000\u1\u12\u007f", &b"\0\x01\x12\x7f"[..]),
        (r"\u12345", &b"\\u12345"[..]),
        (
            r"\u0080\u07ff\u0800\ud800\udfff",
            &b"\\u0080\\u07FF\\u0800\\uD800\\uDFFF"[..],
        ),
        (
            r"\U00010000\U0010ffff\U00110000",
            &b"\\U00010000\\U0010FFFF\\U00110000"[..],
        ),
        (
            r"\U001fffff\U00200000\U03ffffff\U04000000\U7fffffff",
            &b"\\U001FFFFF\\U00200000\\U03FFFFFF\\U04000000\\U7FFFFFFF"[..],
        ),
        (r"a\U80000000b\Uffffffffc", &b"abc"[..]),
    ] {
        for percent_b in [false, true] {
            let rig = Rig::new(Limits::default());
            rig.variable("LC_ALL", "C");
            let source = if percent_b {
                format!("printf '%b' {}", quote(input))
            } else {
                format!("printf {}", quote(input))
            };
            assert_eq!(rig.run(&source), 0, "{source}");
            assert_eq!(rig.output.bytes(), expected, "{source}");
            assert!(rig.errors.bytes().is_empty());
        }
    }
}

#[test]
fn printf_utf8_unicode_includes_non_scalar_and_legacy_encoding_bytes() {
    for (input, expected) in [
        (r"\u0080\u07ff\u0800", &b"\xc2\x80\xdf\xbf\xe0\xa0\x80"[..]),
        (r"\ud800\udfff", &b"\xed\xa0\x80\xed\xbf\xbf"[..]),
        (
            r"\U00010000\U0010ffff\U00110000",
            &b"\xf0\x90\x80\x80\xf4\x8f\xbf\xbf\xf4\x90\x80\x80"[..],
        ),
        (
            r"\U001fffff\U00200000",
            &b"\xf7\xbf\xbf\xbf\xf8\x88\x80\x80\x80"[..],
        ),
        (
            r"\U03ffffff\U04000000\U7fffffff",
            &b"\xfb\xbf\xbf\xbf\xbf\xfc\x84\x80\x80\x80\x80\xfd\xbf\xbf\xbf\xbf\xbf"[..],
        ),
        (r"a\U80000000b\Uffffffffc", &b"abc"[..]),
    ] {
        for percent_b in [false, true] {
            let rig = Rig::new(Limits::default());
            rig.variable("LC_ALL", "C.UTF-8");
            let source = if percent_b {
                format!("printf '%b' {}", quote(input))
            } else {
                format!("printf {}", quote(input))
            };
            assert_eq!(rig.run(&source), 0, "{source}");
            assert_eq!(rig.output.bytes(), expected, "{source}");
            assert!(rig.errors.bytes().is_empty());
        }
    }
}

#[test]
fn printf_incomplete_unicode_warns_and_preserves_literal_suffixes() {
    for escape in [r"\u", r"\uQ", r"\U", r"\UQ"] {
        for percent_b in [false, true] {
            let rig = Rig::new(Limits::default());
            let source = if percent_b {
                format!("printf '%b' {}", quote(escape))
            } else {
                format!("printf {}", quote(escape))
            };
            assert_eq!(rig.run(&source), 0);
            assert_eq!(rig.output.bytes(), escape.as_bytes());
            assert!(
                String::from_utf8(rig.errors.bytes())
                    .unwrap()
                    .contains("missing unicode digit")
            );
        }
    }
}

#[test]
fn printf_locale_precedence_and_empty_values_follow_character_locale() {
    for (all, ctype, lang, expected) in [
        ("C", "C.UTF-8", "C.UTF-8", &b"\\u00E9"[..]),
        ("", "C.UTF-8", "C", &b"\xc3\xa9"[..]),
        ("", "POSIX", "C.UTF-8", &b"\\u00E9"[..]),
        ("", "", "C.utf8", &b"\xc3\xa9"[..]),
        ("", "", "", &b"\\u00E9"[..]),
    ] {
        let rig = Rig::new(Limits::default());
        rig.variable("LC_ALL", all);
        rig.variable("LC_CTYPE", ctype);
        rig.variable("LANG", lang);
        assert_eq!(rig.run(r"printf '\u00e9'"), 0);
        assert_eq!(rig.output.bytes(), expected);
    }
}

#[test]
fn printf_large_binary_payload_stays_bounded_and_byte_exact() {
    let rig = Rig::new(Limits::default());
    rig.variable("payload", &r"\377".repeat(12_000));
    assert_eq!(rig.run("printf '%b' \"$payload\""), 0);
    assert_eq!(rig.output.bytes(), vec![0xff; 12_000]);
    assert!(rig.errors.bytes().is_empty());
}

#[test]
fn printf_delivery_cancellation_preserves_only_real_streamed_prefix() {
    let rig = Rig::new(Limits::default());
    interrupt_delivery(
        &rig,
        &format!("printf '%b' '{}'; echo bad", r"\377".repeat(12_000)),
    );
}

#[test]
fn printf_warning_write_failure_preserves_only_the_real_streamed_prefix() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run(r"printf 'prefixA\xZ' 2>&-"), 1);
    assert_eq!(rig.output.bytes(), b"prefixA");
    assert!(rig.errors.bytes().is_empty());
    assert_eq!(rig.run("echo recovered"), 0);
    assert_eq!(rig.output.bytes(), b"prefixArecovered\n");
}

#[test]
fn printf_small_invocation_is_one_write_and_large_output_uses_4096_byte_records() {
    let rig = Rig::new(Limits::default());
    let (output, records) = recorded_endpoint();
    let mut fds = FdTable::default();
    fds.insert(0, Endpoint::null());
    fds.insert(1, output);
    fds.insert(2, Endpoint::null());
    rig.shell.set_descriptors(fds).unwrap();
    assert_eq!(rig.run("printf 'A%s\\n' x"), 0);
    assert_eq!(*records.borrow(), vec![b"Ax\n".to_vec()]);
    for (length, expected) in [
        (4095, vec![4095]),
        (4096, vec![4096]),
        (4097, vec![4096, 1]),
    ] {
        records.borrow_mut().clear();
        assert_eq!(rig.run(&format!("printf '{}'", "x".repeat(length))), 0);
        assert_eq!(
            records.borrow().iter().map(Vec::len).collect::<Vec<_>>(),
            expected
        );
    }
}

#[test]
fn printf_repeated_format_and_percent_b_stop_each_flush_at_invocation_end() {
    let rig = Rig::new(Limits::default());
    let (output, records) = recorded_endpoint();
    let mut fds = FdTable::default();
    fds.insert(0, Endpoint::null());
    fds.insert(1, output);
    fds.insert(2, Endpoint::null());
    rig.shell.set_descriptors(fds).unwrap();
    assert_eq!(rig.run("printf 'A%s' b c"), 0);
    assert_eq!(*records.borrow(), vec![b"AbAc".to_vec()]);
    records.borrow_mut().clear();
    assert_eq!(rig.run("printf '%b:%s\\n' 'a\\cb' after tail"), 0);
    assert_eq!(*records.borrow(), vec![b"a".to_vec()]);
}

#[test]
fn concurrent_small_printf_writers_never_split_marker_records() {
    let ex = Executor::new();
    let host = InProcessHost::new(ex.clone());
    let fs_a = MemoryFs::new(64 * 1024);
    let fs_b = MemoryFs::new(64 * 1024);
    let shell_a = Session::new(
        ex.clone(),
        Rc::new(host.clone()),
        Rc::new(fs_a),
        Limits::default(),
    );
    let shell_b = Session::new(
        ex.clone(),
        Rc::new(host.clone()),
        Rc::new(fs_b),
        Limits::default(),
    );
    let (output, records) = recorded_endpoint();
    for shell in [&shell_a, &shell_b] {
        let mut fds = FdTable::default();
        fds.insert(0, Endpoint::null());
        fds.insert(1, output.clone());
        fds.insert(2, Endpoint::null());
        shell.set_descriptors(fds).unwrap();
    }
    let job_a = shell_a.start("printf 'writer-A\\n'").unwrap();
    let job_b = shell_b.start("printf 'writer-B\\n'").unwrap();
    for _ in 0..100_000 {
        if job_a.is_finished() && job_b.is_finished() {
            break;
        }
        ex.drive(64);
    }
    assert_eq!(job_a.now_or_never(), Some(0));
    assert_eq!(job_b.now_or_never(), Some(0));
    let mut observed = records.borrow().clone();
    observed.sort();
    assert_eq!(
        observed,
        vec![b"writer-A\n".to_vec(), b"writer-B\n".to_vec()]
    );
    let shutdown_a = shell_a.shutdown();
    let shutdown_b = shell_b.shutdown();
    futures::pin_mut!(shutdown_a, shutdown_b);
    for _ in 0..1000 {
        ex.drive(64);
        if shutdown_a.as_mut().now_or_never().is_some()
            && shutdown_b.as_mut().now_or_never().is_some()
        {
            return;
        }
    }
    panic!("concurrent printf sessions did not shut down");
}

#[test]
fn printf_aliased_stderr_writes_diagnostic_before_buffered_stdout() {
    let rig = Rig::new(Limits::default());
    let (output, records) = recorded_endpoint();
    let mut fds = FdTable::default();
    fds.insert(0, Endpoint::null());
    fds.insert(1, output.clone());
    fds.insert(2, output);
    rig.shell.set_descriptors(fds).unwrap();
    assert_eq!(rig.run(r"printf 'prefixA\xZ'"), 0);
    assert_eq!(records.borrow().len(), 2);
    assert!(records.borrow()[0].ends_with(b"missing hex digit for \\x\n"));
    assert_eq!(records.borrow()[1], b"prefixA\\xZ");
}

#[test]
fn concurrent_printf_writers_on_one_engine_pipe_keep_each_marker_whole() {
    let ex = Executor::new();
    let host = InProcessHost::new(ex.clone());
    let shell_a = Session::new(
        ex.clone(),
        Rc::new(host.clone()),
        Rc::new(MemoryFs::new(64 * 1024)),
        Limits::default(),
    );
    let shell_b = Session::new(
        ex.clone(),
        Rc::new(host),
        Rc::new(MemoryFs::new(64 * 1024)),
        Limits::default(),
    );
    let (reader, writer) = pipe();
    for shell in [&shell_a, &shell_b] {
        let mut fds = FdTable::default();
        fds.insert(0, Endpoint::null());
        fds.insert(1, writer.clone());
        fds.insert(2, Endpoint::null());
        shell.set_descriptors(fds).unwrap();
    }
    let marker_a = format!("writer-A:{}\n", "a".repeat(64));
    let marker_b = format!("writer-B:{}\n", "b".repeat(64));
    let job_a = shell_a
        .start(&format!(
            "printf 'writer-A:%s\\n' {}",
            quote(&"a".repeat(64))
        ))
        .unwrap();
    let job_b = shell_b
        .start(&format!(
            "printf 'writer-B:%s\\n' {}",
            quote(&"b".repeat(64))
        ))
        .unwrap();
    let mut output = Vec::new();
    for _ in 0..100_000 {
        ex.drive(1);
        let mut chunk = [0; 17];
        if let Some(Ok(count)) = reader.read(&mut chunk).now_or_never() {
            output.extend_from_slice(&chunk[..count]);
        }
        if job_a.is_finished()
            && job_b.is_finished()
            && output.len() == marker_a.len() + marker_b.len()
        {
            break;
        }
    }
    assert_eq!(job_a.now_or_never(), Some(0));
    assert_eq!(job_b.now_or_never(), Some(0));
    let concatenated_ab = marker_a
        .as_bytes()
        .iter()
        .chain(marker_b.as_bytes())
        .copied()
        .collect::<Vec<_>>();
    let concatenated_ba = marker_b
        .as_bytes()
        .iter()
        .chain(marker_a.as_bytes())
        .copied()
        .collect::<Vec<_>>();
    assert!(
        output == concatenated_ab || output == concatenated_ba,
        "interleaved pipe output: {output:?}"
    );
    let shutdown_a = shell_a.shutdown();
    let shutdown_b = shell_b.shutdown();
    futures::pin_mut!(shutdown_a, shutdown_b);
    for _ in 0..1000 {
        ex.drive(64);
        if shutdown_a.as_mut().now_or_never().is_some()
            && shutdown_b.as_mut().now_or_never().is_some()
        {
            return;
        }
    }
    panic!("concurrent printf pipe sessions did not shut down");
}

#[test]
fn printf_cancellation_during_failed_diagnostic_prefix_flush_wins_status() {
    assert_diagnostic_backpressure_cancellation(r"printf 'prefixA\xZ' 2>&-", 1);
}

pub(super) fn assert_diagnostic_backpressure_cancellation(source: &str, fd: u32) {
    let rig = Rig::new(Limits::default());
    let (reader, writer) = pipe();
    let filler = vec![b'!'; shell_engine::io::PIPE_CAPACITY];
    assert_eq!(writer.write(&filler).now_or_never(), Some(Ok(filler.len())));
    let mut fds = FdTable::default();
    fds.insert(0, Endpoint::null());
    fds.insert(1, Endpoint::null());
    fds.insert(2, Endpoint::null());
    fds.insert(fd, writer);
    rig.shell.set_descriptors(fds).unwrap();
    let job = rig.shell.start(source).unwrap();
    let mut parked = false;
    for _ in 0..100_000 {
        let turn = rig.ex.drive(1);
        if !turn.runnable && !job.is_finished() {
            parked = true;
            break;
        }
        assert!(
            !job.is_finished(),
            "printf must park on its full output pipe"
        );
    }
    assert!(parked, "prefix flush never reached pipe backpressure");
    rig.shell.interrupt();
    assert_eq!(rig.finish(job), 130);
    let mut actual = vec![0; filler.len()];
    assert_eq!(
        reader.read(&mut actual).now_or_never(),
        Some(Ok(filler.len()))
    );
    assert_eq!(actual, filler);
    let mut byte = [0];
    assert!(reader.read(&mut byte).now_or_never().is_none());
    assert_eq!(rig.run("true"), 0);
}

pub(super) fn assert_warning_admission(source: &str) {
    let rig = Rig::new(Limits {
        expansion_bytes: 1024,
        ..Limits::default()
    });
    assert_recovery(&rig, source, 2);
    assert!(
        !rig.errors
            .bytes()
            .windows(b"invalid number".len())
            .any(|bytes| bytes == b"invalid number")
    );
}

pub(super) fn assert_admission_cancellation(source: &str) {
    let rig = Rig::new(Limits::default());
    let job = rig.shell.start(source).unwrap();
    rig.drive_until_variable("started", "yes");
    for _ in 0..500 {
        rig.ex.drive(1);
    }
    interrupt_empty(&rig, job);
}

pub(super) fn assert_field_overflow(field: &str, values: &str, warnings: &str) {
    let rig = Rig::new(Limits::default());
    assert_eq!(
        rig.run(&format!("printf 'prefix%{field}%bBAD' {values} '\\c'")),
        1
    );
    assert_eq!(rig.output.bytes(), b"prefix");
    assert_eq!(
        rig.errors.bytes(),
        format!("{warnings}/usr/bin/bash: printf: Value too large for defined data type\n")
            .as_bytes()
    );
}

pub(super) fn assert_pipe_delivery(source: &str, first: u8, padding: u8) {
    for cancel in [true, false] {
        let rig = Rig::new(Limits::default());
        let (reader, writer) = pipe();
        replace_output(&rig, writer);
        let job = rig.shell.start(source).unwrap();
        assert_eq!(read_first_byte(&rig, &reader), first);
        assert!(!job.is_finished());
        if !cancel {
            drop(reader);
            assert_eq!(rig.finish(job), 141);
            continue;
        }
        rig.shell.interrupt();
        assert_eq!(rig.finish(job), 130);
        let mut remaining = vec![0; shell_engine::io::PIPE_CAPACITY];
        let Some(Ok(length)) = reader.read(&mut remaining).now_or_never() else {
            panic!("expected already-written printf padding");
        };
        assert!(length > 0);
        assert!(remaining[..length].iter().all(|byte| *byte == padding));
        assert!(reader.read(&mut [0]).now_or_never().is_none());
        assert_eq!(rig.run("true"), 0);
    }
}
