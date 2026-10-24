use super::{Limits, Rig, printf};

#[test]
fn printf_character_takes_one_byte_not_a_number_or_unicode_scalar() {
    for locale in ["C", "C.UTF-8"] {
        let rig = Rig::new(Limits::default());
        rig.variable("LC_ALL", locale);
        assert_eq!(rig.run("printf '[%c]' ABC 65 97 é中 中 😀 '\\c'"), 0);
        assert_eq!(rig.output.bytes(), b"[A][6][9][\xc3][\xe4][\xf0][\\]");
        assert!(rig.errors.bytes().is_empty());
    }
}

#[test]
fn printf_character_empty_and_missing_operands_emit_real_nul_bytes() {
    printf::check_bytes("printf '[%c][%c]'", b"[\0][\0]");
    printf::check_bytes("printf '[%c]' '' X", b"[\0][X]");
    printf::check_bytes("printf '[%*.*c]' 4", b"[   \0]");
    printf::check_bytes("printf '[%c]' $'\\0Z'", b"[\0]");
}

#[test]
fn printf_character_fields_ignore_precision_and_non_alignment_flags() {
    for field in ["5", "05", "+5", " 5", "#5", "'5", "5.0", "05.2"] {
        printf::check_bytes(&format!("printf \"[%{field}c]\" ABC"), b"[    A]");
    }
    printf::check_bytes("printf '[%--++## 0005.2c]' ABC", b"[A    ]");
    printf::check_bytes("printf '[%.0c][%.2147483647c]' ABC ''", b"[A][\0]");
    printf::check_bytes("printf '[%.*c]' 2147483647 hello", b"[h]");
    printf::check_bytes("printf '[%.*c]' -1 hello", b"[h]");
}

#[test]
fn printf_character_stars_and_combined_conversions_keep_argument_order() {
    printf::check_bytes(
        "printf '[%*.*c][%s]' -5 0 ABC X 3 2 65 Y",
        b"[A    ][X][  6][Y]",
    );
    printf::check_bytes(
        "printf '[%c][%d][%s][%#04x]' 65 65 hello 65",
        b"[6][65][hello][0x41]",
    );
    printf::check_bytes("printf '[%*.*c]'", b"[\0]");
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("printf '[%*.*c]' '' '' ''"), 1);
    assert_eq!(rig.output.bytes(), b"[\0]");
    assert_eq!(
        rig.errors.bytes(),
        b"/usr/bin/bash: printf: : invalid number\n".repeat(2)
    );
}

#[test]
fn printf_character_literal_overflow_keeps_star_diagnostics_before_field_error() {
    for (field, values, warnings) in [
        ("2147483648c", "hello", ""),
        (".2147483648c", "hello", ""),
        (
            "*.2147483648c",
            "3x hello",
            "/usr/bin/bash: printf: 3x: invalid number\n",
        ),
        (
            "2147483648.*c",
            "2x hello",
            "/usr/bin/bash: printf: 2x: invalid number\n",
        ),
    ] {
        printf::assert_field_overflow(field, values, warnings);
    }
}

#[test]
fn printf_character_star_warnings_keep_merged_stream_order() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("printf '[%*.*c]tail' 3x 2x hello 2>&1"), 1);
    assert_eq!(rig.output.bytes(), b"/usr/bin/bash: printf: 3x: invalid number\n/usr/bin/bash: printf: 2x: invalid number\n[  h]tail");
    assert!(rig.errors.bytes().is_empty());
}

#[test]
fn printf_character_closed_descriptors_and_operand_stop_keep_status_precedence() {
    for (source, output, status) in [
        ("printf '[%*c]' 3x hello 2>&-", &b"[  h]"[..], 1),
        (r"printf '[%*c]%bBAD' 3x hello '\c' 2>&-", &b"[  h]"[..], 0),
        (r"printf '[%c]%bBAD' hello '\c'", &b"[h]"[..], 0),
        ("printf '[%c]' hello 1>&- 2>&-", &b""[..], 1),
        (r"printf '[%*c]%bBAD' 3x hello '\c' 1>&- 2>&-", &b""[..], 1),
    ] {
        printf::check_status_bytes(source, output, status);
    }
    printf::assert_diagnostic_backpressure_cancellation(r"printf '[%*c]%bBAD' 3x hello '\c'", 2);
}

#[test]
fn printf_character_padding_and_warnings_are_admitted_before_output() {
    for source in [
        "printf 'prefix%1000000000c' a",
        "printf 'prefix%*c' -2147483648 a",
        "printf 'prefix%0*c' 2147483647 a",
        "printf 'prefix%600c' a b",
        r"printf 'prefix%2000c%bBAD' a '\c'",
        r"printf 'prefix%*c%bBAD' 2000x hello '\c'",
    ] {
        printf::assert_warning_admission(source);
    }
}

#[test]
fn printf_character_admission_cancellation_is_silent() {
    printf::assert_admission_cancellation("started=yes; printf 'prefix%900000c' ABC; echo bad");
}

#[test]
fn printf_character_padding_remains_chunked_with_exact_nul_and_high_bytes() {
    for (source, first, last) in [
        ("printf '%-8193c' é", 0xc3, b' '),
        ("printf '%8193c' ''", b' ', 0),
    ] {
        let rig = Rig::new(Limits::default());
        let (output, records) = printf::recorded_endpoint();
        printf::replace_output(&rig, output);
        printf::check_chunks(&rig, &records, source, &[4096, 4096, 1]);
        let bytes = records.borrow().concat();
        assert_eq!(bytes.len(), 8193);
        assert_eq!(bytes[0], first);
        assert!(bytes[1..8192].iter().all(|byte| *byte == b' '));
        assert_eq!(bytes[8192], last);
    }
}

#[test]
fn printf_character_real_pipe_cancellation_and_failure_keep_only_delivered_bytes() {
    printf::assert_pipe_delivery("printf '%-200000c' é; echo bad", 0xc3, b' ');
}

#[test]
fn printf_character_partial_writes_retry_without_changing_binary_output() {
    let rig = Rig::new(Limits::default());
    let (output, records) = printf::recorded_endpoint_with_limit(7);
    printf::replace_output(&rig, output);
    assert_eq!(rig.run("printf '[%-8193c][%c]' é ''"), 0);
    let writes = records.borrow();
    assert!(
        writes
            .iter()
            .all(|bytes| !bytes.is_empty() && bytes.len() <= 7)
    );
    let bytes = writes.concat();
    assert_eq!(&bytes[..2], b"[\xc3");
    assert!(bytes[2..8194].iter().all(|byte| *byte == b' '));
    assert_eq!(&bytes[8194..], b"][\0]");
}
