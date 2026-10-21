use super::{Endpoint, FdTable, Limits, Rig, printf};

const USAGE: &[u8] = b"printf: usage: printf [-v var] format [arguments]\n";

#[test]
fn printf_options_terminator_selects_exactly_the_next_format() {
    for (source, expected) in [
        ("printf -- '-%s-%s-' a b c", &b"-a-b--c--"[..]),
        ("printf -- -- -x", &b"--"[..]),
        ("printf -- -v", &b"-v"[..]),
        ("printf -- -x -v", &b"-x"[..]),
        ("printf -- '' -x", &b""[..]),
        ("printf -- '-%c' é", &b"-\xc3"[..]),
        (r"printf -- %b '\0377\0'", &b"\xff\0"[..]),
    ] {
        printf::check_bytes(source, expected);
    }
}

#[test]
fn printf_options_stop_at_format_and_preserve_option_looking_operands() {
    printf::check_bytes("printf '%s|' -- -v -x --help", b"--|-v|-x|--help|");
    printf::check_bytes("printf -- '%s|' -- -v -x --help", b"--|-v|-x|--help|");
    printf::check_bytes("printf - -- -v", b"-");
    printf::check_bytes("printf +x -v", b"+x");
    printf::check_bytes("printf '' -- -x", b"");
}

#[test]
fn printf_options_missing_format_diagnoses_usage_without_stdout() {
    for source in ["printf", "printf --"] {
        let rig = Rig::new(Limits::default());
        assert_eq!(rig.run(source), 2);
        assert!(rig.output.bytes().is_empty());
        assert_eq!(rig.errors.bytes(), USAGE);
    }
}

#[test]
fn printf_options_missing_variable_operand_diagnoses_before_usage() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("printf -v"), 2);
    assert!(rig.output.bytes().is_empty());
    let expected = b"/usr/bin/bash: printf: -v: option requires an argument\n";
    assert_eq!(rig.errors.bytes(), [expected.as_slice(), USAGE].concat());
}

#[test]
fn printf_options_invalid_option_uses_first_raw_option_byte() {
    for (option, byte) in [
        ("-x", b'x'),
        ("-xyz", b'x'),
        ("-xv", b'x'),
        ("--foo", b'-'),
        ("--help=x", b'-'),
        ("-5", b'5'),
        ("-%s", b'%'),
        ("-é", 0xc3),
    ] {
        let rig = Rig::new(Limits::default());
        assert_eq!(rig.run(&format!("printf '{option}' ignored")), 2);
        assert!(rig.output.bytes().is_empty());
        let expected = [
            &b"/usr/bin/bash: printf: -"[..],
            &[byte],
            b": invalid option\n",
            USAGE,
        ]
        .concat();
        assert_eq!(rig.errors.bytes(), expected, "{option}");
    }
}

#[test]
fn printf_options_usage_errors_keep_status_with_closed_descriptors() {
    for source in ["printf", "printf --", "printf -v", "printf -x"] {
        printf::check_status_bytes(&format!("{source} 2>&-"), b"", 2);
        printf::check_status_bytes(&format!("{source} 1>&- 2>&-"), b"", 2);
    }
    printf::check_status_bytes("printf -- ok 1>&- 2>&-", b"", 1);
    printf::check_status_bytes("printf -- '' 1>&- 2>&-", b"", 0);
}

#[test]
fn printf_options_merged_usage_diagnostics_preserve_order() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("printf -x 2>&1"), 2);
    let expected = b"/usr/bin/bash: printf: -x: invalid option\n";
    assert_eq!(rig.output.bytes(), [expected.as_slice(), USAGE].concat());
    assert!(rig.errors.bytes().is_empty());
}

#[test]
fn printf_options_preserve_warning_and_backslash_c_status_order() {
    for (source, status) in [
        ("printf -- '[%d]' nope", 1),
        (r"printf -- '[%d]%bBAD' nope '\c'", 0),
    ] {
        let rig = Rig::new(Limits::default());
        assert_eq!(rig.run(source), status);
        assert_eq!(rig.output.bytes(), b"[0]");
        assert_eq!(
            rig.errors.bytes(),
            b"/usr/bin/bash: printf: nope: invalid number\n"
        );
    }
    printf::check_bytes(r"printf -- %b 'A\c' -x -- -v", b"A");
}

#[test]
fn printf_options_admit_format_and_usage_before_any_output() {
    printf::assert_warning_admission("printf -- 'prefix%1000000000c' a");
    let rig = Rig::new(Limits {
        expansion_bytes: 64,
        ..Limits::default()
    });
    assert_eq!(rig.run("printf -x 2>&1"), 2);
    assert!(rig.output.bytes().is_empty());
    assert!(rig.errors.bytes().is_empty());
}

#[test]
fn printf_options_admission_and_diagnostic_cancellation_stay_silent() {
    printf::assert_admission_cancellation("started=yes; printf -- 'prefix%900000c' ABC; echo bad");
    printf::assert_diagnostic_backpressure_cancellation("printf -x", 2);
}

#[test]
fn printf_options_delivery_keeps_partial_writes_and_pipe_cancellation() {
    let rig = Rig::new(Limits::default());
    let (output, records) = printf::recorded_endpoint_with_limit(7);
    printf::replace_output(&rig, output);
    assert_eq!(rig.run(r"printf -- %b '\0377\0Z'"), 0);
    let writes = records.borrow();
    assert!(
        writes
            .iter()
            .all(|bytes| !bytes.is_empty() && bytes.len() <= 7)
    );
    assert_eq!(writes.concat(), b"\xff\0Z");
    printf::assert_pipe_delivery("printf -- '%-200000c' é; echo bad", 0xc3, b' ');
}

#[test]
fn printf_options_usage_diagnostics_retry_partial_writes() {
    let rig = Rig::new(Limits::default());
    let (error, records) = printf::recorded_endpoint_with_limit(3);
    let mut fds = FdTable::default();
    fds.insert(0, Endpoint::null());
    fds.insert(1, Endpoint::null());
    fds.insert(2, error);
    rig.shell.set_descriptors(fds).unwrap();
    assert_eq!(rig.run("printf -v"), 2);
    let writes = records.borrow();
    assert!(
        writes
            .iter()
            .all(|bytes| !bytes.is_empty() && bytes.len() <= 3)
    );
    let expected = b"/usr/bin/bash: printf: -v: option requires an argument\n";
    assert_eq!(writes.concat(), [expected.as_slice(), USAGE].concat());
}

#[test]
fn printf_options_do_not_fake_successful_assignment_or_help() {
    for option in ["-v saved", "-vsaved"] {
        let rig = Rig::new(Limits::default());
        rig.variable("saved", "original");
        assert_eq!(rig.run(&format!("printf {option} %s changed")), 2);
        assert!(rig.output.bytes().is_empty());
        assert_eq!(rig.run("printf %s \"$saved\""), 0);
        assert_eq!(rig.output.bytes(), b"original");
    }
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("printf --help"), 2);
    assert!(rig.output.bytes().is_empty());
    assert!(
        rig.errors
            .bytes()
            .starts_with(b"/usr/bin/bash: printf: --help: unsupported option\n")
    );
}

#[test]
fn printf_options_usage_diagnostics_report_broken_pipe_instead_of_usage_status() {
    let rig = Rig::new(Limits::default());
    let (reader, writer) = shell_engine::io::pipe();
    drop(reader);
    let mut fds = FdTable::default();
    fds.insert(0, Endpoint::null());
    fds.insert(1, Endpoint::null());
    fds.insert(2, writer);
    rig.shell.set_descriptors(fds).unwrap();
    assert_eq!(rig.run("printf -x"), 141);
}
