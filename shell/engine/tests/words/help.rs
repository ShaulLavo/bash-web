use super::*;

#[test]
fn help_synopsis_keeps_the_exact_29_byte_contract() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("help -s true false :"), 0);
    assert_eq!(rig.output.bytes(), b"true: true\nfalse: false\n:: :\n");
    assert!(rig.errors.bytes().is_empty());
}

#[test]
fn help_catalogue_admission_fails_before_output_or_binding_mutation() {
    let rig = Rig::new(Limits {
        expansion_bytes: 512,
        ..Limits::default()
    });
    rig.variable("value", "before");
    assert_eq!(rig.run("help -s true"), 2);
    assert!(rig.output.bytes().is_empty());
    assert_eq!(rig.value("value").as_deref(), Some("before"));
    assert_eq!(rig.run("true"), 0);
}

#[test]
fn help_cancellation_restores_local_and_prefix_bindings() {
    let rig = Rig::new(Limits::default());
    rig.variable("value", "outer");
    let query = " true".repeat(256);
    let job = rig.start_until_value(
        &format!("f() {{ local value=inner; ready=yes; value=prefix help -s{query}; }}; f"),
        100_000,
        "ready",
        "yes",
    );
    for _ in 0..100_000 {
        rig.ex.drive(1);
        if !rig.output.bytes().is_empty() {
            break;
        }
    }
    assert!(
        !rig.output.bytes().is_empty(),
        "help must reach output before cancellation"
    );
    rig.interrupt_after_counting_yields(job);
    assert_eq!(rig.value("value").as_deref(), Some("outer"));
    assert_eq!(rig.run("help -s false"), 0);
    assert!(rig.output.bytes().ends_with(b"false: false\n"));
}

#[test]
fn help_closed_output_recovers_without_changing_the_catalogue() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("help -s source . >&-"), 1);
    assert_eq!(rig.run("help -s source ."), 0);
    assert_eq!(
        rig.output.bytes(),
        b"source: source filename [arg ...]\n.: . filename [arg ...]\n"
    );
}

#[test]
fn help_publication_keeps_getopts_cluster_progress() {
    check_output(
        "set -- -ab; getopts ab opt; declare -n _=OPTIND; help -s true; getopts ab opt; printf '%s:%s\\n' \"$opt\" \"$?\"",
        "true: true\nb:0\n",
    );
}

#[test]
fn help_source_publication_restores_prefix_and_appends_the_current_local() {
    check_output(
        "echo 'local value+=s; builtin help -s source .; return 7' > lib; value=outer; f() { local value=b; value=p command builtin source ./lib arg; printf '%s:%s\\n' \"$?\" \"$value\"; }; f; printf '%s\\n' \"$value\"",
        "source: source filename [arg ...]\n.: . filename [arg ...]\n7:b\nouter\n",
    );
}
