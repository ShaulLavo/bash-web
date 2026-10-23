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
        expansion_bytes: 8192,
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
