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

#[test]
fn help_hash_topic_preserves_real_command_recognition_and_hash_entries() {
    let rig = Rig::new(Limits::default());
    assert_eq!(
        rig.run("hash -p /literal tool; command builtin help -s hash; help -s 'ha*'; command builtin hash -t tool; type -t hash; command -v hash; builtin hash -r; printf 'status:%s\\n' \"$?\""),
        0
    );
    assert_eq!(
        rig.output.bytes(),
        b"hash: hash [-lr] [-p pathname] [-dt] [name ...]\nShell commands matching keyword `ha*'\n\nhash: hash [-lr] [-p pathname] [-dt] [name ...]\n/literal\nbuiltin\nhash\nstatus:0\n"
    );
    assert!(rig.errors.bytes().is_empty());
    assert!(rig.calls.borrow().is_empty());
    assert_eq!(rig.host.active_count(), 0);
}

#[test]
fn help_enable_topic_only_advertises_implemented_flags() {
    check_output(
        "help -s enable; builtin help -d enable; command builtin help -m enable; enable -f library printf; echo load:$?; enable -d printf; echo unload:$?; enable -q; echo flag:$?; type -t printf",
        "enable: enable [-anps] [name ...]\nenable - Enable or disable shell builtins, or list their state.\nNAME\n    enable - Enable or disable shell builtins, or list their state.\n\nSYNOPSIS\n    enable [-anps] [name ...]\n\nDESCRIPTION\n    Enable or disable shell builtins, or list their state.\n\nIMPLEMENTATION\n    bash-web\nload:2\nunload:2\nflag:2\nbuiltin\n",
    );
}

#[test]
fn help_enable_dispatch_wrappers_and_hash_keep_registry_precedence() {
    let rig = Rig::new(Limits::default());
    let calls = rig.calls.clone();
    rig.host.register("/home/guest/help", move |request, _| {
        calls.borrow_mut().push(request.argv[1..].to_vec());
        async { 0 }.boxed_local()
    });
    assert_eq!(
        rig.run("hash -p /home/guest/args help; command -v help; enable -n help; command -v help; type -t help; compgen -A disabled help; help direct; command help command; builtin help -s true; echo builtin:$?; enable help; command -v help; command builtin help -s true; help -s false; hash -t help"),
        0
    );
    assert_eq!(
        rig.output.bytes(),
        b"help\n/home/guest/args\nfile\nhelp\nbuiltin:1\nhelp\ntrue: true\nfalse: false\n/home/guest/args\n"
    );
    assert_eq!(*rig.calls.borrow(), &[vec!["direct"], vec!["command"]]);
    assert_eq!(rig.host.active_count(), 0);
}

#[test]
fn help_enable_masks_remain_independent_in_shell_children() {
    check_output(
        "enable -n help; (enable help; help -s true); command -v help; echo parent:$?; enable help; (enable -n help; command -v help; echo child:$?); help -s false; x=$(enable -n help; command -v help; echo substitution:$?); printf '%s\\n' \"$x\"; help -s :",
        "true: true\nparent:1\nchild:1\nfalse: false\nsubstitution:1\n:: :\n",
    );
}
