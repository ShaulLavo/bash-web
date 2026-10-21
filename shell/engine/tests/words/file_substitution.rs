use super::*;

#[test]
fn file_read_substitution_captures_and_strips_newlines() {
    check_output(
        "printf 'a b\\nc\\n\\n' >f; x=$(<f); y=`<f`; printf '<%s>|<%s>\\n' \"$x\" \"$y\"; args $(<f); args \"$(<f)\"",
        "<a b\nc>|<a b\nc>\n",
    );
    check(
        "printf 'a b\\nc\\n' >f; args $(<f); args \"$(<f)\"",
        &[&["a", "b", "c"], &["a b\nc"]],
    );
}

#[test]
fn file_read_substitution_target_assigns_in_parent() {
    check_output(
        "printf value >f; unset target; x=$(<\"${target:=f}\"); printf '%s:%s\\n' \"$x\" \"$target\"; unset target; x=`<\"${target:=f}\"`; printf '%s:%s\\n' \"$x\" \"$target\"",
        "value:f\nvalue:f\n",
    );
}

#[test]
fn file_read_substitution_preserves_disabled_contexts() {
    check_output(
        "printf value >f; printf '<%s>|<%s>|<%s>|<%s>\\n' \"$(<f <f)\" \"$(:; <f)\" \"$(v=x <f)\" \"$(<f 2>err)\"; printf '<%s>|<%s>|<%s>|<%s>\\n' \"$(0<f)\" \"`0<f`\" \"$(<f\n\n)\" \"`<f\n\n`\"",
        "<>|<>|<>|<>\n<value>|<>|<value>|<>\n",
    );
}

#[test]
fn file_read_substitution_retains_nul_utf8_and_empty_boundaries() {
    let rig = Rig::new(Limits::default());
    let mut bytes = vec![b'a'; 4095];
    bytes.extend_from_slice("🙂\0\n\0\n".as_bytes());
    rig.fs.write_file("/home/guest/f", &bytes).unwrap();
    assert_eq!(rig.run("args \"$(<f)\""), 0);
    assert_eq!(rig.calls.borrow()[0], [format!("{}🙂", "a".repeat(4095))]);
    assert_eq!(
        String::from_utf8(rig.errors.bytes())
            .unwrap()
            .matches("ignored null byte")
            .count(),
        1
    );
    rig.fs.write_file("/home/guest/f", b"\xff").unwrap();
    assert_eq!(rig.run("args $(<f)"), 2);
    assert_eq!(rig.calls.borrow().len(), 1);
    rig.fs.write_file("/home/guest/f", &[0xf0, 0x9f]).unwrap();
    assert_eq!(rig.run("args $(<f)"), 2);
    assert_eq!(rig.run("args recovered"), 0);
    shutdown_and_check(&rig);
}

#[test]
fn file_read_substitution_obeys_capture_admission_and_recovers() {
    let rig = Rig::new(Limits {
        expansion_bytes: 16 * 1024,
        ..Limits::default()
    });
    rig.fs
        .write_file("/home/guest/f", &vec![b'x'; 64 * 1024])
        .unwrap();
    assert_eq!(rig.run("args $(<f)"), 2);
    assert!(rig.calls.borrow().is_empty());
    assert_eq!(rig.host.active_count(), 0);
    assert_eq!(rig.ex.drive(64).pending, 0);
    rig.fs
        .write_file("/home/guest/f", &vec![b'\n'; 64 * 1024])
        .unwrap();
    assert_eq!(rig.run("args \"$(<f)\""), 0);
    assert_eq!(rig.calls.borrow()[0], [""]);
    assert_eq!(rig.run("args recovered"), 0);
    shutdown_and_check(&rig);
}

#[test]
fn file_read_substitution_interrupt_preserves_background_peer() {
    let rig = Rig::new(Limits::default());
    let (_release, _progress) = register_gated(&rig, b"peer", false);
    assert_eq!(rig.run("gated >peer &"), 0);
    rig.fs
        .write_file("/home/guest/f", &vec![b'x'; 64 * 1024])
        .unwrap();
    let job = rig.shell.start("args $(<f)").unwrap();
    rig.ex.drive(2);
    assert!(!job.is_finished());
    assert!(rig.calls.borrow().is_empty(), "no partial capture dispatch");
    rig.shell.interrupt();
    assert_eq!((rig.finish(job), rig.host.active_count()), (130, 1));
    assert_eq!(rig.run("kill %1; wait %1; args recovered"), 0);
    assert_eq!(rig.host.active_count(), 0);
    shutdown_and_check(&rig);
}

#[test]
fn file_read_substitution_owns_a_live_process_substitution_reader() {
    let rig = Rig::new(Limits::default());
    let (release, _progress) = register_gated(&rig, b"streamed\n\n", false);
    let job = rig.shell.start("args \"$(< <(gated))\"").unwrap();
    rig.ex.drive(64);
    assert!(!job.is_finished());
    assert_eq!(rig.host.active_count(), 1);
    release.cancel();
    assert_eq!(rig.finish(job), 0);
    assert_eq!(rig.calls.borrow()[0], ["streamed"]);
    shutdown_and_check(&rig);
}

#[test]
fn cancelled_file_process_substitution_drains_its_owned_producer() {
    let rig = Rig::new(Limits::default());
    let (_release, _progress) = register_gated(&rig, b"unused", true);
    let job = rig.shell.start("args $(< <(gated))").unwrap();
    rig.ex.drive(64);
    assert_eq!(rig.host.active_count(), 1);
    rig.shell.interrupt();
    assert!(
        rig.calls.borrow().is_empty(),
        "no partial producer capture dispatch"
    );
    assert_eq!(rig.finish(job), 130);
    assert_eq!((rig.host.active_count(), rig.host.retained_count()), (0, 0));
    shutdown_and_check(&rig);
}
