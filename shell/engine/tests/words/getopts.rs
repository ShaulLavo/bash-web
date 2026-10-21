//! Adapted Bashkit getopts tests, with original binding and cursor controls.
use super::*;

fn check(source: &str, expected: &str) {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run(source), 0);
    assert_eq!(rig.output.bytes(), expected.as_bytes());
}

#[test]
fn getopts_cluster_arguments_and_end() {
    check(
        r#"set -- -abvalue -c tail; while getopts 'ab:c' o; do echo "$o:${OPTARG-unset}:$OPTIND"; done; echo "$o:${OPTARG-unset}:$OPTIND""#,
        "a:unset:1\nb:value:2\nc:unset:3\n?:unset:3\n",
    );
}

#[test]
fn getopts_silent_errors_and_explicit_arguments() {
    check(
        r#"set -- unchanged; while getopts ':ab:' o -ax -b; do echo "$o:${OPTARG-unset}:$OPTIND"; done; echo "$*:$_OPTCHAR_IDX""#,
        "a:unset:1\n?:x:2\n::b:3\nunchanged:\n",
    );
}

#[test]
fn getopts_local_optind_restores_cluster_and_optarg() {
    check(
        r#"getopts abc o -abc; OPTARG=outer; f() { local OPTIND OPTARG; getopts x: p -x value; echo "$p:$OPTARG:$OPTIND"; }; f; echo "$OPTARG:$OPTIND"; getopts abc o -abc; echo "$o:$OPTIND:${OPTARG-unset}""#,
        "x:value:3\nouter:1\nb:1:unset\n",
    );
}

#[test]
fn getopts_reset_and_subshell_cursor() {
    check(
        r#"getopts abc o -abc; ignored=$(OPTIND=1; getopts xy p -xy); getopts abc o -abc; echo "$o:$OPTIND"; OPTIND=1; getopts abc o -cab; echo "$o:$OPTIND"; unset OPTIND; getopts abc o -abc; echo "$o:$OPTIND""#,
        "b:1\nc:1\na:1\n",
    );
}

#[test]
fn getopts_binding_failures_still_advance() {
    check(
        r#"getopts a: bad- -a value; echo "$?:$OPTIND:$OPTARG"; OPTIND=1; readonly o=old; getopts ab o -ab; echo "$?:$OPTIND:$o"; getopts ab p -ab; echo "$?:$OPTIND:$p""#,
        "1:3:value\n2:1:old\n0:2:b\n",
    );
}

#[test]
fn getopts_special_bindings_and_nameref() {
    check(
        r#"echo "$OPTIND:$OPTERR"; declare -n ref=result; getopts a: ref -a value; echo "$?:$result:$ref:$OPTARG:$OPTIND"; OPTIND=0; getopts ab OPTARG -ab; echo "$OPTARG:$OPTIND""#,
        "1:1\n0:a:a:value:3\na:1\n",
    );
}

#[test]
fn getopts_temporary_optind_and_nonreset_assignment() {
    check(
        r#"getopts abc o -abc; OPTIND=1 getopts xy p -xy; getopts abc o -abc; echo "$p:$o:$OPTIND"; OPTIND=2; getopts abc o -abc -bca; echo "$o:$OPTIND""#,
        "x:a:1\nb:2\n",
    );
}

#[test]
fn getopts_readonly_specials_keep_hidden_progress() {
    check(
        r#"readonly OPTIND=1 OPTARG=old; getopts ab o -ab; echo "$?:$o:$OPTIND:$OPTARG"; getopts ab o -ab; echo "$?:$o:$OPTIND:$OPTARG"; getopts ab o -ab; echo "$?:$o:$OPTIND:$OPTARG""#,
        "0:a:1:old\n0:b:1:old\n1:?:1:old\n",
    );
}

#[test]
fn getopts_failed_argument_admission_leaves_cursor_and_bindings() {
    let rig = Rig::new(Limits {
        expansion_bytes: 4096,
        ..Limits::default()
    });
    assert_eq!(rig.run(&format!("set -- '-a{}'", "x".repeat(3500))), 0);
    assert_eq!(rig.run("getopts a: result"), 2);
    assert_eq!(
        rig.run("echo \"$OPTIND:${result-unset}:${OPTARG-unset}\""),
        0
    );
    assert_eq!(rig.output.bytes(), b"1:unset:unset\n");
    assert_eq!(
        rig.run("getopts a result -a; echo \"$?:$result:$OPTIND\""),
        0
    );
    assert!(rig.output.bytes().ends_with(b"0:a:2\n"));
}

#[test]
fn getopts_large_positional_scan_is_cancellable_and_refunded() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run(&format!("set -- '-a{}'", "x".repeat(100_000))), 0);
    let job = rig.shell.start("getopts a result").unwrap();
    for _ in 0..200 {
        rig.ex.drive(1);
    }
    assert!(!job.is_finished());
    rig.shell.interrupt();
    assert_eq!(rig.finish(job), 130);
    assert_eq!(
        rig.run("echo \"$OPTIND:${result-unset}:${OPTARG-unset}\""),
        0
    );
    assert_eq!(rig.output.bytes(), b"1:unset:unset\n");
    assert_eq!(
        rig.run("getopts a result -a; echo \"$?:$result:$OPTIND\""),
        0
    );
    assert!(rig.output.bytes().ends_with(b"0:a:2\n"));
}

#[test]
fn getopts_optarg_nameref_clears_value_without_removing_reference() {
    check(
        r#"declare -n OPTARG=target; target=old; getopts a o -a; echo "$o:${target-unset}:${OPTARG-unset}"; OPTIND=1; getopts a: o -a value; echo "$o:$target:$OPTARG""#,
        "a:unset:unset\na:value:value\n",
    );
}

#[test]
fn getopts_optind_destination_keeps_scan_but_uses_numeric_binding() {
    check(
        r#"getopts ab OPTIND -ab; echo "$?:$OPTIND"; getopts ab o -ab; echo "$o:$OPTIND""#,
        "0:0\nb:2\n",
    );
}

#[test]
fn getopts_opterr_and_silent_mode_control_exact_option_diagnostics() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("OPTERR=2junk; getopts a o -x"), 0);
    assert_eq!(rig.errors.bytes(), b"/usr/bin/bash: illegal option -- x\n");
    assert_eq!(
        rig.run("OPTIND=1; OPTERR=abc; getopts a o -x; OPTIND=1; getopts :a: o -a"),
        0
    );
    assert_eq!(rig.errors.bytes(), b"/usr/bin/bash: illegal option -- x\n");
    assert_eq!(rig.run("OPTIND=1; OPTERR=1; getopts a: o -a"), 0);
    assert_eq!(
        rig.errors.bytes(),
        b"/usr/bin/bash: illegal option -- x\n/usr/bin/bash: option requires an argument -- a\n"
    );
}
