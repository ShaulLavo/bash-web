use super::{Limits, Rig, printf};

#[test]
fn printf_escaped_fields_count_decoded_bytes_and_pad_with_spaces() {
    for (source, expected) in [
        (
            r"printf '[%8b][%-8b][%08b]' 'a\tb' 'a\tb' 'a\tb'",
            &b"[     a\tb][a\tb     ][     a\tb]"[..],
        ),
        (
            r"printf '[%*b][%*b]' 8 'a\tb' -8 'a\tb'",
            &b"[     a\tb][a\tb     ]"[..],
        ),
        (
            r"printf '%10b|%-10b|' 'hello\nworld' 'tab\there'",
            &b"hello\nworld|tab\there  |"[..],
        ),
        (
            r"printf '[%05b|%05q|%05Q]' 'a\tb' 'c d' e",
            &b"[  a\tb| c\\ d|    e]"[..],
        ),
        (
            r"printf '[%5b][%-5b]' '\0' '\377'",
            &b"[    \0][\xff    ]"[..],
        ),
        (
            r"printf '[%5b]' a b; printf '[%-5b][%5b]'",
            &b"[    a][    b][     ][     ]"[..],
        ),
        (
            r"printf '[%5b][%5b][%5b]' '\q' '\' '\U80000000'",
            &b"[   \\q][    \\][     ]"[..],
        ),
    ] {
        printf::check_bytes(source, expected);
    }
}

#[test]
fn printf_escaped_fields_measure_unicode_bytes_in_the_selected_locale() {
    for (locale, expected) in [
        ("C", &b"[\\u03BC][\\u03BC]"[..]),
        ("C.UTF-8", &b"[    \xce\xbc][\xce\xbc    ]"[..]),
    ] {
        let rig = Rig::new(Limits::default());
        rig.variable("LC_ALL", locale);
        assert_eq!(rig.run(r"printf '[%6b][%-6b]' '\u03bc' '\u03bc'"), 0);
        assert_eq!(rig.output.bytes(), expected);
        assert!(rig.errors.bytes().is_empty());
    }
}

#[test]
fn printf_escaped_fields_stop_after_padding_and_skip_later_fields_and_operands() {
    for (source, expected) in [
        (
            r"printf '[%8b]TAIL%s' 'a\cignored' after extra; echo :$?",
            &b"[       a:0\n"[..],
        ),
        (
            r"printf '[%-8b]TAIL%s' 'a\cignored' after extra; echo :$?",
            &b"[a       :0\n"[..],
        ),
        (
            r"printf '[%8b]TAIL' '\c\xZ'; echo :$?",
            &b"[        :0\n"[..],
        ),
        (
            r"printf '[%8b]TAIL' 'a\c\xZ'; echo :$?",
            &b"[       a:0\n"[..],
        ),
    ] {
        printf::check_bytes(source, expected);
    }
}

#[test]
fn printf_escaped_field_precision_truncates_bytes_but_still_observes_stop() {
    for (source, expected) in [
        (r"printf '[%.0b]TAIL' 'a\cignored'; echo :$?", &b"[:0\n"[..]),
        (
            r"printf '[%.1b]TAIL' 'a\cignored'; echo :$?",
            &b"[a:0\n"[..],
        ),
        (
            r"printf '[%8.0b]TAIL' 'a\cignored'; echo :$?",
            &b"[        :0\n"[..],
        ),
        (
            r"printf '[%-8.1b]TAIL' 'a\cignored'; echo :$?",
            &b"[a       :0\n"[..],
        ),
        (r"printf '[%*.*b]' -5 2 'a\tb'", &b"[a\t   ]"[..]),
        (
            r"printf '[%.1b][%5.1b]' '\0x' '\377x'",
            &b"[\0][    \xff]"[..],
        ),
    ] {
        printf::check_bytes(source, expected);
    }
    let rig = Rig::new(Limits::default());
    rig.variable("LC_ALL", "C.UTF-8");
    assert_eq!(rig.run(r"printf '[%.1b][%5.1b]' '\u03bc' '\u03bc'"), 0);
    assert_eq!(rig.output.bytes(), b"[\xce][    \xce]");
}

#[test]
fn printf_escaped_field_measurement_does_not_duplicate_escape_diagnostics() {
    for (format, expected) in [("%8b", &b"[    a\\xZ]"[..]), ("%8.0b", &b"[        ]"[..])] {
        let rig = Rig::new(Limits::default());
        assert_eq!(rig.run(&format!(r"printf '[{format}]' 'a\xZ'")), 0);
        assert_eq!(rig.output.bytes(), expected);
        assert_eq!(
            rig.errors.bytes(),
            b"/usr/bin/bash: printf: missing hex digit for \\x\n"
        );
    }
}

#[test]
fn printf_escaped_field_stop_clears_star_errors_without_hiding_warnings() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run(r"printf '[%*b]TAIL' bad 'a\cignored'; echo :$?"), 0);
    assert_eq!(rig.output.bytes(), b"[a:0\n");
    assert_eq!(
        rig.errors.bytes(),
        b"/usr/bin/bash: printf: bad: invalid number\n"
    );
}

#[test]
fn printf_escaped_field_scalar_capture_keeps_padding_stop_and_nul_boundary() {
    for (source, expected) in [
        (
            r#"printf -v x '[%5b]' 'a\tb'; printf '<%s>' "$x""#,
            &b"<[  a\tb]>"[..],
        ),
        (
            r#"printf -v x '[%-5b]TAIL' 'a\cignored'; echo "$?:<$x>""#,
            &b"0:<[a    >\n"[..],
        ),
        (
            r#"printf -v x '[%5b]' '\0x'; echo "$?:<$x>""#,
            &b"0:<[   >\n"[..],
        ),
    ] {
        printf::check_bytes(source, expected);
    }
}

#[test]
fn printf_escaped_field_output_and_padding_are_admitted_before_writing() {
    for source in [
        r"printf 'prefix%2000b' x",
        r"printf 'prefix%-2000b' 'a\cignored'",
        r"printf '[%500b]' a b c",
    ] {
        let rig = Rig::new(Limits {
            expansion_bytes: 1024,
            ..Limits::default()
        });
        printf::assert_recovery(&rig, source, 2);
    }
}

#[test]
fn printf_escaped_field_padding_and_raw_output_remain_chunked() {
    let rig = Rig::new(Limits::default());
    let (output, records) = printf::recorded_endpoint();
    printf::replace_output(&rig, output);
    printf::check_chunks(&rig, &records, r"printf '%8193b' '\377'", &[4096, 4096, 1]);
    let bytes = records.borrow().concat();
    assert!(bytes[..8192].iter().all(|byte| *byte == b' '));
    assert_eq!(bytes[8192], 0xff);
    printf::check_chunks(
        &rig,
        &records,
        r"printf '%-8193b' '\0\cignored'",
        &[4096, 4096, 1],
    );
    let bytes = records.borrow().concat();
    assert_eq!(bytes[0], 0);
    assert!(bytes[1..].iter().all(|byte| *byte == b' '));
}

#[test]
fn printf_escaped_field_delivery_can_cancel_or_close_without_fabricated_output() {
    printf::assert_pipe_delivery(r"printf '%200000b' x; echo bad", b' ', b' ');
    printf::assert_pipe_delivery(r"printf '%-200000b' ' \cignored'; echo bad", b' ', b' ');
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run(r"printf '%8b' 'a\tb' 1>&-"), 1);
    assert!(rig.output.bytes().is_empty());
}

#[test]
fn printf_escaped_field_measurement_cancellation_is_silent() {
    printf::assert_admission_cancellation(&format!(
        "started=yes; printf 'prefix%900000b' '{}'; echo bad",
        r"\377".repeat(12000)
    ));
}

#[test]
fn printf_escaped_field_diagnostic_precedes_padding_flush_with_aliased_stderr() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run(r"printf '[%5000b]tail' 'a\xZ' 2>&1"), 0);
    let mut expected = b"/usr/bin/bash: printf: missing hex digit for \\x\n[".to_vec();
    expected.extend_from_slice(&[b' '; 4996]);
    expected.extend_from_slice(b"a\\xZ]tail");
    assert_eq!(rig.output.bytes(), expected);
    assert!(rig.errors.bytes().is_empty());
}

#[test]
fn printf_escaped_field_warning_on_closed_stderr_does_not_stop_output() {
    for (format, expected) in [
        ("%8b", &b"[    a\\xZ]tail:0\n"[..]),
        ("%-8b", &b"[a\\xZ    ]tail:0\n"[..]),
        ("%8.0b", &b"[        ]tail:0\n"[..]),
    ] {
        printf::check_bytes(
            &format!(r"printf '[{format}]tail' 'a\xZ' 2>&-; echo :$?"),
            expected,
        );
    }
}
