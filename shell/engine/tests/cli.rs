use std::process::Command;

#[test]
fn cli_keeps_stderr_separate_and_returns_status() {
    let output = Command::new(env!("CARGO_BIN_EXE_shell-engine"))
        .args(["-c", "printf out; printf err >&2; exit 7"])
        .output()
        .unwrap();
    assert_eq!(output.stdout, b"out");
    assert_eq!(output.stderr, b"err");
    assert_eq!(output.status.code(), Some(7));
}

#[test]
fn cli_printf_reuses_consuming_formats_for_extra_arguments() {
    let output = Command::new(env!("CARGO_BIN_EXE_shell-engine"))
        .args([
            "-c",
            "printf '<%s>' a b; printf '<%s:%s>' a b c; printf fixed a b; printf '%%' a b",
        ])
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_eq!(output.stdout, b"<a><b><a:b><c:>fixed%");
    assert!(output.stderr.is_empty());
}

#[test]
fn cli_printf_reuses_formats_after_field_splitting() {
    let output = Command::new(env!("CARGO_BIN_EXE_shell-engine"))
        .args(["-c", "values='a b'; printf '<%s>\\n' $values"])
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_eq!(output.stdout, b"<a>\n<b>\n");
    assert!(output.stderr.is_empty());
}

#[test]
fn cli_drains_both_bounded_streams() {
    let output = Command::new(env!("CARGO_BIN_EXE_shell-engine"))
        .args(["-c", "seq 20000 >&2; printf done"])
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_eq!(output.stdout, b"done");
    assert!(output.stderr.starts_with(b"1\n2\n"));
    assert!(output.stderr.ends_with(b"20000\n"));
}

#[test]
fn cli_installs_shared_compatibility_helpers_and_environment() {
    let output = Command::new(env!("CARGO_BIN_EXE_shell-engine"))
        .args(["-c", "argv.py a 'b c'; printenv.py HOME MISSING"])
        .env("HOME", "/home/fixture")
        .env_remove("MISSING")
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_eq!(output.stdout, b"['a', 'b c']\n/home/fixture\nNone\n");
    assert!(output.stderr.is_empty());
}

#[test]
fn cli_system_mount_cannot_create_path_candidates() {
    for source in [
        "mkdir -p /usr/local/bin; printf data > /usr/local/bin/probe; PATH=/usr/local/bin; probe",
        "mkdir -p /usr/local/bin; cat > /usr/local/bin/probe <<'EOF'\ndata\nEOF\nPATH=/usr/local/bin; printf input | probe",
        "mkdir -p /usr/local/bin; cat > /usr/local/bin/probe <<'EOF'\ndata\nEOF\nPATH=/usr/local/bin probe",
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_shell-engine"))
            .args(["-c", source])
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(127), "{source}");
        assert!(output.stdout.is_empty());
    }
}

#[test]
fn cli_system_mount_is_read_only_without_freezing_writable_paths() {
    let source = "mkdir -p /usr/local/bin; printf system > /usr/local/bin/probe; test ! -f /usr/local/bin/probe || exit 9; printf changed > /usr/bin/argv.py; test ! -s /usr/bin/argv.py || exit 8; mkdir -p /tmp/bin /usr-local/bin; printf tmp > /tmp/bin/probe; printf sibling > /usr-local/bin/probe; printf local > probe; cat /tmp/bin/probe /usr-local/bin/probe probe; PATH=.; probe";
    let output = Command::new(env!("CARGO_BIN_EXE_shell-engine"))
        .args(["-c", source])
        .env("PWD", "/home/fixture")
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(126));
    assert_eq!(output.stdout, b"tmpsiblinglocal");
}

#[test]
fn cli_virtual_working_directory_exists_for_file_predicates() {
    let output = Command::new(env!("CARGO_BIN_EXE_shell-engine"))
        .args(["-c", "test -d . && [[ -d $PWD ]] && printf ready"])
        .env("PWD", "/isolated/working-directory")
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(0));
    assert_eq!(output.stdout, b"ready");
    assert!(output.stderr.is_empty());
}
