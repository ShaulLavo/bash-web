//! Original engine controls for the frozen GNU Bash 5.3.15 PATH family.
//! Programs and access answers are exact paths, not basename/spawn probes.
use super::*;

fn path_rig() -> Rig {
    let rig = Rig::new(Limits::default());
    for (directory, status) in [("a", 7), ("b", 9), ("", 3)] {
        let path = if directory.is_empty() {
            "/home/guest/probe".to_owned()
        } else {
            format!("/home/guest/{directory}/probe")
        };
        rig.host
            .register(path, move |_, _| async move { status }.boxed_local());
    }
    rig.fs.mkdir("/home/guest/nonexec", true).unwrap();
    rig.fs
        .write_file("/home/guest/nonexec/probe", b"not runnable")
        .unwrap();
    rig.host
        .register_access("nonexec/probe", "/home/guest", Err(2));
    rig.fs.mkdir("/home/guest/directory/probe", true).unwrap();
    // Real runtime registry returns EACCES for directories, not ENOTDIR.
    rig.host
        .register_access("directory/probe", "/home/guest", Err(2));
    rig.host
        .register_access("not-directory/probe", "/home/guest", Err(54));
    rig
}

#[test]
fn path_search_order_empty_components_relative_cwd_and_failed_candidate_precedence() {
    let rig = path_rig();
    for (path, expected) in [
        ("a:b", 7),
        ("b:a", 9),
        ("missing:a", 7),
        ("", 3),
        ("missing::a", 3),
        ("a:", 7),
        ("nonexec:b", 9),
        ("directory:b", 9),
        ("not-directory:b", 9),
        ("nonexec:missing", 126),
        ("directory", 127),
        ("directory:nonexec", 127),
        ("nonexec:directory", 126),
        // Failed ancestor traversal is not an existing directory candidate.
        ("not-directory:nonexec", 126),
        ("nonexec:", 3),
        ("missing", 127),
    ] {
        rig.variable("PATH", path);
        assert_eq!(rig.run("probe"), expected, "PATH={path}");
        assert_eq!(rig.host.retained_count(), 0);
    }
    assert_eq!(rig.run("unset PATH; probe"), 3);
    assert_eq!(rig.run("PATH=a; PATH=b command probe"), 9);
    assert_eq!(rig.run("probe"), 7, "temporary prefix must restore PATH");
    assert_eq!(rig.run("PATH=b probe"), 9);
    assert_eq!(rig.run("PATH=a PATH=b probe"), 9);
    rig.host
        .register("/usr/bin/probe", |_, _| async { 14 }.boxed_local());
    assert_eq!(rig.run("PATH=b command -p probe"), 14);
    assert_eq!(
        rig.run("probe"),
        7,
        "all temporary PATH bindings must restore"
    );
    rig.fs.mkdir("/home/guest/work", true).unwrap();
    rig.host
        .register("/home/guest/work/probe", |_, _| async { 11 }.boxed_local());
    rig.variable("PATH", "");
    assert_eq!(rig.run("cd work; probe"), 11);
    rig.variable("PATH", "../b");
    assert_eq!(rig.run("probe"), 9);
}

#[test]
fn command_queries_share_lookup_without_spawning_and_preserve_bash_path_spellings() {
    let rig = path_rig();
    for (path, terse, verbose, expected) in [
        ("", "./probe\n", "probe is /home/guest/probe\n", 0),
        ("::", "./probe\n", "probe is /home/guest/probe\n", 0),
        ("./a", "./a/probe\n", "probe is /home/guest/a/probe\n", 0),
        (
            "b/../a",
            "b/../a/probe\n",
            "probe is /home/guest/b/../a/probe\n",
            0,
        ),
        (
            "nonexec",
            "nonexec/probe\n",
            "probe is /home/guest/nonexec/probe\n",
            0,
        ),
        ("directory:nonexec", "", "", 1),
        (
            "nonexec:directory",
            "nonexec/probe\n",
            "probe is /home/guest/nonexec/probe\n",
            0,
        ),
        ("not-directory", "", "", 1),
    ] {
        rig.variable("PATH", path);
        let before = rig.output.bytes().len();
        assert_eq!(rig.run("command -v probe"), expected, "PATH={path}");
        assert_eq!(
            &rig.output.bytes()[before..],
            terse.as_bytes(),
            "PATH={path}"
        );
        let before = rig.output.bytes().len();
        assert_eq!(rig.run("command -V probe"), expected, "PATH={path}");
        assert_eq!(
            &rig.output.bytes()[before..],
            verbose.as_bytes(),
            "PATH={path}"
        );
    }
    assert_eq!(rig.run("command -v ''; command -V ''"), 1);
    assert_eq!(rig.host.active_count(), 0);
    assert_eq!(rig.host.retained_count(), 0);
}

#[test]
fn slash_operands_never_search_path_and_keep_execution_versus_query_statuses() {
    let rig = path_rig();
    rig.variable("PATH", "b");
    for (operand, execution, query) in [
        ("a/probe", 7, 0),
        ("./probe", 3, 0),
        ("/home/guest/a/probe", 7, 0),
        ("nonexec/probe", 126, 1),
        ("directory/probe", 126, 1),
        ("not-directory/probe", 126, 1),
        ("missing/probe", 127, 1),
    ] {
        assert_eq!(rig.run(operand), execution, "{operand}");
        assert_eq!(
            rig.run(&format!("command -v {operand}")),
            query,
            "{operand}"
        );
        assert_eq!(
            rig.run(&format!("command -V {operand}")),
            query,
            "{operand}"
        );
    }
}

#[test]
fn path_admission_is_bounded_and_explicit_queries_do_not_consult_oversized_path() {
    let rig = Rig::new(Limits {
        path_bytes: 4096,
        ..Limits::default()
    });
    rig.variable("PATH", &"missing:".repeat(1024));
    assert_eq!(rig.run("command -v args"), 2);
    assert!(rig.output.bytes().is_empty());
    assert_eq!(rig.run("command -v /home/guest/args"), 0);
    assert_eq!(rig.output.bytes(), b"/home/guest/args\n");
    rig.variable("PATH", "");
    assert_eq!(rig.run("args recovered"), 0);
    assert_eq!(*rig.calls.borrow(), [vec!["recovered"]]);
}

#[test]
fn wide_immediately_ready_path_search_yields_and_interrupts_without_spawn_probes() {
    let rig = Rig::new(Limits::default());
    rig.variable("PATH", &"missing:".repeat(4000));
    let query = rig.shell.start("command -v absent").unwrap();
    let turn = rig.ex.drive(1);
    assert!(
        turn.runnable,
        "lookup must cooperatively yield despite ready X_OK answers"
    );
    assert!(!query.is_finished());
    let progressed = Rc::new(std::cell::Cell::new(false));
    let observed = progressed.clone();
    rig.ex.spawn(async move {
        observed.set(true);
    });
    rig.ex.drive(2);
    assert!(progressed.get(), "a peer task must run during PATH search");
    assert!(!query.is_finished());
    rig.shell.interrupt();
    assert_eq!(rig.finish(query), 130);
    assert!(rig.calls.borrow().is_empty());
    assert_eq!(rig.host.retained_count(), 0);
    rig.variable("PATH", "");
    assert_eq!(rig.run("args recovered"), 0);
}

#[test]
fn resolved_executable_preserves_the_invoked_argv_zero() {
    let rig = path_rig();
    let observed = Rc::new(RefCell::new(Vec::new()));
    let calls = observed.clone();
    rig.host.register("/home/guest/probe", move |request, _| {
        calls.borrow_mut().push(request.argv);
        async { 0 }.boxed_local()
    });
    rig.variable("PATH", "/home/guest");
    for (source, invoked) in [
        ("probe ARG", "probe"),
        ("command probe ARG", "probe"),
        ("./probe ARG", "./probe"),
        ("command ./probe ARG", "./probe"),
        ("/home/guest/probe ARG", "/home/guest/probe"),
    ] {
        assert_eq!(rig.run(source), 0, "{source}");
        assert_eq!(
            observed.borrow().last().unwrap(),
            &[invoked, "ARG"],
            "{source}"
        );
        assert_eq!(rig.host.retained_count(), 0);
    }
}

#[test]
fn nameref_prefix_path_uses_resolved_binding_without_changing_the_caller() {
    let rig = path_rig();
    assert_eq!(rig.run("PATH=a; declare -n p=PATH; p=b probe ARG"), 9);
    assert_eq!(rig.run("p=b command probe ARG"), 9);
    assert_eq!(rig.run("probe"), 7);
    assert_eq!(rig.run("p=b command -v probe"), 0);
    assert_eq!(String::from_utf8(rig.output.bytes()).unwrap(), "b/probe\n");
    assert_eq!(rig.run("test \"$PATH:$p\" = a:a"), 0);
}

#[test]
fn prefix_named_path_resolves_its_nameref_target_instead_of_overriding_search() {
    let rig = path_rig();
    assert_eq!(
        rig.run("unset PATH; other=a; declare -n PATH=other; PATH=b probe ARG"),
        7
    );
    assert_eq!(rig.run("PATH=b command probe ARG"), 7);
    assert_eq!(rig.run("probe"), 7);
    assert_eq!(rig.run("PATH=b command -v probe"), 0);
    assert_eq!(String::from_utf8(rig.output.bytes()).unwrap(), "b/probe\n");
    assert_eq!(rig.run("test \"$PATH:$other\" = a:a"), 0);
}

#[test]
fn external_environment_contains_the_resolved_prefix_bindings() {
    let rig = path_rig();
    let observed = Rc::new(RefCell::new(Vec::new()));
    for (directory, status) in [("a", 7), ("b", 9)] {
        let calls = observed.clone();
        rig.host.register(
            format!("/home/guest/{directory}/probe"),
            move |request, _| {
                calls.borrow_mut().push(request.env);
                async move { status }.boxed_local()
            },
        );
    }
    assert_eq!(rig.run("PATH=a; declare -n p=PATH; p=b probe"), 9);
    assert_eq!(
        observed
            .borrow()
            .last()
            .unwrap()
            .get("PATH")
            .map(String::as_str),
        Some("b")
    );
    assert!(!observed.borrow().last().unwrap().contains_key("p"));
    assert_eq!(
        rig.run("unset -n p; unset PATH; other=a; declare -n PATH=other; PATH=b probe"),
        7
    );
    assert_eq!(
        observed
            .borrow()
            .last()
            .unwrap()
            .get("other")
            .map(String::as_str),
        Some("b")
    );
    assert!(!observed.borrow().last().unwrap().contains_key("PATH"));
    assert_eq!(rig.run("test \"$PATH:$other\" = a:a"), 0);
}

#[test]
fn query_path_join_preserves_existing_slashes_without_adding_another() {
    let rig = path_rig();
    for path in ["/bin/probe", "/probe"] {
        rig.host.register(path, |_, _| async { 0 }.boxed_local());
    }
    for (path, expected) in [
        ("/bin/", "/bin/probe\n"),
        ("/bin///", "/bin///probe\n"),
        ("/", "/probe\n"),
    ] {
        rig.variable("PATH", path);
        let before = rig.output.bytes().len();
        assert_eq!(rig.run("command -v probe"), 0, "PATH={path}");
        assert_eq!(&rig.output.bytes()[before..], expected.as_bytes());
    }
    assert_eq!(rig.run("cd /"), 0);
    rig.variable("PATH", "bin");
    let before = rig.output.bytes().len();
    assert_eq!(rig.run("command -V probe"), 0);
    assert_eq!(&rig.output.bytes()[before..], b"probe is /bin/probe\n");
    assert_eq!(rig.host.retained_count(), 0);
}

#[test]
fn created_nonexecutable_file_is_reported_without_becoming_admitted() {
    let rig = path_rig();
    assert_eq!(rig.run("printf data > tool; PATH=.; tool"), 126);
    let before = rig.output.bytes().len();
    assert_eq!(rig.run("command -v tool"), 0);
    assert_eq!(&rig.output.bytes()[before..], b"./tool\n");
    assert_eq!(rig.run("command tool"), 126);
    assert_eq!(rig.run("./tool"), 126);
    assert_eq!(rig.run("absent"), 127);
    let before = rig.output.bytes().len();
    assert_eq!(rig.run("command -v absent"), 1);
    assert_eq!(rig.output.bytes().len(), before);
    assert_eq!(rig.host.active_count(), 0);
    assert_eq!(rig.host.retained_count(), 0);
}

#[test]
fn explicit_denied_traversal_is_non_runnable_even_without_stat_visibility() {
    let rig = path_rig();
    rig.host
        .register_access("denied/probe", "/home/guest", Err(2));
    assert_eq!(rig.run("denied/probe"), 126);
    assert_eq!(rig.run("command -v denied/probe"), 1);
    rig.variable("PATH", "denied");
    assert_eq!(rig.run("probe"), 127);
}
