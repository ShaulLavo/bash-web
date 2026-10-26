#![cfg(not(target_os = "wasi"))]

use std::process::{Command, Output};

fn env(args: &[&str], inherited: &[(&str, &str)]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_env"))
        .env_clear()
        .envs(inherited.iter().copied())
        .args(args)
        .output()
        .expect("run the new env candidate, not a host env program")
}

#[test]
fn print_only_source_contract_has_exact_bytes() {
    for (args, inherited, expected) in [
        (vec![], vec![("A", "old"), ("B", "keep")], "A=old\nB=keep\n"),
        (vec!["-i", "A=one", "B=two"], vec![], "A=one\nB=two\n"),
        (vec!["-i", "-0", "A=one", "B=two"], vec![], "A=one\0B=two\0"),
        (
            vec!["-u", "A"],
            vec![("A", "old"), ("B", "keep")],
            "B=keep\n",
        ),
        (
            vec!["-i", "-S", "A=one B=\"two words\""],
            vec![],
            "A=one\nB=two words\n",
        ),
        (
            vec!["-i", "-S", "A=pre${BASE}post"],
            vec![("BASE", "middle")],
            "A=premiddlepost\n",
        ),
    ] {
        let output = env(&args, &inherited);
        assert_eq!(output.status.code(), Some(0), "{args:?}: {output:?}");
        assert_eq!(output.stdout, expected.as_bytes(), "{args:?}");
        assert!(output.stderr.is_empty(), "{args:?}: {output:?}");
    }
}

#[test]
fn print_only_local_errors_do_not_need_a_process() {
    for args in [
        vec!["-C", "/"],
        vec!["-u", "bad=name"],
        vec!["-S", "A=one\\q"],
        vec!["-S", "A=$BASE"],
    ] {
        let output = env(&args, &[]);
        assert_eq!(output.status.code(), Some(125), "{args:?}: {output:?}");
        assert!(output.stdout.is_empty(), "{args:?}");
        assert!(!output.stderr.is_empty(), "{args:?}");
    }
}

#[test]
fn debug_printing_does_not_change_environment_output() {
    let output = env(&["-vv", "-i", "A=one"], &[("A", "old")]);
    assert_eq!(output.status.code(), Some(0));
    assert_eq!(output.stdout, b"A=one\n");
    assert!(!output.stderr.is_empty());
}
