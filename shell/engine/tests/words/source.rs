use super::*;

#[test]
fn source_library_admits_hundreds_of_commands_with_linear_storage() {
    let rig = Rig::new(Limits {
        expansion_bytes: 64 * 1024,
        ..Limits::default()
    });
    rig.fs
        .write_file("/home/guest/lib", &b"x=$((x+1))\n".repeat(800))
        .unwrap();
    assert_eq!(rig.run("x=0; . ./lib; echo src=$? x=$x"), 0);
    assert_eq!(rig.output.bytes(), b"src=0 x=800\n");
    assert!(rig.errors.bytes().is_empty());
}

#[test]
fn source_library_byte_refusal_reports_and_preserves_the_caller() {
    let rig = Rig::new(Limits {
        source_bytes: 512,
        ..Limits::default()
    });
    rig.fs
        .write_file("/home/guest/lib", &b"x=1\n".repeat(200))
        .unwrap();
    assert_eq!(rig.run("set -- original; . ./lib temporary"), 2);
    assert_eq!(rig.value("x"), None);
    assert_eq!(
        rig.errors.bytes(),
        b"/usr/bin/bash: line 1: .: ./lib: shell source limit exceeded\n"
    );
    assert_eq!(rig.run("return 9"), 2);
    assert_eq!(rig.run("args \"$@\""), 0);
    assert_eq!(*rig.calls.borrow(), [vec!["original"]]);
}

#[test]
fn source_library_storage_refusal_reports_and_refunds_read_admission() {
    let rig = Rig::new(Limits {
        expansion_bytes: 16 * 1024,
        ..Limits::default()
    });
    rig.fs
        .write_file("/home/guest/lib", &b"x=1\n".repeat(4000))
        .unwrap();
    rig.fs
        .write_file("/home/guest/small", b"recovered=yes\n")
        .unwrap();
    assert_eq!(rig.run(". ./lib temporary"), 2);
    assert_eq!(rig.value("x"), None);
    assert_eq!(
        rig.errors.bytes(),
        b"/usr/bin/bash: line 1: .: ./lib: shell source storage limit exceeded\n"
    );
    assert_eq!(rig.run(". ./small"), 0);
    assert_eq!(rig.value("recovered").as_deref(), Some("yes"));
    assert_eq!(rig.run("return 9"), 2);
}

#[test]
fn source_library_depth_still_rejects_the_seventeenth_and_recovers() {
    for (levels, status) in [(16, 0), (17, 2)] {
        let rig = Rig::new(Limits::default());
        source_chain(&rig, levels);
        assert_eq!(rig.run("set -- original; . ./level0 temporary"), status);
        assert_eq!(rig.value("reached").is_some(), status == 0);
        assert_eq!(rig.run("return 9"), 2);
        assert_eq!(rig.run("args \"$@\""), 0);
        assert_eq!(*rig.calls.borrow(), [vec!["original"]]);
        assert_eq!(rig.ex.drive(64).pending, 0);
    }
}

fn source_chain(rig: &Rig, levels: usize) {
    for index in 0..levels {
        let text = if index + 1 == levels {
            "reached=yes".to_owned()
        } else {
            format!(". ./level{}", index + 1)
        };
        rig.fs
            .write_file(&format!("/home/guest/level{index}"), text.as_bytes())
            .unwrap();
    }
}

#[test]
fn source_library_interrupt_restores_arguments_and_releases_storage() {
    let rig = Rig::new(Limits {
        expansion_bytes: 64 * 1024,
        ..Limits::default()
    });
    let text = "x=1\n".repeat(800) + "ready=yes; while :; do :; done\n";
    rig.fs
        .write_file("/home/guest/lib", text.as_bytes())
        .unwrap();
    rig.fs
        .write_file("/home/guest/small", b"recovered=yes\n")
        .unwrap();
    assert_eq!(rig.run("set -- original"), 0);
    let job = rig.start_until_value(". ./lib temporary", 100_000, "ready", "yes");
    rig.shell.interrupt();
    assert_eq!(rig.finish(job), 130);
    assert_eq!(rig.run("args \"$@\""), 0);
    assert_eq!(*rig.calls.borrow(), [vec!["original"]]);
    assert_eq!(rig.run("return 9"), 2);
    assert_eq!(rig.run(". ./small"), 0);
    assert_eq!(rig.value("recovered").as_deref(), Some("yes"));
    assert_eq!(rig.ex.drive(64).pending, 0);
}

#[test]
fn source_library_functions_and_snapshots_keep_their_storage_until_reaped() {
    let rig = Rig::new(Limits {
        expansion_bytes: 64 * 1024,
        ..Limits::default()
    });
    let release = command::register_status_gate(&rig, "status_gate", 9);
    let text = "x=1\n".repeat(3000) + "kept() { echo retained; }\n";
    rig.fs
        .write_file("/home/guest/lib", text.as_bytes())
        .unwrap();
    assert_eq!(rig.run(". ./lib"), 0);
    assert_eq!(rig.run("status_gate & background=$!; unset -f kept"), 0);
    assert_eq!(rig.run(". ./lib"), 2);
    release.cancel();
    assert_eq!(rig.run("wait \"$background\""), 9);
    assert_eq!(rig.run("wait"), 0);
    assert_eq!(rig.run(". ./lib; kept; unset -f kept"), 0);
    assert_eq!(rig.output.bytes(), b"retained\n");
    command::shutdown_and_check(&rig);
}

#[test]
fn source_trap_actions_restore_frames_after_nested_eval_interrupt() {
    for event in ["ERR", "RETURN"] {
        let rig = Rig::new(Limits::default());
        rig.fs
            .write_file(
                "/home/guest/action",
                b"set -- changed; local v=source; eval 'ready=yes; while :; do :; done'\n",
            )
            .unwrap();
        assert_eq!(rig.run("v=outer; set -- original"), 0);
        let code = format!(
            "set -ET; trap '. ./action temporary' {event}; f() {{ local v=inner; false; }}; v=prefix f functionarg"
        );
        let job = rig.start_until_value(&code, 100_000, "ready", "yes");
        assert!(!job.is_finished());
        rig.shell.interrupt();
        assert_eq!(rig.finish(job), 130);
        assert_eq!(rig.value("v").as_deref(), Some("outer"));
        assert_eq!(rig.run("trap - ERR RETURN; args \"$@\""), 0);
        assert_eq!(*rig.calls.borrow(), [vec!["original"]]);
        assert_eq!(
            rig.run(
                "echo ${#FUNCNAME[@]}:${#BASH_SOURCE[@]}:${#BASH_LINENO[@]}; eval 'recovered=yes'"
            ),
            0
        );
        assert_eq!(rig.output.bytes(), b"0:0:0\n");
        assert_eq!(rig.value("recovered").as_deref(), Some("yes"));
        assert!(rig.errors.bytes().is_empty());
        assert_eq!(rig.ex.drive(64).pending, 0);
    }
}

#[test]
fn source_trap_actions_retain_definitions_and_refresh_aliases_across_submissions() {
    let rig = Rig::new(Limits::default());
    rig.fs
        .write_file(
            "/home/guest/action",
            b"alias note='echo alias'\nnote\neval 'kept() { local v=retained; echo \"$v:${FUNCNAME[*]:0:1}\"; }'\n",
        )
        .unwrap();
    assert_eq!(
        rig.run("shopt -s expand_aliases; trap '. ./action' ERR; false"),
        1
    );
    assert_eq!(
        rig.run("trap - ERR; kept; unset -f kept; echo ${#FUNCNAME[@]}"),
        0
    );
    assert_eq!(rig.output.bytes(), b"alias\nretained:kept\n0\n");
    assert!(rig.errors.bytes().is_empty());
    assert_eq!(rig.ex.drive(64).pending, 0);
}
