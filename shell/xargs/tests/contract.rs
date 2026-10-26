#![cfg(not(target_os = "wasi"))]

use std::{
    io::Write,
    process::{Command, Output, Stdio},
};

fn xargs(args: &[&str], input: &[u8]) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_xargs"))
        .args(args)
        .env_clear()
        .env("LC_ALL", "C")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(input).unwrap();
    child.wait_with_output().unwrap()
}

#[test]
fn parses_input_and_batches_internal_echo() {
    for (args, input, expected) in [
        (vec![], &b"one two\nthree\n"[..], &b"one two three\n"[..]),
        (vec!["-n2"], &b"a b c d e"[..], &b"a b\nc d\ne\n"[..]),
        (
            vec![],
            &b"'two words' a\\ b \"c d\"\n"[..],
            &b"two words a b c d\n"[..],
        ),
        (
            vec!["-0", "-n1"],
            &b"a b\0'quoted'\0c\\d\0"[..],
            &b"a b\n'quoted'\nc\\d\n"[..],
        ),
        (vec!["-d", ":", "-n2"], &b"a b:c:d"[..], &b"a b c\nd\n"[..]),
        (vec!["-L1"], &b"a b\nc d\n"[..], &b"a b\nc d\n"[..]),
        (vec!["-s9"], &b"a b c"[..], &b"a b\nc\n"[..]),
        (vec!["-E", "STOP"], &b"a STOP b\n"[..], &b"a\n"[..]),
        (vec![], &b""[..], &b"\n"[..]),
        (vec!["-r"], &b" \t\n"[..], &b""[..]),
    ] {
        let result = xargs(&args, input);
        assert_eq!(result.status.code(), Some(0), "{args:?}: {result:?}");
        assert_eq!(result.stdout, expected, "{args:?}");
        assert!(result.stderr.is_empty(), "{args:?}: {result:?}");
    }
}

#[test]
fn rejects_command_modes_before_opening_input() {
    for args in [
        vec!["-a", "/missing-xargs-input", "echo"],
        vec!["-r", "echo"],
        vec!["--", "/bin/echo"],
        vec!["-n1", "sh", "-c", "exit 99"],
    ] {
        let result = xargs(&args, b"");
        assert_eq!(result.status.code(), Some(1), "{args:?}: {result:?}");
        assert!(result.stdout.is_empty());
        assert!(String::from_utf8_lossy(&result.stderr).contains("runtime_proc.spawn/wait"));
    }
}

#[test]
fn rejects_invalid_input_and_unsupported_modes() {
    for args in [
        vec!["-n0"],
        vec!["-P2"],
        vec!["-I{}"],
        vec!["--replace"],
        vec!["--bad"],
    ] {
        let result = xargs(&args, b"");
        assert_eq!(result.status.code(), Some(1), "{args:?}: {result:?}");
        assert!(result.stdout.is_empty());
        assert!(!result.stderr.is_empty());
    }
    let result = xargs(&[], b"'unterminated");
    assert_eq!(result.status.code(), Some(1));
    assert!(!result.stderr.is_empty());
}

#[test]
fn help_names_the_process_gate_and_version_retains_upstream_identity() {
    let help = xargs(&["--help"], b"");
    assert_eq!(help.status.code(), Some(0));
    assert!(String::from_utf8_lossy(&help.stdout).contains("runtime_proc.spawn/wait"));
    let version = xargs(&["--version"], b"");
    assert_eq!(version.status.code(), Some(0));
    assert_eq!(version.stdout, b"xargs 0.11.0\n");
}
