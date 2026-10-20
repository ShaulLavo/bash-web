use super::{Limits, Rig, printf};

#[test]
fn printf_string_fields_pad_truncate_and_reuse_operands() {
    for (source, expected) in [
        (
            "printf '[%5s][%-5s][%06s]' abc abc xy",
            &b"[  abc][abc  ][    xy]"[..],
        ),
        (
            "printf '[%6.3s][%-6.3s][%.s]' abcdef abcdef abc",
            &b"[   abc][abc   ][]"[..],
        ),
        (
            "printf '[%*.*s]' -6 3 abcdef 4 2 xyz",
            &b"[abc   ][  xy]"[..],
        ),
        ("printf '[%*.*s]' 4", &b"[    ]"[..]),
        ("printf '[%5s][%.2s]' a", &b"[    a][]"[..]),
        ("printf '[%--++## 0005.2s]' abc", &b"[ab   ]"[..]),
        (
            "printf '[%*s][%.*s]' 010 abc -1 abcdef",
            &b"[     abc][abcdef]"[..],
        ),
    ] {
        printf::check_bytes(source, expected);
    }
}

#[test]
fn printf_string_precision_slices_utf8_bytes_not_characters() {
    for locale in ["C", "C.UTF-8"] {
        let rig = Rig::new(Limits::default());
        rig.variable("LC_ALL", locale);
        assert_eq!(rig.run("printf '[%4.1s][%.4s]' é中 é中"), 0);
        assert_eq!(rig.output.bytes(), b"[   \xc3][\xc3\xa9\xe4\xb8]");
        assert!(rig.errors.bytes().is_empty());
    }
}

#[test]
fn printf_string_padding_is_admitted_before_any_output() {
    for source in [
        "printf 'prefix%1000000000s' x",
        "printf 'prefix%*s' -2147483648 x",
        "printf 'prefix%500s' a b c",
    ] {
        let rig = Rig::new(Limits {
            expansion_bytes: 1024,
            ..Limits::default()
        });
        printf::assert_recovery(&rig, source, 2);
    }
}

#[test]
fn printf_string_padding_remains_chunked() {
    let rig = Rig::new(Limits::default());
    let (output, records) = printf::recorded_endpoint();
    printf::replace_output(&rig, output);
    printf::check_chunks(&rig, &records, "printf '%8193s' x", &[4096, 4096, 1]);
    let bytes = records.borrow().concat();
    assert_eq!(bytes.len(), 8193);
    assert!(bytes[..8192].iter().all(|byte| *byte == b' '));
    assert_eq!(bytes[8192], b'x');
}

#[test]
fn printf_string_star_numbers_report_errors_without_changing_operand_order() {
    for (value, expected, status) in [
        ("", "[]", 1),
        ("3x", "[abc]", 1),
        ("08", "[]", 1),
        ("2147483648", "[abcdef]", 1),
        ("-2147483649", "[abcdef]", 1),
        ("0b10", "[ab]", 0),
        ("\u{b}3", "[abc]", 0),
    ] {
        let rig = Rig::new(Limits::default());
        rig.variable("number", value);
        assert_eq!(rig.run("printf '[%.*s]' \"$number\" abcdef"), status);
        assert_eq!(rig.output.bytes(), expected.as_bytes());
        assert_eq!(!rig.errors.bytes().is_empty(), status == 1);
    }
}

#[test]
fn printf_string_field_overflow_stops_without_attempting_padding() {
    for field in [
        "2147483648",
        ".2147483648",
        ".999999999999999999999999999999999999999999",
    ] {
        let rig = Rig::new(Limits::default());
        assert_eq!(rig.run(&format!("printf 'prefix%{field}s' x")), 1);
        assert_eq!(rig.output.bytes(), b"prefix");
        assert!(
            rig.errors
                .bytes()
                .ends_with(b"Value too large for defined data type\n")
        );
    }
}

#[test]
fn printf_string_padding_cancellation_during_admission_is_silent() {
    let rig = Rig::new(Limits::default());
    let job = rig
        .shell
        .start("started=yes; printf 'prefix%900000s' x; echo bad")
        .unwrap();
    rig.drive_until_variable("started", "yes");
    for _ in 0..50 {
        rig.ex.drive(1);
    }
    printf::interrupt_empty(&rig, job);
}

#[test]
fn printf_string_padding_delivery_cancellation_keeps_only_written_spaces() {
    use futures::FutureExt;
    use shell_engine::io::pipe;
    let rig = Rig::new(Limits::default());
    let (reader, writer) = pipe();
    printf::replace_output(&rig, writer);
    let job = rig.shell.start("printf '%200000s' x; echo bad").unwrap();
    let mut byte = [0];
    for _ in 0..100_000 {
        rig.ex.drive(1);
        if reader.read(&mut byte).now_or_never() == Some(Ok(1)) {
            break;
        }
    }
    assert_eq!(byte, [b' ']);
    assert!(!job.is_finished());
    rig.shell.interrupt();
    assert_eq!(rig.finish(job), 130);
    let mut remaining = vec![0; shell_engine::io::PIPE_CAPACITY];
    let Some(Ok(length)) = reader.read(&mut remaining).now_or_never() else {
        panic!("expected already-written padding");
    };
    assert!(remaining[..length].iter().all(|byte| *byte == b' '));
    assert!(reader.read(&mut byte).now_or_never().is_none());
    assert_eq!(rig.run("true"), 0);
}

#[test]
fn printf_string_star_errors_are_cleared_by_operand_stop() {
    for (source, expected) in [
        (r"printf '[%*s]%bBAD' 3x abc '\c'", &b"[abc]"[..]),
        (r"printf '[%.*s]%bBAD' 2x abc '\c'", &b"[ab]"[..]),
        (r"printf '[%*.*s]%bBAD' 3x 2x abc '\c'", &b"[ ab]"[..]),
        (
            r"printf '[%*s]%b' 3x abc ok 2 xy '\c' 5 bad BAD",
            &b"[abc]ok[xy]"[..],
        ),
    ] {
        let rig = Rig::new(Limits::default());
        assert_eq!(rig.run(source), 0, "{source}");
        assert_eq!(rig.output.bytes(), expected, "{source}");
        assert!(rig.errors.bytes().ends_with(b"invalid number\n"));
    }
}

#[test]
fn printf_string_star_diagnostics_to_closed_stderr_do_not_stop_output() {
    for (source, expected, status) in [
        (
            "printf 'prefix[%.*s]tail' 2x abc 2>&-",
            &b"prefix[ab]tail"[..],
            1,
        ),
        ("printf '[%*s]' 3x abc 2 xy 2>&-", &b"[abc][xy]"[..], 1),
        (r"printf '[%.*s]%bBAD' 2x abc '\c' 2>&-", &b"[ab]"[..], 0),
    ] {
        let rig = Rig::new(Limits::default());
        assert_eq!(rig.run(source), status, "{source}");
        assert_eq!(rig.output.bytes(), expected, "{source}");
        assert!(rig.errors.bytes().is_empty());
    }
}

#[test]
fn printf_string_stop_does_not_hide_output_or_admission_errors() {
    for source in [
        r"printf '[%*s]%bBAD' 3x abc '\c' 1>&-",
        r"printf '[%.*s]%bBAD' 2x abc '\c' 1>&- 2>&-",
    ] {
        let rig = Rig::new(Limits::default());
        assert_eq!(rig.run(source), 1, "{source}");
        assert!(rig.output.bytes().is_empty());
    }
    let rig = Rig::new(Limits {
        expansion_bytes: 1024,
        ..Limits::default()
    });
    printf::assert_recovery(&rig, r"printf '%2000s%b' x '\c'", 2);
}

#[test]
fn printf_string_star_diagnostic_cancellation_stays_cancelled() {
    printf::assert_diagnostic_backpressure_cancellation(r"printf '[%*s]%bBAD' 3x abc '\c'", 2);
}
