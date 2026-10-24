use super::*;

#[test]
fn printf_unsigned_missing_empty_and_repeated_operands() {
    printf::check_bytes("printf '[%u][%o][%x][%X]'", b"[0][0][0][0]");
    printf::check_bytes(
        "printf '[%u][%x]' -1 42 16 -18446744073709551615",
        b"[18446744073709551615][2a][16][1]",
    );
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("printf '[%u][%o][%x][%X]' '' '' '' ''"), 1);
    assert_eq!(rig.output.bytes(), b"[0][0][0][0]");
    assert_eq!(
        rig.errors.bytes(),
        b"/usr/bin/bash: printf: : invalid number\n".repeat(4)
    );
}

#[test]
fn printf_unsigned_range_is_not_signed_range() {
    printf::check_bytes(
        "printf '[%u][%o][%x][%X]' 18446744073709551615 -1 9223372036854775808 -9223372036854775809",
        b"[18446744073709551615][1777777777777777777777][8000000000000000][7FFFFFFFFFFFFFFF]",
    );
}

#[test]
fn printf_unsigned_exact_maximum_and_overflow_keep_distinct_states() {
    for (value, expected, diagnostic) in [
        ("18446744073709551615", "18446744073709551615", ""),
        ("-18446744073709551615", "1", ""),
        (
            "18446744073709551616",
            "18446744073709551615",
            "Numerical result out of range",
        ),
        (
            "-18446744073709551616",
            "18446744073709551615",
            "Numerical result out of range",
        ),
        ("0xffffffffffffffff", "18446744073709551615", ""),
        ("-0xffffffffffffffff", "1", ""),
        (
            "0x10000000000000000",
            "18446744073709551615",
            "Numerical result out of range",
        ),
        (
            "-0x10000000000000000",
            "18446744073709551615",
            "Numerical result out of range",
        ),
        (
            "18446744073709551616z",
            "18446744073709551615",
            "invalid number",
        ),
        (
            "-18446744073709551616z",
            "18446744073709551615",
            "invalid number",
        ),
        (
            "0x10000000000000000z",
            "18446744073709551615",
            "invalid hex number",
        ),
        ("08", "0", "invalid octal number"),
        ("-08", "0", "invalid number"),
        ("0X", "0", "invalid number"),
        ("0x", "0", "invalid hex number"),
        ("42 ", "42", "invalid number"),
        ("0b102", "2", "invalid number"),
    ] {
        assert_unsigned(value, expected, diagnostic);
    }
}

fn assert_unsigned(value: &str, expected: &str, diagnostic: &str) {
    let expected = expected.parse::<u64>().unwrap();
    let formats = [
        ("u", expected.to_string()),
        ("o", format!("{expected:o}")),
        ("x", format!("{expected:x}")),
        ("X", format!("{expected:X}")),
    ];
    for (conversion, output) in formats {
        assert_unsigned_streams(value, conversion, &output, diagnostic);
    }
}

fn assert_unsigned_streams(value: &str, conversion: &str, output: &str, diagnostic: &str) {
    let message = if diagnostic.is_empty() {
        String::new()
    } else {
        format!("/usr/bin/bash: printf: {value}: {diagnostic}\n")
    };
    for redirect in ["", " 2>&1"] {
        let rig = Rig::new(Limits::default());
        rig.variable("number", value);
        assert_eq!(
            rig.run(&format!("printf '[%{conversion}]' \"$number\"{redirect}")),
            i32::from(!diagnostic.is_empty())
        );
        let (out, err) = if redirect.is_empty() {
            (format!("[{output}]"), message.clone())
        } else {
            (format!("{message}[{output}]"), String::new())
        };
        assert_eq!(
            rig.output.bytes(),
            out.as_bytes(),
            "{value} %{conversion}{redirect}"
        );
        assert_eq!(
            rig.errors.bytes(),
            err.as_bytes(),
            "{value} %{conversion}{redirect}"
        );
    }
}

#[test]
fn printf_unsigned_radix_whitespace_quotes_and_locale() {
    for (value, expected) in [
        ("010", "8"),
        ("+077", "63"),
        ("-0Xab", "18446744073709551445"),
        ("0b101", "5"),
        (" \t\n\r\u{b}\u{c}42", "42"),
        ("'", "0"),
        ("'Arest", "65"),
    ] {
        assert_unsigned(value, expected, "");
    }
    for (locale, expected) in [("C", "195:360:c3:F0"), ("C.UTF-8", "233:373000:e9:1F600")] {
        printf::check_bytes(
            &format!(r#"LC_ALL={locale}; printf '%u:%o:%x:%X' "'é" '"😀rest' "'é" '"😀rest'"#),
            expected.as_bytes(),
        );
    }
    printf::check_bytes(
        "printf '[%d][%u][%i][%x][%*s]' -1 -1 010 0xff 3 z",
        b"[-1][18446744073709551615][8][ff][  z]",
    );
}

#[test]
fn printf_unsigned_long_overflow_cannot_return_to_range() {
    for value in ["9".repeat(2048), format!("-{}", "9".repeat(2048))] {
        assert_unsigned(
            &value,
            "18446744073709551615",
            "Numerical result out of range",
        );
    }
}

#[test]
fn printf_unsigned_warnings_and_backslash_c_preserve_status_precedence() {
    for (source, output, status) in [
        ("printf 'prefix[%u]tail' 3x 2>&-", "prefix[3]tail", 1),
        (r"printf '[%x]%bBAD' 3x '\c'", "[3]", 0),
        (r"printf '[%o]%bBAD' 3x '\c' 2>&-", "[3]", 0),
        (r"printf '[%X]%bBAD' 3x '\c' 1>&-", "", 1),
        ("printf '[%u]' 3x 1>&-", "", 1),
    ] {
        let rig = Rig::new(Limits::default());
        assert_eq!(rig.run(source), status);
        assert_eq!(rig.output.bytes(), output.as_bytes());
        let diagnostic = if source.contains("2>&-") {
            &b""[..]
        } else {
            &b"/usr/bin/bash: printf: 3x: invalid number\n"[..]
        };
        assert_eq!(rig.errors.bytes(), diagnostic);
    }
    printf::assert_diagnostic_backpressure_cancellation(r"printf '[%X]%bBAD' 3x '\c'", 2);
}

#[test]
fn printf_unsigned_admission_rejects_before_output() {
    for source in [
        format!("printf '{}%o' -1 -1 -1 -1", "x".repeat(300)),
        format!("printf 'prefix%u' {}", "3x ".repeat(30)),
    ] {
        printf::assert_warning_admission(&source);
    }
}

#[test]
fn printf_unsigned_admission_cancellation_is_silent() {
    let source = format!(
        "started=yes; printf '{}%x' {}; echo bad",
        "x".repeat(1000),
        "-1 ".repeat(300)
    );
    printf::assert_admission_cancellation(&source);
}

#[test]
fn printf_unsigned_real_io_failure_keeps_delivered_numeric_prefix() {
    let rig = Rig::new(Limits::default());
    let (reader, writer) = shell_engine::io::pipe();
    printf::replace_output(&rig, writer);
    let source = format!("printf '%o' {}", "-1 ".repeat(3000));
    let job = rig.shell.start(&source).unwrap();
    assert_eq!(printf::read_first_byte(&rig, &reader), b'1');
    assert!(!job.is_finished());
    drop(reader);
    assert_eq!(rig.finish(job), 141);
}
