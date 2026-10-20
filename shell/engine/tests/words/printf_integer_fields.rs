use super::{Limits, Rig, printf};

#[test]
fn printf_integer_fields_sign_radix_zero_fill_and_precision() {
    for (source, expected) in [
        (
            "printf '[%+08d][% 08d][%#08x][%#08o]' 42 -42 42 42",
            "[+0000042][-0000042][0x00002a][00000052]",
        ),
        (
            "printf '[%08.3d][%08.*d][%-05d]' 7 -1 7 3",
            "[     007][00000007][3    ]",
        ),
        (
            "printf '[%+.0d][% .0d][%#.0o][%#.0x][%#.1o][%#.3o]' 0 0 0 0 0 8",
            "[+][ ][0][][0][010]",
        ),
        (
            "printf '[%#03o][%#.3o][%#03.3o][%#08.3x]' 8 8 8 8",
            "[010][010][010][   0x008]",
        ),
        (
            "printf '[%+u][% u][%#u][%#d][%+x][% x]' 7 7 7 7 7 7",
            "[7][7][7][7][7][7]",
        ),
        ("printf '[%+--00  ##8.4d]' 42", "[+0042   ]"),
        ("printf '[%05d][%.0x][%+.0i]'", "[00000][][+]"),
    ] {
        printf::check_bytes(source, expected.as_bytes());
    }
}

#[test]
fn printf_integer_fields_stars_consume_in_order_and_reuse_format() {
    printf::check_bytes(
        "printf '[%*.*d][%s]' -8 4 -42 X 5 0 0 Y",
        b"[-0042   ][X][     ][Y]",
    );
    printf::check_bytes(
        "printf '[%#0*.*X]' -10 4 42 8 -1 42",
        b"[0X002A    ][0X00002A]",
    );
    printf::check_bytes("printf '[%*.*i]' 5", b"[     ]");
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("printf '[%*.*d]tail' 3x 2x 4x"), 1);
    assert_eq!(rig.output.bytes(), b"[ 04]tail");
    assert_eq!(rig.errors.bytes(), b"/usr/bin/bash: printf: 3x: invalid number\n/usr/bin/bash: printf: 2x: invalid number\n/usr/bin/bash: printf: 4x: invalid number\n");
}

#[test]
fn printf_integer_fields_keep_operand_and_star_ranges_distinct() {
    printf::check_bytes(
        "printf '[%024i][%#024x][%.24u]' -9223372036854775808 18446744073709551615 -1",
        b"[-00009223372036854775808][0x000000ffffffffffffffff][000018446744073709551615]",
    );
    for (value, expected, diagnostic) in [
        ("", "[7]", "invalid number"),
        ("3x", "[007]", "invalid number"),
        ("2147483648", "[7]", "Numerical result out of range"),
        ("-2147483649", "[7]", "Numerical result out of range"),
        (
            "18446744073709551615",
            "[7]",
            "Numerical result out of range",
        ),
    ] {
        let rig = Rig::new(Limits::default());
        rig.variable("count", value);
        assert_eq!(rig.run("printf '[%.*d]' \"$count\" 7"), 1);
        assert_eq!(rig.output.bytes(), expected.as_bytes());
        assert_eq!(
            rig.errors.bytes(),
            format!("/usr/bin/bash: printf: {value}: {diagnostic}\n").as_bytes()
        );
    }
}

#[test]
fn printf_integer_fields_missing_and_empty_counts_and_values_differ() {
    printf::check_bytes("printf '[%*.*d]'", b"[]");
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("printf '[%*.*d]' '' '' ''"), 1);
    assert_eq!(rig.output.bytes(), b"[]");
    assert_eq!(
        rig.errors.bytes(),
        b"/usr/bin/bash: printf: : invalid number\n".repeat(3)
    );
}

#[test]
fn printf_integer_fields_literal_overflow_follows_numeric_operand_diagnostics() {
    for (field, values, warnings) in [
        ("2147483648d", "3", ""),
        (".2147483648x", "3", ""),
        (
            "*.2147483648d",
            "3x 2x",
            "/usr/bin/bash: printf: 3x: invalid number\n/usr/bin/bash: printf: 2x: invalid number\n",
        ),
        (
            "2147483648.*d",
            "3x 2x",
            "/usr/bin/bash: printf: 3x: invalid number\n/usr/bin/bash: printf: 2x: invalid number\n",
        ),
        (
            "999999999999999999999999999999999999o",
            "bad",
            "/usr/bin/bash: printf: bad: invalid number\n",
        ),
    ] {
        printf::assert_field_overflow(field, values, warnings);
    }
}

#[test]
fn printf_integer_fields_warnings_keep_stream_order_and_stop_precedence() {
    for (source, output, status) in [
        ("printf '[%#08x]' 3x 2>&-", "[0x000003]", 1),
        (r"printf '[%#08x]%bBAD' 3x '\c' 2>&-", "[0x000003]", 0),
        ("printf '[%+08d]' 3x 1>&- 2>&-", "", 1),
        (r"printf '[%+08d]%bBAD' 3x '\c' 1>&- 2>&-", "", 1),
        (
            "printf '[%#08x]' 3x 2>&1",
            "/usr/bin/bash: printf: 3x: invalid number\n[0x000003]",
            1,
        ),
    ] {
        printf::check_status_bytes(source, output.as_bytes(), status);
    }
    printf::assert_diagnostic_backpressure_cancellation(r"printf '[%#08x]%bBAD' 3x '\c'", 2);
}

#[test]
fn printf_integer_fields_reject_unadmitted_width_precision_and_warning_bytes() {
    for source in [
        "printf 'prefix%1000000000d' 1",
        "printf 'prefix%.2147483647o' 1",
        "printf 'prefix%*x' -2147483648 1",
        "printf 'prefix%0*d' 2147483647 1",
        "printf 'prefix%.*u' 2147483647 1",
        "printf '%600d' 1 2",
        r"printf 'prefix%2000d%bBAD' 3x '\c'",
    ] {
        printf::assert_warning_admission(source);
    }
}

#[test]
fn printf_integer_fields_admission_cancellation_is_silent() {
    printf::assert_admission_cancellation("started=yes; printf 'prefix%0900000d' 42; echo bad");
}

#[test]
fn printf_integer_fields_stream_zeroes_in_bounded_chunks() {
    let rig = Rig::new(Limits::default());
    let (output, records) = printf::recorded_endpoint();
    printf::replace_output(&rig, output);
    printf::check_chunks(&rig, &records, "printf '%+08193d' 42", &[4096, 4096, 1]);
    let bytes = records.borrow().concat();
    assert_eq!(bytes.len(), 8193);
    assert_eq!(bytes[0], b'+');
    assert!(bytes[1..8191].iter().all(|byte| *byte == b'0'));
    assert_eq!(&bytes[8191..], b"42");
}

#[test]
fn printf_integer_fields_real_pipe_cancellation_and_failure_keep_only_delivered_bytes() {
    printf::assert_pipe_delivery("printf '%+0200000d' 42; echo bad", b'+', b'0');
}
