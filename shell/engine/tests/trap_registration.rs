use serde::Deserialize;
use std::process::Command;

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

#[test]
fn pinned_bash_trap_registration() {
    run_fixture(include_str!(
        "../../../scripts/fixtures/shell-trap-registration.json"
    ));
}

#[test]
fn pinned_bash_trap_actions() {
    run_fixture(include_str!(
        "../../../scripts/fixtures/shell-trap-actions.json"
    ));
}

fn run_fixture(text: &str) {
    let fixture: Fixture = serde_json::from_str(text).unwrap();
    assert!(fixture.version.starts_with("GNU bash, version 5.3.15("));
    let mut failures = Vec::new();
    for case in fixture.cases {
        let output = Command::new(env!("CARGO_BIN_EXE_shell-engine"))
            .args(["-c", &case.code])
            .env_clear()
            .envs([
                ("PATH", "/usr/bin:/bin"),
                ("HOME", "/home/user"),
                ("LC_ALL", "C.UTF-8"),
            ])
            .output()
            .unwrap();
        let pass = output.status.code() == Some(case.status)
            && output.stdout == case.stdout.as_bytes()
            && (!case.stderr.is_empty() || output.stderr.is_empty());
        if !pass {
            failures.push(format!(
                "{}: status {:?}, stdout {:?}, stderr {:?}",
                case.id,
                output.status.code(),
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
