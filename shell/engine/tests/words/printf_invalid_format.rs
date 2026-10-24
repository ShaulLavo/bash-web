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

#[test]
fn printf_valid_unimplemented_conversions_keep_unsupported_status() {
    for source in ["printf '%f' 3", "printf '%ls' x", "printf '%n' x"] {
        let rig = Rig::new(Limits::default());
        assert_eq!(rig.run(source), 2);
        assert!(rig.output.bytes().is_empty());
        assert_eq!(
            rig.errors.bytes(),
            b"/usr/bin/bash: printf: unsupported format conversion\n"
        );
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
