//! Original raw-byte controls for GNU Bash 5.3.15 printf escapes.
use super::*;

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn check_bytes(source: &str, expected: &[u8]) {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run(source), 0, "{source}");
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
    for source in [
        r"printf 'prefix%q' x",
        r"printf 'prefix%08s' x",
        r"printf 'prefix%z' x",
        r"printf 'prefix%'",
    ] {
        let rig = Rig::new(Limits::default());
        assert_eq!(rig.run(source), 2, "{source}");
        assert_eq!(rig.run("echo recovered"), 0);
        assert!(rig.output.bytes().ends_with(b"recovered\n"));
    }
    // An escaped percent is literal, not a conversion introduced by decoding.
    check_bytes(r"printf '\045s' unused", b"%s");
}

#[test]
fn printf_repeated_output_is_admitted_before_writing_and_session_recovers() {
    let rig = Rig::new(Limits {
        expansion_bytes: 1024,
        ..Limits::default()
    });
    let source = format!("printf '{}%s' a b c d", "x".repeat(300));
    assert_eq!(rig.run(&source), 2);
    assert!(rig.output.bytes().is_empty());
    assert_eq!(rig.run("echo recovered"), 0);
    assert_eq!(rig.output.bytes(), b"recovered\n");
}

#[test]
fn printf_cancellation_during_admission_outputs_no_fabricated_success() {
    let rig = Rig::new(Limits::default());
    // Small expansion, but 300,300 admitted output bytes. Give expansion ample
    // turns to finish, then interrupt the much longer repeated-format preflight.
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
    assert!(!job.is_finished());
    assert!(rig.output.bytes().is_empty());
    rig.shell.interrupt();
    assert_eq!(rig.finish(job), 130);
    assert!(rig.output.bytes().is_empty());
    assert_eq!(rig.run("echo recovered"), 0);
    assert_eq!(rig.output.bytes(), b"recovered\n");
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
    let (reader, writer) = shell_engine::io::pipe();
    let (errors, _) = capture(4096);
    let mut fds = FdTable::default();
    fds.insert(0, Endpoint::null());
    fds.insert(1, writer);
    fds.insert(2, errors);
    rig.shell.set_descriptors(fds).unwrap();
    let job = rig
        .shell
        .start(&format!(
            "printf '%b' '{}'; echo bad",
            r"\377".repeat(12_000)
        ))
        .unwrap();
    let mut first = [0; 1];
    for _ in 0..100_000 {
        rig.ex.drive(1);
        if reader.read(&mut first).now_or_never() == Some(Ok(1)) {
            break;
        }
    }
    assert_eq!(first, [0xff]);
    assert!(!job.is_finished());
    rig.shell.interrupt();
    assert_eq!(rig.finish(job), 130);
    assert_eq!(rig.run("true"), 0);
}

#[test]
fn printf_warning_write_failure_is_not_swallowed() {
    let rig = Rig::new(Limits::default());
    assert_ne!(rig.run(r"printf 'A\xZ' 2>&-"), 0);
    assert_eq!(rig.run("echo recovered"), 0);
    assert!(rig.output.bytes().ends_with(b"recovered\n"));
}
