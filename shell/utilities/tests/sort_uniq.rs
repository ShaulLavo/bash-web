#![cfg(not(target_os = "wasi"))]

use std::{
    io::Write,
    process::{Command, Output, Stdio},
};

fn run(binary: &str, args: &[&str], input: &[u8]) -> Output {
    let mut command = Command::new(binary);
    command.env("LC_ALL", "C").args(args);
    command.stdin(Stdio::piped());
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut process = command.spawn().expect("start upstream utility");
    let mut stdin = process.stdin.take().expect("piped stdin");
    stdin.write_all(input).expect("write fixture input");
    drop(stdin);
    process.wait_with_output().expect("collect utility output")
}

#[test]
fn upstream_programs_match_gnu_output_and_status() {
    for (name, binary, args, input) in [
        ("sort", env!("CARGO_BIN_EXE_sort"), vec![], "b\na\nb\n"),
        (
            "sort",
            env!("CARGO_BIN_EXE_sort"),
            vec!["-n"],
            "10\n2\n-3\n",
        ),
        ("sort", env!("CARGO_BIN_EXE_sort"), vec!["-r"], "b\na\nc"),
        ("sort", env!("CARGO_BIN_EXE_sort"), vec!["-u"], "b\na\nb"),
        ("sort", env!("CARGO_BIN_EXE_sort"), vec![], ""),
        ("uniq", env!("CARGO_BIN_EXE_uniq"), vec![], "a\na\nb\na"),
        ("uniq", env!("CARGO_BIN_EXE_uniq"), vec!["-c"], "a\na\nb\n"),
        ("uniq", env!("CARGO_BIN_EXE_uniq"), vec!["-d"], "a\na\nb\n"),
        ("uniq", env!("CARGO_BIN_EXE_uniq"), vec!["-u"], "a\na\nb"),
        ("uniq", env!("CARGO_BIN_EXE_uniq"), vec![], ""),
    ] {
        let expected = run(name, &args, input.as_bytes());
        let actual = run(binary, &args, input.as_bytes());
        assert_eq!(
            actual.status.code(),
            expected.status.code(),
            "{name} {args:?}"
        );
        assert_eq!(actual.stdout, expected.stdout, "{name} {args:?}");
        assert!(actual.stderr.is_empty(), "{actual:?}");
    }
}

#[test]
fn upstream_programs_keep_argument_errors_and_version() {
    for binary in [env!("CARGO_BIN_EXE_sort"), env!("CARGO_BIN_EXE_uniq")] {
        let error = run(binary, &["--not-an-option"], b"");
        assert!(!error.status.success());
        assert!(!error.stderr.is_empty());
        let version = run(binary, &["--version"], b"");
        assert!(version.status.success());
        assert!(String::from_utf8_lossy(&version.stdout).contains("0.12.0"));
    }
}
