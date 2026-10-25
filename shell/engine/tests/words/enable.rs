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
    assert_eq!(rig.output.bytes(), b"source:0\ntimes:1\nenable .\nenable :\nenable break\nenable continue\nenable eval\nenable exec\nenable exit\nenable export\nenable readonly\nenable return\nenable set\nenable shift\nenable trap\nenable unset\nalias value\ncommand:127\nbuiltin\n");
}

fn check_external_printf(source: &str, expected: &[u8]) {
    let rig = Rig::new(Limits::default());
    let calls = rig.calls.clone();
    rig.host.register("/home/guest/printf", move |request, _| {
        calls.borrow_mut().push(request.argv);
        async { 7 }.boxed_local()
    });
    assert_eq!(rig.run(source), 0);
    assert_eq!(rig.output.bytes(), expected);
    assert_eq!(*rig.calls.borrow(), [vec!["printf", "external"]]);
    assert_eq!(rig.host.active_count(), 0);
}

#[test]
fn enable_disabled_builtin_uses_real_external_and_function_precedence() {
    check_external_printf(
        "enable -n printf; printf() { echo function; }; printf; command printf external; echo external:$?; builtin printf denied; echo builtin:$?; type -at printf; enable printf; printf; command printf '%s\\n' restored",
        b"function\nexternal:7\nbuiltin:1\nfunction\nfile\nfunction\nrestored\n",
    );
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

#[test]
fn enable_source_handlers_share_registry_dispatch_and_completion() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("echo 'echo loaded' > lib; PATH=; enable -n source .; source ./lib; echo direct:$?; builtin . ./lib; echo wrapped:$?; command -v source; echo query:$?; compgen -A disabled source; enable source .; command source ./lib; builtin . ./lib; compgen -A enabled source"), 0);
    assert_eq!(
        rig.output.bytes(),
        b"direct:127\nwrapped:1\nquery:1\nsource\nloaded\nloaded\nsource\n"
    );
}

#[test]
fn enable_sourced_local_append_shares_disable_state_and_restores_local_bindings() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("word=outer; echo 'value=loaded; enable -n printf; local word+=X' > lib; f() { local word=before; source ./lib; echo inside:$word:$value; }; f; type -t printf; echo disabled:$?; enable printf; printf '%s\\n' outside:$word:$value"), 0);
    assert_eq!(
        rig.output.bytes(),
        b"inside:beforeX:loaded\ndisabled:1\noutside:outer:loaded\n"
    );
}

#[test]
fn enable_source_function_changes_share_state_but_subshell_changes_do_not() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("enable -n source; (enable source; type -t source); type -t source; echo parent:$?; f() { enable source; }; f; type -t source"), 0);
    assert_eq!(rig.output.bytes(), b"builtin\nparent:1\nbuiltin\n");
}

#[test]
fn enable_hash_lookup_records_disabled_but_not_enabled_builtins_or_functions() {
    let rig = Rig::new(Limits::default());
    rig.host
        .register("/home/guest/printf", |_, _| async { 7 }.boxed_local());
    assert_eq!(rig.run("hash printf; hash -t printf; echo enabled:$?; enable -n printf; hash printf; hash -t printf; hash -d printf; printf() { :; }; hash printf; hash -t printf; echo function:$?; unset -f printf; command hash printf; enable printf; hash -t printf"), 0);
    assert_eq!(
        rig.output.bytes(),
        b"enabled:1\n/home/guest/printf\nfunction:1\n/home/guest/printf\n"
    );
    assert!(rig.calls.borrow().is_empty());
    assert_eq!(rig.host.active_count(), 0);
}

#[test]
fn enable_hash_queries_keep_builtin_precedence_and_real_execution_resolution() {
    check_external_printf(
        "hash -p /literal printf; type -t printf; command -v printf; enable -n printf; type -t printf; command -v printf; type -P printf; type -aP printf; builtin printf denied; echo builtin:$?; command printf external; echo external:$?; enable printf; command printf '%s\n' restored; hash -t printf",
        b"builtin\nprintf\nfile\n/literal\n/literal\n/home/guest/printf\nbuiltin:1\nexternal:7\nrestored\n/literal\n",
    );
}

#[test]
fn enable_hash_mask_and_table_snapshot_independently_but_functions_share_both() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("hash -p /parent printf; enable -n printf; (enable printf; hash -p /child printf; command -v printf; hash -t printf); command -v printf; value=$(enable printf; hash -r; type -t printf); echo $value; command -v printf; enable printf | hash -r; enable printf & wait; command -v printf; f() { enable printf; hash -p /function printf; }; f; command -v printf; hash -t printf; enable -n hash; builtin hash -r; echo builtin:$?; command hash -r; echo command:$?; enable hash; hash -t printf; compgen -A enabled hash; enable -n hash; compgen -A disabled hash"), 0);
    assert_eq!(rig.output.bytes(), b"printf\n/child\n/parent\nbuiltin\n/parent\n/parent\nprintf\n/function\nbuiltin:1\ncommand:127\n/function\nhash\nhash\n");
    assert!(rig.calls.borrow().is_empty());
    assert_eq!(rig.host.active_count(), 0);
}

#[test]
fn enable_main_boundary_noexec_preserves_registry_hash_and_skips_expansion() {
    let rig = Rig::new(Limits::default());
    rig.fs
        .write_file("/home/guest/lib", b"loaded=yes\n")
        .unwrap();
    assert_eq!(rig.run("enable -n printf; hash -p /kept printf"), 0);
    assert_eq!(
        rig.run("! set -n; enable printf; hash -r; printf '%f' \"$(args BAD)\" > blocked; . ./lib"),
        1
    );
    assert_eq!(rig.run("set +n; enable printf"), 1);
    assert!(rig.shell.state().borrow().noexec);
    assert_eq!(rig.value("loaded"), None);
    assert!(rig.output.bytes().is_empty());
    assert!(rig.calls.borrow().is_empty());
    rig.shell.state().borrow_mut().noexec = false;
    assert_eq!(rig.run("type -t printf; echo type:$?; hash -t printf; enable printf; command printf '%.2f' 1.25"), 0);
    assert_eq!(rig.output.bytes(), b"file\ntype:0\n/kept\n1.25");
    assert!(rig.errors.bytes().is_empty());
}

#[test]
fn enable_main_boundary_interactive_options_and_child_state_stay_independent() {
    let rig = Rig::new(Limits::default());
    rig.shell.state().borrow_mut().interactive = true;
    assert_eq!(rig.run("hash -p /parent printf; enable -n printf; (enable printf; set -n; command printf '%.1f' 2.5); { enable printf; hash -r; set -o noexec; enable -n printf; args BAD; } & wait; command -v printf; hash -t printf; enable printf; set -o noexec; builtin printf '%.1f' 3.5"), 0);
    assert_eq!(rig.output.bytes(), b"2.5/parent\n/parent\n3.5");
    assert!(rig.shell.state().borrow().interactive);
    assert!(!rig.shell.state().borrow().noexec);
    assert!(rig.calls.borrow().is_empty());
    assert!(rig.errors.bytes().is_empty());
}

#[test]
fn enable_main_boundary_float_wrappers_and_disabled_external_hash_lookup() {
    check_external_printf(
        "printf '%.2f|' 1.25; builtin printf '%+.1f|' 2.5; command printf '%g|' 1.5; enable -n printf; hash printf; command printf external; echo status:$?; enable printf; command printf '%.1e\\n' 2.5; hash -t printf",
        b"1.25|+2.5|1.5|status:7\n2.5e+00\n/home/guest/printf\n",
    );
}
