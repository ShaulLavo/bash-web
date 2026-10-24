use super::*;

#[test]
fn printf_integer_missing_operands_are_zero_but_empty_operands_warn() {
    printf::check_bytes("printf '[%d][%i]'", b"[0][0]");
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("printf '[%d][%i]' '' ''"), 1);
    assert_eq!(rig.output.bytes(), b"[0][0]");
    assert_eq!(
        rig.errors.bytes(),
        b"/usr/bin/bash: printf: : invalid number\n/usr/bin/bash: printf: : invalid number\n"
    );
}

#[test]
fn printf_integer_signs_radices_quotes_and_repeated_formats() {
    for (operand, expected) in [
        ("+42", "42"),
        ("-17", "-17"),
        ("010", "8"),
        ("+077", "63"),
        ("0xAB", "171"),
        ("-0Xab", "-171"),
        ("0b101", "5"),
        (" 42", "42"),
        ("\t-42", "-42"),
        ("'", "0"),
        ("'A", "65"),
        ("9223372036854775807", "9223372036854775807"),
        ("-9223372036854775808", "-9223372036854775808"),
    ] {
        let rig = Rig::new(Limits::default());
        rig.variable("number", operand);
        assert_eq!(
            rig.run("printf '[%d][%i]' \"$number\" \"$number\""),
            0,
            "{operand}"
        );
        assert_eq!(
            rig.output.bytes(),
            format!("[{expected}][{expected}]").as_bytes()
        );
        assert!(rig.errors.bytes().is_empty());
    }
    printf::check_bytes("printf '[%d][%i]' 010 0x10 +2 -3", b"[8][16][2][-3]");
}

#[test]
fn printf_integer_invalid_and_overflow_diagnostics_preserve_value_and_order() {
    for (value, expected, diagnostic) in [
        ("abc", "0", "invalid number"),
        ("42 ", "42", "invalid number"),
        ("3x", "3", "invalid number"),
        ("08", "0", "invalid octal number"),
        ("-08", "0", "invalid number"),
        ("0x", "0", "invalid hex number"),
        ("0X", "0", "invalid number"),
        ("0x1z", "1", "invalid hex number"),
        ("0b102", "2", "invalid number"),
        (
            "9223372036854775808",
            "9223372036854775807",
            "Numerical result out of range",
        ),
        (
            "-9223372036854775809",
            "-9223372036854775808",
            "Numerical result out of range",
        ),
        (
            "18446744073709551616",
            "9223372036854775807",
            "Numerical result out of range",
        ),
        (
            "9223372036854775808z",
            "9223372036854775807",
            "invalid number",
        ),
        (
            "-9223372036854775809z",
            "-9223372036854775808",
            "invalid number",
        ),
        (
            "0x10000000000000000z",
            "9223372036854775807",
            "invalid hex number",
        ),
    ] {
        assert_integer_diagnostic(value, expected, diagnostic);
    }
}

fn assert_integer_diagnostic(value: &str, expected: &str, diagnostic: &str) {
    let message = format!("/usr/bin/bash: printf: {value}: {diagnostic}\n");
    for format in ["d", "i"] {
        let rig = Rig::new(Limits::default());
        rig.variable("number", value);
        assert_eq!(rig.run(&format!("printf '[%{format}]' \"$number\"")), 1);
        assert_eq!(rig.output.bytes(), format!("[{expected}]").as_bytes());
        assert_eq!(rig.errors.bytes(), message.as_bytes());
        let rig = Rig::new(Limits::default());
        rig.variable("number", value);
        assert_eq!(
            rig.run(&format!("printf '[%{format}]' \"$number\" 2>&1")),
            1
        );
        assert_eq!(
            rig.output.bytes(),
            format!("{message}[{expected}]").as_bytes()
        );
        assert!(rig.errors.bytes().is_empty());
    }
}

#[test]
fn printf_integer_quoted_character_obeys_character_locale() {
    for (locale, expected) in [("C", "195:240"), ("C.UTF-8", "233:128512")] {
        let source = format!(r#"LC_ALL={locale}; printf '%d:%i' "'érest" '"😀rest'"#);
        printf::check_bytes(&source, expected.as_bytes());
    }
}

#[test]
fn printf_integer_warnings_closed_descriptors_and_stop_precedence() {
    for (source, expected, status) in [
        ("printf 'prefix[%d]tail' 3x 2>&-", "prefix[3]tail", 1),
        (r"printf '[%i]%bBAD' 3x '\c'", "[3]", 0),
        (r"printf '[%d]%bBAD' 3x '\c' 2>&-", "[3]", 0),
        (r"printf '[%d]%bBAD' 3x '\c' 1>&-", "", 1),
        ("printf '[%d]' 3x 1>&-", "", 1),
    ] {
        let rig = Rig::new(Limits::default());
        assert_eq!(rig.run(source), status, "{source}");
        let diagnostic = if source.contains("2>&-") {
            &b""[..]
        } else {
            &b"/usr/bin/bash: printf: 3x: invalid number\n"[..]
        };
        assert_eq!(rig.errors.bytes(), diagnostic, "{source}");
        assert_eq!(rig.output.bytes(), expected.as_bytes(), "{source}");
    }
    printf::assert_diagnostic_backpressure_cancellation(r"printf '[%i]%bBAD' 3x '\c'", 2);
}

#[test]
fn printf_integer_admission_rejects_output_and_warning_cost_before_emission() {
    for source in [
        format!("printf '{}%d' 1 2 3 4", "x".repeat(300)),
        format!("printf 'prefix%d' {}", "3x ".repeat(30)),
    ] {
        printf::assert_warning_admission(&source);
    }
}

#[test]
fn printf_integer_admission_cancellation_is_silent() {
    let source = format!(
        "started=yes; printf '{}%d' {}; echo bad",
        "x".repeat(1000),
        "1 ".repeat(300)
    );
    printf::assert_admission_cancellation(&source);
}

#[test]
fn printf_integer_real_io_failure_keeps_only_delivered_prefix() {
    let rig = Rig::new(Limits::default());
    let (reader, writer) = shell_engine::io::pipe();
    printf::replace_output(&rig, writer);
    let source = format!("printf '{}%d' 7", "a".repeat(20000));
    let job = rig.shell.start(&source).unwrap();
    assert_eq!(printf::read_first_byte(&rig, &reader), b'a');
    assert!(!job.is_finished());
    drop(reader);
    assert_eq!(rig.finish(job), 141);
}
