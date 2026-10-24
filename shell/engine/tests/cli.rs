use std::process::{Command, Output};

fn run_in(cwd: &str, source: &str) -> Output {
    Command::new(env!("CARGO_BIN_EXE_shell-engine"))
        .args(["-c", source])
        .env("PWD", cwd)
        .output()
        .unwrap()
}

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
    let source = "for ((i=1;i<=20000;i++)); do printf '%s\\n' \"$i\" >&2; done; printf done";
    let output = Command::new(env!("CARGO_BIN_EXE_shell-engine"))
        .args(["-c", source])
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
    let core_sources = [
        "printf data >/usr/bin/probe; PATH=/usr/bin; probe",
        "printf '%s' data >/usr/bin/probe; PATH=/usr/bin; printf input | probe",
        "printf '%s' data >/usr/bin/probe; PATH=/usr/bin probe",
    ];
    let sources = core_sources;
    for source in sources {
        let output = Command::new(env!("CARGO_BIN_EXE_shell-engine"))
            .args(["-c", source])
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(127), "{source}");
        assert!(output.stdout.is_empty());
    }
}

#[test]
fn cli_system_mount_metadata_resolves_aliases_after_validating_traversal() {
    let source = "for p in /usr/bin //usr/bin /./usr/bin /tmp/../usr/bin; do test ! -w \"$p\" || exit 9; done; for p in /tmp /usr/../tmp /usr-local; do test -w \"$p\" || exit 8; done; test ! -e /missing/../usr/bin || exit 7; test ! -e /usr/bin/argv.py/../argv.py || exit 6; printf checked";
    let output = run_in("/usr-local", source);
    assert_eq!(output.status.code(), Some(0));
    assert_eq!(output.stdout, b"checked");
    assert!(output.stderr.is_empty());
}

#[test]
fn cli_fixture_denied_traversal_is_hidden_from_lookup_metadata() {
    // An original minimal control, independent of the frozen PATH matrix.
    let fixture = r#"{"schema":1,"nodes":[{"path":"blocked","kind":"directory","mode":0},{"path":"blocked/tool","kind":"file","mode":493,"marker":"hidden","status":23},{"path":"plain","kind":"directory","mode":493},{"path":"plain/tool","kind":"file","mode":384}]}"#;
    for (source, status, stdout) in [
        ("PATH=blocked; tool", 127, ""),
        ("PATH=blocked; command -v tool", 1, ""),
        ("PATH=blocked; command -V tool", 1, ""),
        ("PATH=blocked:plain; command -v tool", 0, "plain/tool\n"),
        ("PATH=blocked:plain; tool", 126, ""),
        (
            "test -e blocked && test -e blocked/ && test -e blocked// && test ! -e blocked/. && test ! -e blocked/.. && test ! -e blocked/tool && test ! -e blocked/../plain/tool && test ! -e ./blocked//tool && test -e plain/tool && printf checked",
            0,
            "checked",
        ),
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_shell-engine"))
            .args(["-c", source])
            .env("PWD", "/fixture")
            .env("BASH_WEB_PATH_FIXTURE", fixture)
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(status), "{source}");
        assert_eq!(output.stdout, stdout.as_bytes(), "{source}");
    }
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

#[test]
fn core_cli_system_mount_and_writable_siblings_need_no_optional_utilities() {
    let source = "printf system >/usr/bin/probe; test ! -e /usr/bin/probe || exit 9; printf changed >/usr/bin/argv.py; test ! -s /usr/bin/argv.py || exit 8; printf 'tmp\\n' >/tmp/probe; printf 'sibling\\n' > /usr-local/probe; printf 'local\\n' >local-probe; for file in /tmp/probe /usr-local/probe local-probe; do IFS= read -r value < \"$file\"; printf '%s' \"$value\"; done; PATH=.; local-probe";
    let output = run_in("/usr-local", source);
    assert_eq!(output.status.code(), Some(126));
    assert_eq!(output.stdout, b"tmpsiblinglocal");
    assert!(!String::from_utf8_lossy(&output.stderr).contains("omitted capability"));
}
