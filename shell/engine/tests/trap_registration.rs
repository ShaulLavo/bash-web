use serde::Deserialize;
use std::{collections::BTreeMap, process::Command};

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
    cases: BTreeMap<String, RejectedCase>,
}
#[derive(Deserialize, Debug)]
struct RejectedCase {
    status: i32,
    stdout: String,
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
        let rejected_case = rejected.cases.remove(&case.id);
        let (status, stdout) = rejected_case
            .as_ref()
            .map_or((case.status, case.stdout.as_str()), |row| {
                (row.status, row.stdout.as_str())
            });
        assert_eq!(output.status.code(), Some(status), "{} status", case.id);
        assert_eq!(output.stdout, stdout.as_bytes(), "{} stdout", case.id);
        if rejected_case.is_some() {
            assert!(
                String::from_utf8_lossy(&output.stderr).contains(&rejected.diagnostic),
                "{} diagnostic: {:?}",
                case.id,
                output.stderr
            );
            continue;
        }
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
