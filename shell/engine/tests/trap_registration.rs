use std::process::Command;

#[test]
fn uncatchable_registrations_remain_queryable_and_resettable() {
    let output = Command::new(env!("CARGO_BIN_EXE_shell-engine"))
        .args([
            "-c",
            "trap : KILL STOP; trap -P KILL; trap -p; trap - KILL STOP; trap -p",
        ])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(0));
    assert_eq!(
        output.stdout,
        b":\ntrap -- ':' SIGKILL\ntrap -- ':' SIGSTOP\n"
    );
    assert!(output.stderr.is_empty());
}
