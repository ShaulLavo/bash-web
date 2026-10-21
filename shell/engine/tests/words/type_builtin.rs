//! Type examples adapt Bashkit's type.test.sh at sources.lock.json::shellType.
//! Precedence, descriptor and admission controls are original.
use super::*;

#[test]
fn type_classifies_commands_and_requires_every_operand() {
    let rig = Rig::new(Limits::default());
    assert_eq!(
        rig.run("f() { :; }; type -t while cd f missing echo echo"),
        1
    );
    assert_eq!(
        rig.output.bytes(),
        b"keyword\nbuiltin\nfunction\nbuiltin\nbuiltin\n"
    );
    assert!(rig.errors.bytes().is_empty());
    assert_eq!(rig.host.active_count(), 0);
}

#[test]
fn type_options_preserve_mode_order_force_path_and_function_suppression() {
    for (flags, status, expected) in [
        ("-p", 0, ""),
        ("-P", 1, ""),
        ("-tp", 0, ""),
        ("-pt", 0, "function\nbuiltin\n"),
        ("-Pt", 1, ""),
        ("-ap", 0, ""),
        ("-at", 0, "function\nbuiltin\n"),
        ("-ft", 1, "builtin\n"),
    ] {
        let rig = Rig::new(Limits::default());
        rig.variable("PATH", "/missing");
        assert_eq!(
            rig.run(&format!("f() {{ :; }}; type {flags} f cd")),
            status,
            "{flags}"
        );
        assert_eq!(rig.output.bytes(), expected.as_bytes(), "{flags}");
    }
}

#[test]
fn type_describes_functions_with_the_canonical_ast_printer() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("f() { echo hi; }; type f"), 0);
    assert_eq!(
        rig.output.bytes(),
        b"f is a function\nf () \n{ \n    echo hi\n}\n"
    );
}

#[test]
fn type_all_searches_each_path_entry_without_executing() {
    let rig = Rig::new(Limits::default());
    rig.host.register("/first/probe", |_, _| {
        async { panic!("type must not spawn") }.boxed_local()
    });
    rig.host.register("/second/probe", |_, _| {
        async { panic!("type must not spawn") }.boxed_local()
    });
    rig.variable("PATH", "/first:/second:/first");
    assert_eq!(
        rig.run("probe() { :; }; type -at probe; type -aP probe; type -f -t probe"),
        0
    );
    assert_eq!(
        rig.output.bytes(),
        b"function\nfile\nfile\nfile\n/first/probe\n/second/probe\n/first/probe\nfile\n"
    );
    assert!(rig.calls.borrow().is_empty());
    assert_eq!(rig.host.active_count(), 0);
}

#[test]
fn type_empty_invalid_missing_and_wrapped_invocations() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("type; type --; type -a"), 0);
    assert!(rig.output.bytes().is_empty());
    assert_eq!(rig.run("type -z"), 2);
    assert!(
        rig.errors
            .bytes()
            .ends_with(b"type: usage: type [-afptP] name [name ...]\n")
    );
    assert_eq!(rig.run("type missing"), 1);
    assert!(rig.errors.bytes().ends_with(b"type: missing: not found\n"));
    assert_eq!(
        rig.run("type() { echo shadow; }; type; builtin type -t cd; command type -t cd"),
        0
    );
    assert_eq!(rig.output.bytes(), b"shadow\nbuiltin\nbuiltin\n");
}

#[test]
fn type_closed_output_and_prefix_restore_use_existing_owners() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("type -t cd 1>&-"), 1);
    assert_eq!(rig.run("PATH=/missing type -P args"), 1);
    assert_eq!(rig.run("type -P args"), 0);
    assert_eq!(rig.output.bytes(), b"/home/guest/args\n");
}

#[test]
fn type_preserves_relative_paths_and_filters_directories_and_nonexecutables() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("mkdir directory"), 0);
    rig.variable("PATH", ".");
    assert_eq!(rig.run("printf data > probe; type -p probe; type probe"), 0);
    assert_eq!(rig.output.bytes(), b"./probe\nprobe is ./probe\n");
    assert_eq!(rig.run("type -a probe"), 1);
    assert_eq!(rig.run("type ./probe"), 1);
    assert_eq!(rig.run("type directory"), 1);
}

#[test]
fn type_path_review_recorded_empty_elements_and_unset_path() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../scripts/fixtures/shell-type-path.json"
    ))
    .unwrap();
    assert_eq!(fixture["bash"], "5.3.15(1)-release");
    for case in fixture["cases"].as_array().unwrap() {
        let rig = Rig::new(Limits::default());
        for path in [
            "/home/guest/probe",
            "/home/guest/a/probe",
            "/home/guest/b/probe",
        ] {
            rig.host.register(path, |_, _| {
                async { panic!("type must not spawn") }.boxed_local()
            });
        }
        assert_eq!(
            rig.run(case["code"].as_str().unwrap()),
            i32::try_from(case["status"].as_i64().unwrap()).unwrap(),
            "{}",
            case["id"]
        );
        assert_eq!(
            rig.output.bytes(),
            case["stdout"].as_str().unwrap().as_bytes(),
            "{}",
            case["id"]
        );
        assert_eq!(
            rig.errors.bytes(),
            case["stderr"].as_str().unwrap().as_bytes(),
            "{}",
            case["id"]
        );
    }
}

#[test]
fn type_path_review_preserves_one_shot_unset_and_explicit_slash() {
    for (mode, expected) in [
        ("", "probe is /home/guest/probe\n"),
        ("-p", "/home/guest/probe\n"),
        ("-P", "/home/guest/probe\n"),
        ("-t", "file\n"),
    ] {
        let rig = Rig::new(Limits::default());
        rig.host.register("/home/guest/probe", |_, _| {
            async { panic!("type must not spawn") }.boxed_local()
        });
        assert_eq!(rig.run(&format!("unset PATH; type {mode} probe")), 0);
        assert_eq!(rig.output.bytes(), expected.as_bytes());
    }
    let rig = Rig::new(Limits::default());
    rig.host.register("/home/guest/probe", |_, _| {
        async { panic!("type must not spawn") }.boxed_local()
    });
    assert_eq!(
        rig.run("unset PATH; type -aP ./probe; PATH=: type -p probe"),
        0
    );
    assert_eq!(rig.output.bytes(), b"./probe\n./probe\n");
    let rig = Rig::new(Limits::default());
    rig.host.register("/home/guest/probe", |_, _| {
        async { panic!("type must not spawn") }.boxed_local()
    });
    assert_eq!(rig.run("unset PATH; type -a probe"), 1);
    assert!(rig.output.bytes().is_empty());
    assert!(rig.errors.bytes().ends_with(b"type: probe: not found\n"));
}
