use super::*;

#[test]
fn command_hash_frozen_bash_recordings() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../scripts/fixtures/shell-command-hash.json"
    ))
    .unwrap();
    assert_eq!(
        fixture["bash"],
        "GNU bash, version 5.3.15(1)-release (x86_64-pc-linux-gnu)"
    );
    for case in fixture["cases"].as_array().unwrap() {
        let rig = Rig::new(Limits::default());
        assert_eq!(
            rig.run(case["script"].as_str().unwrap()),
            case["status"].as_i64().unwrap() as i32,
            "{}",
            case["id"]
        );
        assert_eq!(
            rig.output.bytes(),
            case["stdout"].as_str().unwrap().as_bytes(),
            "{}",
            case["id"]
        );
        assert!(rig.calls.borrow().is_empty());
        assert_eq!(rig.host.active_count(), 0);
    }
}

// Original engine contracts, not additional Bash recordings.
#[test]
fn command_hash_preserves_builtin_function_keyword_and_all_path_queries() {
    check_output(
        "hash -p /literal echo function tool; tool() { :; }; type -t echo function tool; command -v echo function tool; type -P echo; type -aP echo; echo all=$?",
        "builtin\nkeyword\nfunction\necho\nfunction\ntool\n/literal\nall=1\n",
    );
}

#[test]
fn command_hash_literal_entries_never_create_an_executable() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("hash -p /absent tool; type -t tool; command -v tool; tool; echo status=$?; hash -t tool"), 0);
    assert_eq!(rig.output.bytes(), b"file\n/absent\nstatus=127\n/absent\n");
    assert!(rig.calls.borrow().is_empty());
    assert_eq!(rig.host.active_count(), 0);
}

#[test]
fn command_hash_registered_lookup_does_not_spawn_or_replace_execution_resolution() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("hash args; hash -t args; hash -p /literal args; type -aP args; type -a args; command -v args; args ran; hash -t args"), 0);
    assert_eq!(
        rig.output.bytes(),
        b"/home/guest/args\n/home/guest/args\nargs is /home/guest/args\n/literal\n/literal\n"
    );
    assert_eq!(*rig.calls.borrow(), vec![vec!["ran"]]);
    assert_eq!(rig.host.active_count(), 0);
}

#[test]
fn command_hash_wrappers_prefixes_readonly_and_reference_bindings_stay_intact() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("readonly fixed=kept; target=kept; declare -n ref=target; ref=temp builtin hash -p /literal tool; echo $ref $target $fixed; command hash -t tool; builtin hash -r; type -t hash; command -v hash"), 0);
    assert_eq!(
        rig.output.bytes(),
        b"kept kept kept\n/literal\nbuiltin\nhash\n"
    );
    assert_eq!(rig.value("target").as_deref(), Some("kept"));
}

#[test]
fn command_hash_command_substitution_and_subshell_reset_do_not_change_parent() {
    check_output(
        "hash -p /parent tool; value=$(hash -p /child tool; hash -t tool); echo $value; (hash -r; hash); hash -t tool",
        "/child\nhash: hash table empty\n/parent\n",
    );
}

#[test]
fn command_hash_queries_do_not_change_existing_prefix_path_search() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("PATH=/absent command -v args; echo missing=$?; command -v args; PATH=/absent type -P args; echo missing=$?; command -v args"), 0);
    assert_eq!(
        rig.output.bytes(),
        b"missing=1\n/home/guest/args\nmissing=1\n/home/guest/args\n"
    );
    assert_eq!(rig.value("PATH").as_deref(), Some("/home/guest"));
}
