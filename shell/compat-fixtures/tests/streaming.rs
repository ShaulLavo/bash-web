include!("../../engine/tests/support/streaming.rs");
fn register_utilities(host: &InProcessHost, fs: &MemoryFs, line_bytes: usize) {
    shell_compat_fixtures::register_in_process(
        host,
        "/home/guest",
        Rc::new(fs.clone()),
        line_bytes,
    );
}

fn interrupt_parked_pipeline(rig: &Rig, source: &str) {
    let job = rig.start(source);
    for _ in 0..100 {
        rig.ex.drive(128);
    }
    assert!(!job.is_finished());
    assert!(rig.output.is_empty());
    rig.shell.interrupt();
    assert_eq!(rig.finish(job), 130);
    assert_eq!(rig.host.active_count(), 0);
}
#[test]
fn mkdir_nested_function_pipeline_inherits_unexported_state_and_cwd() {
    let rig = Rig::new();
    assert_eq!(rig.run("mkdir nested; cd nested; secret=retained; f() { printf '%s\\n' \"$secret:$PWD:$1\"; }; f value | cat > result; cat result"), 0);
    assert_eq!(rig.text(), "retained:/home/guest/nested:value\n");
    assert_eq!(
        rig.fs.read_file("/home/guest/nested/result").unwrap(),
        rig.output.bytes()
    );
}

#[test]
fn mkdir_parents_existing_files_and_failures() {
    let rig = Rig::new();
    assert_eq!(
        rig.run("mkdir -p a/b/c; mkdir -p a/b/c; mkdir -p /; mkdir -- ./-name"),
        0
    );
    assert_eq!(rig.run("mkdir a"), 1);
    assert_eq!(rig.run("mkdir missing/child"), 1);
    assert_eq!(rig.run("mkdir"), 2);
    assert_eq!(rig.run("mkdir -x other"), 2);
    assert_eq!(rig.run("mkdir -p ''"), 1);
    rig.fs.write_file("/home/guest/file", b"data").unwrap();
    assert_eq!(rig.run("mkdir -p file"), 1);
    assert_eq!(rig.run("mkdir -p file/child"), 1);
    assert_eq!(rig.fs.read_file("/home/guest/file").unwrap(), b"data");
    assert_eq!(rig.run("mkdir a another"), 1);
    assert_eq!(rig.run("mkdir another"), 1); // The second operand was still created.
    assert_eq!(rig.run("mkdir -p a/b/c/d"), 0);
}

#[test]
fn utility_cat_retains_original_dash_and_device_semantics() {
    let rig = Rig::new();
    rig.fs.write_file("/home/guest/-", b"literal dash").unwrap();
    assert_eq!(rig.run("cat -"), 0);
    assert_eq!(rig.text(), "literal dash");
    assert!(rig.fds.get(1).is_some());
}

#[test]
fn tail_selects_last_lines_and_preserves_record_bytes() {
    let rig = Rig::new();
    assert_eq!(rig.run("seq 1 12 | tail"), 0);
    assert_eq!(rig.text(), "3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n");

    let rig = Rig::new();
    rig.fs
        .write_file("/home/guest/input", b"discard\nkeep\0\r\nlast")
        .unwrap();
    assert_eq!(rig.run("tail -n2 input"), 0);
    assert_eq!(rig.output.bytes(), b"keep\0\r\nlast");

    let rig = Rig::new();
    rig.fs
        .write_file("/home/guest/-n", b"drop\nkeep\n")
        .unwrap();
    assert_eq!(rig.run("tail -n1 -- -n"), 0);
    assert_eq!(rig.text(), "keep\n");

    let rig = Rig::new();
    rig.fs
        .write_file("/home/guest/input", b"one\ntwo\n")
        .unwrap();
    assert_eq!(rig.run("tail -n 0 input"), 0);
    assert!(rig.output.is_empty());
}

#[test]
fn tail_consumes_pipeline_eof_without_streaming_early_output() {
    let rig = Rig::new();
    assert_eq!(rig.run("seq 1 400000 | tail -n 2"), 0);
    assert_eq!(rig.text(), "399999\n400000\n");

    let rig = Rig::new();
    assert_eq!(rig.run("seq 1 400000 | tail -n 0"), 0);
    assert!(rig.output.is_empty());

    let rig = Rig::new();
    interrupt_parked_pipeline(&rig, "ticker | tail");
}

#[test]
fn tail_reports_usage_and_input_errors() {
    for script in [
        "tail -n",
        "tail -n nope",
        "tail -n -1",
        "tail -n +1",
        "tail -x",
        "tail one two",
    ] {
        let rig = Rig::new();
        assert_eq!(rig.run(script), 2, "{script}: {}", rig.text());
        assert!(rig.text().starts_with("tail: "), "{script}");
    }
    let rig = Rig::new();
    assert_eq!(rig.run("tail missing-file"), 1);
    assert!(rig.text().starts_with("tail: missing-file: "));
}

#[test]
fn tail_rejects_unbounded_retention() {
    let source = "for ((i=0;i<2075;i++)); do printf '%8192s' ''; done";
    let rig = Rig::new();
    assert_eq!(rig.run(&format!("{source} | count")), 0);
    assert_eq!(rig.text(), "COUNT:16998400:0\n");

    let rig = Rig::new();
    assert_eq!(rig.run(&format!("{source} | tail -n 1")), 1);
    assert!(rig.text().contains("retained input exceeds 16777216 bytes"));

    let rig = Rig::new();
    assert_eq!(
        rig.run("seq 1 2500000 | tail -n 2500000"),
        1,
        "{}",
        rig.text()
    );
    assert!(rig.text().contains("retained input exceeds 16777216 bytes"));
}

#[test]
fn tail_reports_output_descriptor_errors() {
    let rig = Rig::new();
    assert_eq!(rig.run("exec 1>&-; printf x | tail"), 1, "{}", rig.text());
    assert!(rig.text().contains("tail: standard output is unavailable"));
}
