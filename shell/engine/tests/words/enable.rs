use super::*;

#[test]
fn enable_disabled_list_starts_empty() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("enable -n"), 0);
    assert!(rig.output.bytes().is_empty());
    assert!(rig.errors.bytes().is_empty());
}

#[test]
fn enable_disable_reenable_controls_dispatch_and_queries() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("PATH=; enable -n printf; type -t printf; echo type:$?; command -v printf; echo query:$?; builtin printf bad; echo builtin:$?; printf bad; echo direct:$?; command printf bad; echo command:$?; enable printf; builtin printf '%s\\n' restored"), 0);
    assert_eq!(
        rig.output.bytes(),
        b"type:1\nquery:1\nbuiltin:1\ndirect:127\ncommand:127\nrestored\n"
    );
}

#[test]
fn enable_state_follows_function_scope_but_isolates_shell_snapshots() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("PATH=; (enable -n printf; type -t printf); type -t printf; x=$(enable -n printf; type -t printf); type -t printf; enable -n printf | true; type -t printf; enable -n printf & wait; type -t printf; f() { enable -n printf; }; f; type -t printf; echo function:$?; (enable printf; type -t printf); type -t printf; echo parent:$?; enable printf"), 0);
    assert_eq!(
        rig.output.bytes(),
        b"builtin\nbuiltin\nbuiltin\nbuiltin\nfunction:1\nbuiltin\nparent:1\n"
    );
}

#[test]
fn enable_does_not_advertise_unavailable_builtins_or_change_alias_precedence() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("enable -n source; echo source:$?; enable times; echo times:$?; enable -s; shopt -s expand_aliases\nalias printf='echo alias'\nenable -n printf\nprintf value\ncommand printf bad; echo command:$?\nenable printf\ncommand printf '%s\\n' builtin"), 0);
    assert_eq!(rig.output.bytes(), b"source:1\ntimes:1\nenable :\nenable break\nenable continue\nenable eval\nenable exec\nenable exit\nenable export\nenable readonly\nenable return\nenable set\nenable shift\nenable trap\nenable unset\nalias value\ncommand:127\nbuiltin\n");
}

#[test]
fn enable_disabled_builtin_uses_real_external_and_function_precedence() {
    let rig = Rig::new(Limits::default());
    let calls = rig.calls.clone();
    rig.host.register("/home/guest/printf", move |request, _| {
        calls.borrow_mut().push(request.argv);
        async { 7 }.boxed_local()
    });
    assert_eq!(rig.run("enable -n printf; printf() { echo function; }; printf; command printf external; echo external:$?; builtin printf denied; echo builtin:$?; type -at printf; enable printf; printf; command printf '%s\\n' restored"), 0);
    assert_eq!(
        rig.output.bytes(),
        b"function\nexternal:7\nbuiltin:1\nfunction\nfile\nfunction\nrestored\n"
    );
    assert_eq!(*rig.calls.borrow(), [vec!["printf", "external"]]);
    assert_eq!(rig.host.active_count(), 0);
}

#[test]
fn enable_listing_filters_repeated_changes_and_rejects_loading() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("enable -n printf echo; enable -n echo; enable -n; enable echo; enable -np; enable -n printf missing; enable -n; enable printf; enable -n; enable -f library printf; echo load:$?; enable -d printf; echo delete:$?; enable -- -bad; echo name:$?"), 0);
    assert_eq!(rig.output.bytes(), b"enable -n echo\nenable -n printf\nenable -n printf\nenable -n printf\nload:2\ndelete:2\nname:1\n");
}

#[test]
fn enable_wrapper_disable_and_exec_redirects_obey_the_same_registry() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("PATH=; enable -n command exec; command echo bad; echo command:$?; exec > output; echo exec:$?; builtin enable command exec; command echo restored; enable -n builtin; builtin echo bad; echo builtin:$?; enable builtin; builtin echo restored"), 0);
    assert_eq!(
        rig.output.bytes(),
        b"command:127\nexec:127\nrestored\nbuiltin:127\nrestored\n"
    );
}

#[test]
fn enable_failed_prefix_admission_does_not_mutate_registry() {
    let rig = Rig::new(Limits {
        expansion_bytes: 128,
        ..Limits::default()
    });
    rig.variable("a", "before");
    assert_eq!(rig.run("a=1 b=2 enable -n printf"), 2);
    assert_eq!(rig.run("type -t printf"), 0);
    assert_eq!(rig.output.bytes(), b"builtin\n");
    assert_eq!(rig.value("a").as_deref(), Some("before"));
}

#[test]
fn enable_cancelled_loop_retains_state_and_releases_tasks() {
    let rig = Rig::new(Limits::default());
    let job = rig
        .shell
        .start("while :; do enable -n printf; enable printf; done")
        .unwrap();
    for _ in 0..100 {
        assert!(rig.ex.drive(64).pending > 0);
        assert!(!job.is_finished());
    }
    rig.shell.interrupt();
    assert_eq!(rig.finish(job), 130);
    assert_eq!(rig.run("enable printf; printf recovered"), 0);
    assert_eq!(rig.output.bytes(), b"recovered");
    assert_eq!(
        (
            rig.ex.drive(64).pending,
            rig.host.active_count(),
            rig.host.retained_count(),
        ),
        (0, 0, 0)
    );
}

#[test]
fn enable_completion_views_follow_disabled_state_without_hiding_builtin_names() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("PATH=; enable -n printf; compgen -A enabled printf; echo enabled:$?; compgen -A disabled printf; compgen -A builtin printf; compgen -A command printf; echo command:$?; enable printf; compgen -A enabled printf; compgen -A disabled printf; echo disabled:$?"), 0);
    assert_eq!(
        rig.output.bytes(),
        b"enabled:1\nprintf\nprintf\ncommand:1\nprintf\ndisabled:1\n"
    );
}
