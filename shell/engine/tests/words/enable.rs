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
    assert_eq!(rig.output.bytes(), b"type:1\nquery:1\nbuiltin:1\ndirect:127\ncommand:127\nrestored\n");
}

#[test]
fn enable_state_follows_function_scope_but_isolates_shell_snapshots() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("PATH=; (enable -n printf; type -t printf); type -t printf; x=$(enable -n printf; type -t printf); type -t printf; enable -n printf | true; type -t printf; enable -n printf & wait; type -t printf; f() { enable -n printf; }; f; type -t printf; echo function:$?; (enable printf; type -t printf); type -t printf; echo parent:$?; enable printf"), 0);
    assert_eq!(rig.output.bytes(), b"builtin\nbuiltin\nbuiltin\nbuiltin\nfunction:1\nbuiltin\nparent:1\n");
}

#[test]
fn enable_does_not_advertise_unavailable_builtins_or_change_alias_precedence() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("enable -n source; echo source:$?; enable times; echo times:$?; enable -s; shopt -s expand_aliases\nalias printf='echo alias'\nenable -n printf\nprintf value\ncommand printf bad; echo command:$?\nenable printf\ncommand printf '%s\\n' builtin"), 0);
    assert_eq!(rig.output.bytes(), b"source:1\ntimes:1\nenable :\nenable break\nenable continue\nenable eval\nenable exec\nenable exit\nenable export\nenable readonly\nenable return\nenable set\nenable shift\nenable trap\nenable unset\nalias value\ncommand:127\nbuiltin\n");
}
