use serde::Deserialize;
use std::{collections::BTreeSet, process::Command};

#[derive(Deserialize)]
struct Fixture {
    version: String,
    cases: Vec<Case>,
}
#[derive(Deserialize)]
struct Case {
    id: String,
    code: String,
    status: i32,
    stdout: String,
    stderr: String,
}
#[derive(Deserialize)]
struct Rejections {
    diagnostic: String,
    cases: BTreeSet<String>,
}

#[test]
fn pinned_bash_trap_registration() {
    let fixture: Fixture = serde_json::from_str(include_str!(
        "../../../scripts/fixtures/shell-trap-registration.json"
    ))
    .unwrap();
    let mut rejected: Rejections = serde_json::from_str(include_str!(
        "../../../scripts/owned-fixtures/trap-registration-rejections.json"
    ))
    .unwrap();
    assert!(fixture.version.starts_with("GNU bash, version 5.3.15("));
    for case in fixture.cases {
        let output = Command::new(env!("CARGO_BIN_EXE_shell-engine"))
            .args(["-c", &case.code])
            .output()
            .unwrap();
        if rejected.cases.remove(&case.id) {
            assert!(output.status.code().is_some(), "{} status", case.id);
            assert!(
                String::from_utf8_lossy(&output.stderr).contains(&rejected.diagnostic),
                "{} diagnostic: {:?}",
                case.id,
                output.stderr
            );
            continue;
        }
        assert_eq!(
            output.status.code(),
            Some(case.status),
            "{} status",
            case.id
        );
        assert_eq!(output.stdout, case.stdout.as_bytes(), "{} stdout", case.id);
        if case.stderr.is_empty() {
            assert!(
                output.stderr.is_empty(),
                "{} stderr: {:?}",
                case.id,
                output.stderr
            );
        }
    }
    assert!(
        rejected.cases.is_empty(),
        "unknown cases: {:?}",
        rejected.cases
    );
}
