use super::{Limits, Rig, printf};

#[test]
fn printf_invalid_format_matches_recorded_status_and_output() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../scripts/fixtures/shell-printf-invalid-format.json"
    ))
    .unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let source = case["script"].as_str().unwrap();
        let rig = Rig::new(Limits::default());
        assert_eq!(
            rig.run(source),
            case["status"].as_i64().unwrap() as i32,
            "{source}"
        );
        assert_eq!(
            rig.output.bytes(),
            case["stdout"].as_str().unwrap().as_bytes(),
            "{source}"
        );
    }
}

#[test]
fn printf_invalid_format_diagnoses_missing_directive_or_invalid_byte() {
    for (source, diagnostic) in [
        ("printf '%-5.2z' 42", "`%-5.2z': missing format character\n"),
        (r"printf '%z\n' 42", "`\\': invalid format character\n"),
        ("printf '%llY' 42", "`Y': invalid format character\n"),
    ] {
        let rig = Rig::new(Limits::default());
        assert_eq!(rig.run(source), 1);
        assert!(rig.output.bytes().is_empty());
        assert_eq!(
            rig.errors.bytes(),
            format!("/usr/bin/bash: printf: {diagnostic}").as_bytes()
        );
    }
}

#[test]
fn printf_invalid_format_keeps_admission_and_diagnostic_cancellation() {
    printf::assert_warning_admission("printf 'prefix%1000000000s%z' x");
    printf::assert_admission_cancellation("started=yes; printf 'prefix%900000s%z' x; echo bad");
    printf::assert_diagnostic_backpressure_cancellation("printf '%-z' 42", 2);
}

fn assert_unsupported_format(source: &str) {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run(source), 2, "{source}");
    assert!(rig.output.bytes().is_empty(), "{source}");
    assert_eq!(
        rig.errors.bytes(),
        b"/usr/bin/bash: printf: unsupported format conversion\n",
        "{source}"
    );
}

#[test]
fn printf_valid_unimplemented_conversions_keep_unsupported_status() {
    for source in ["printf '%a' 3", "printf '%ls' x", "printf '%n' x"] {
        assert_unsupported_format(source);
    }
}

#[test]
fn printf_valid_unimplemented_wide_conversions_keep_unsupported_status() {
    for source in [
        "printf '%C' 'A'",
        "printf '%S' ''",
        "printf '%lC' 'A'",
        "printf '%lS' ''",
    ] {
        assert_unsupported_format(source);
    }
}

#[test]
fn printf_invalid_format_merged_diagnostics_precede_buffered_prefix() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("printf 'prefix%z' 42 2>&1"), 1);
    assert_eq!(
        rig.output.bytes(),
        b"/usr/bin/bash: printf: `%z': missing format character\nprefix"
    );
    assert!(rig.errors.bytes().is_empty());
}

#[test]
fn printf_invalid_format_broken_diagnostic_pipe_preserves_signal_status() {
    let rig = Rig::new(Limits::default());
    let (reader, writer) = shell_engine::io::pipe();
    drop(reader);
    let mut fds = super::FdTable::default();
    fds.insert(0, super::Endpoint::null());
    fds.insert(1, super::Endpoint::null());
    fds.insert(2, writer);
    rig.shell.set_descriptors(fds).unwrap();
    assert_eq!(rig.run("printf '%z' 42"), 141);
}

#[test]
fn printf_composition_float_family_precedes_missing_format() {
    let rig = Rig::new(Limits::default());
    assert_eq!(
        rig.run("printf '[%e|%E|%f|%F|%g|%G]%-5.2z' 1 2 -0 4 5 6"),
        1
    );
    assert_eq!(
        rig.output.bytes(),
        b"[1.000000e+00|2.000000E+00|-0.000000|4.000000|5|6]"
    );
    assert_eq!(
        rig.errors.bytes(),
        b"/usr/bin/bash: printf: `%-5.2z': missing format character\n"
    );
}

#[test]
fn printf_composition_range_and_invalid_diagnostics_precede_prefix() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("printf '[%g]%Y' 9e2147483647 2>&1"), 1);
    assert_eq!(
        rig.output.bytes(),
        b"/usr/bin/bash: printf: 9e2147483647: Numerical result out of range\n/usr/bin/bash: printf: `Y': invalid format character\n[inf]"
    );
    assert!(rig.errors.bytes().is_empty());
}

#[test]
fn printf_composition_wide_conversions_remain_unsupported_after_float() {
    for conversion in ["C", "S", "lC", "lS"] {
        let rig = Rig::new(Limits::default());
        assert_eq!(
            rig.run(&format!("printf '[%.1f]%{conversion}' 1.25 A")),
            2,
            "{conversion}"
        );
        assert_eq!(rig.output.bytes(), b"[1.2]", "{conversion}");
        assert_eq!(
            rig.errors.bytes(),
            b"/usr/bin/bash: printf: unsupported format conversion\n",
            "{conversion}"
        );
    }
}

#[test]
fn printf_composition_assignment_keeps_unsigned_failed_number_and_format_status() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("x=old; printf -v x '[%f]%z' -"), 1);
    assert_eq!(rig.value("x").as_deref(), Some("[0.000000]"));
    assert!(rig.output.bytes().is_empty());
    assert_eq!(
        rig.errors.bytes(),
        b"/usr/bin/bash: printf: -: invalid number\n/usr/bin/bash: printf: `%z': missing format character\n"
    );
}

#[test]
fn printf_composition_stop_escape_skips_later_format_validation() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run(r"printf '[%.1f]%b%Y%S%g' 1.25 'kept\c' 9"), 0);
    assert_eq!(rig.output.bytes(), b"[1.2]kept");
    assert!(rig.errors.bytes().is_empty());
}

#[test]
fn printf_composition_noexec_skips_float_and_rejection_paths() {
    let rig = Rig::new(Limits::default());
    assert_eq!(
        rig.run("set -n; printf '[%g]%Y%C' 9e2147483647 A; printf '%z'"),
        0
    );
    assert!(rig.output.bytes().is_empty());
    assert!(rig.errors.bytes().is_empty());
    assert!(rig.calls.borrow().is_empty());
}
