include!("../../engine/tests/support/streaming.rs");
fn register_utilities(host: &InProcessHost, fs: &MemoryFs, line_bytes: usize) {
    shell_utilities::register_in_process(host, "/home/guest", Rc::new(fs.clone()), line_bytes);
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
fn grep_streams_matching_lines_before_producer_exit() {
    let rig = Rig::new();
    let source = "ticker | grep tick | cat";
    let job = rig.start(source);
    rig.until("tick 0\n");
    assert!(!job.is_finished());
    rig.ticks[0].cancel();
    rig.until("tick 1\n");
    assert!(!job.is_finished());
    rig.shell.interrupt();
    assert_eq!(rig.finish(job), 130);
    assert_eq!(rig.host.active_count(), 0);
}

#[test]
fn grep_unmatched_pipeline_is_cancellable_and_preserves_session() {
    let rig = Rig::new();
    let source = "secret=kept; ticker | copy | grep unmatched; echo BAD_AFTER_INTERRUPT";
    interrupt_parked_pipeline(&rig, source);
    assert_eq!(rig.run("echo \"$secret:$?\""), 0);
    assert_eq!(rig.text(), "kept:130\n");
}

#[test]
fn grep_options_match_gnu_subset_and_statuses() {
    for (script, status, expected) in [
        (
            "printf 'tick\\nmiss\\nTICK\\n' | grep -nvi tick",
            0,
            "2:miss\n",
        ),
        ("printf 'ab\\nabab\\na+b\\n' | grep -Ec '^(ab)+$'", 0, "2\n"),
        (
            "printf 'a+b\\naaab\\nA+B' | grep -Fin a+b",
            0,
            "1:a+b\n3:A+B\n",
        ),
        ("printf 'a+b\\naaab\\n' | grep 'a+b'", 0, "a+b\n"),
        (
            "printf 'ab\\nabab\\na+b\\n' | grep -c '^\\(ab\\)\\+$'",
            0,
            "2\n",
        ),
        ("printf 'tick\\nmiss\\n' | grep -vqc tick", 0, ""),
        ("printf 'tick\\n' | grep -c missing", 1, "0\n"),
        ("printf 'tick\\n' | grep missing", 1, ""),
        ("printf 'abc\\ndef\\n' | grep 'x\ndef'", 0, "def\n"),
        ("printf 'x\\r\\n' | grep 'x$'", 1, ""),
        ("printf '\\n' | grep -n ''", 0, "1:\n"),
        ("printf '' | grep -c ''", 1, "0\n"),
        ("printf -- '-needle\\n' | grep -- -needle", 0, "-needle\n"),
    ] {
        let rig = Rig::new();
        assert_eq!(rig.run(script), status, "{script}: {}", rig.text());
        assert_eq!(rig.text(), expected, "{script}");
    }
    for script in [
        "grep",
        "grep -Z x",
        "grep -EF x",
        "grep -E '['",
        "grep missing-file-pattern no-such-file",
    ] {
        let rig = Rig::new();
        assert_eq!(rig.run(script), 2, "{script}: {}", rig.text());
        assert!(rig.text().starts_with("grep: "));
    }
}

#[test]
fn grep_files_counts_prefixes_quiet_error_priority_and_exact_bytes() {
    let rig = Rig::new();
    rig.fs.write_file("/home/guest/first", b"a\nx\na").unwrap();
    rig.fs.write_file("/home/guest/second", b"y\na\n").unwrap();
    assert_eq!(rig.run("grep -nc a first second"), 0);
    assert_eq!(rig.text(), "first:2\nsecond:1\n");
    let rig = Rig::new();
    rig.fs
        .write_file("/home/guest/bytes", b"x\0\xff\r\nother")
        .unwrap();
    assert_eq!(rig.run("grep -Fn x bytes"), 0);
    assert_eq!(rig.output.bytes(), b"1:x\0\xff\r\n");
    let rig = Rig::new();
    rig.fs.write_file("/home/guest/file", b"hit\n").unwrap();
    assert_eq!(rig.run("grep -q hit missing file"), 0);
    assert!(rig.text().contains("missing:"));
    assert!(!rig.text().contains("hit\n"));
    let rig = Rig::new();
    rig.fs.write_file("/home/guest/file", b"hit\n").unwrap();
    assert_eq!(rig.run("grep hit missing file"), 2);
    assert!(rig.text().contains("file:hit\n"));
}

#[test]
fn grep_quiet_returns_before_eof_and_closes_reader() {
    let rig = Rig::new();
    let job = rig.start("ticker | grep -q tick");
    for _ in 0..100 {
        rig.ex.drive(128);
    }
    assert!(!job.is_finished());
    rig.ticks[0].cancel();
    assert_eq!(rig.finish(job), 0);
    assert!(rig.output.is_empty());
    assert_eq!(rig.run("echo ${PIPESTATUS[0]}:${PIPESTATUS[1]}"), 0);
    assert_eq!(rig.text(), "141:0\n");
}

#[test]
fn grep_streams_more_than_one_mib_and_propagates_broken_pipe() {
    let rig = Rig::new();
    assert_eq!(rig.run("seq 1 400000 | grep -E '^[0-9]+$' | count"), 0);
    assert_eq!(rig.text(), "COUNT:2688895:400000\n");
    let rig = Rig::new();
    assert_eq!(
        rig.run("set -o pipefail; seq 1 400000 | grep . | take"),
        141
    );
    assert_eq!(rig.run("echo ${PIPESTATUS[1]}"), 0);
    assert_eq!(rig.text(), "1\n141\n");
}

#[test]
fn grep_record_and_regex_admission_are_bounded() {
    let rig = Rig::with_limits(Limits {
        line_bytes: 4,
        ..Limits::default()
    });
    assert_eq!(rig.run("printf '12345' | grep ."), 2);
    assert!(rig.text().contains("record limit"));
    let rig = Rig::new();
    assert_eq!(rig.run(&format!("grep '{}'", "x".repeat(4097))), 2);
    assert!(rig.text().contains("pattern byte limit"));
    let rig = Rig::new();
    assert_eq!(rig.run("grep -E 'a{1000000}'"), 2);
    assert!(rig.text().starts_with("grep: "));
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
fn grep_always_ready_unmatched_input_still_observes_cancellation() {
    let rig = Rig::new();
    let source = "seq 1 1000000000000 | grep unmatched";
    interrupt_parked_pipeline(&rig, source);
}

#[test]
fn grep_basic_anchors_only_at_bre_branch_boundaries() {
    // GNU grep observations: internal ^/$ are literal in BRE, but escaped
    // groups and alternation establish new branch-start/end anchor positions.
    let lines = b"a^b\na$b\na\n^a\na$\n^^a\na$$\nab\nb\n^b\n";
    for (pattern, expected) in [
        ("a^b", "1:a^b\n"),
        ("a$b", "2:a$b\n"),
        ("^^a", "4:^a\n"),
        ("a$$", "5:a$\n"),
        (r"a\^b", "1:a^b\n"),
        (r"a\$b", "2:a$b\n"),
        (r"\(^a$\)", "3:a\n"),
        (r"\(^a$\)\|\(^b$\)", "3:a\n9:b\n"),
        (r"z\|^b", "9:b\n"),
        (r"a$\|z", "3:a\n4:^a\n6:^^a\n"),
        (r"z\|^^b", "10:^b\n"),
        (r"\(^\^a\)", "4:^a\n"),
        (r"\(a$\)b", ""),
        (r"a\(^b\)", ""),
        // Unescaped parentheses and pipes are literals, not BRE boundaries.
        ("(^a", ""),
        ("z|^b", ""),
        ("a$)", ""),
    ] {
        let rig = Rig::new();
        rig.fs.write_file("/home/guest/lines", lines).unwrap();
        assert_eq!(
            rig.run(&format!("grep -n '{pattern}' < lines")),
            i32::from(expected.is_empty()),
            "{pattern}: {}",
            rig.text(),
        );
        assert_eq!(rig.text(), expected, "{pattern}");
    }
    let rig = Rig::new();
    rig.fs.write_file("/home/guest/lines", lines).unwrap();
    assert_eq!(rig.run("grep -nE 'a^b' lines"), 1);
    assert_eq!(rig.run("grep -nF 'a$b' lines"), 0);
    assert_eq!(rig.text(), "2:a$b\n");
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
fn grep_descriptor_paths_reopen_regular_files_and_translate_bindings() {
    for path in ["/dev/fd/4", "/proc/self/fd/4", "/dev//fd/4"] {
        let rig = Rig::new();
        rig.fs
            .write_file("/home/guest/file", b"one\ntwo\n")
            .unwrap();
        rig.fs.write_file("/home/guest/other", b"other\n").unwrap();
        let script = format!(
            "exec 3<file; exec 4<&3; exec 3<other; IFS= read -r first <&4; grep one {path}; IFS= read -r next <&4; printf '%s:%s\\n' \"$first\" \"$next\""
        );
        assert_eq!(rig.run(&script), 0, "{path}: {}", rig.text());
        assert_eq!(rig.text(), "one\none:two\n", "{path}");
    }
}

#[test]
fn grep_closed_descriptor_errors_keep_operand_and_quiet_priority() {
    for script in [
        "grep -q hit /dev/fd/4 file",
        "grep -q hit /proc/self/fd/5 file",
        "exec 3<&-; grep -q hit /dev/fd/3 file",
    ] {
        let rig = Rig::new();
        rig.fs.write_file("/home/guest/file", b"hit\n").unwrap();
        assert_eq!(rig.run(script), 0, "{script}: {}", rig.text());
        assert!(rig.text().starts_with("grep: "), "{script}");
        assert!(!rig.text().contains("hit\n"), "{script}");
    }
    let rig = Rig::new();
    assert_eq!(rig.run("printf secret | grep secret /dev/fd/6"), 2);
    assert!(rig.text().starts_with("grep: "));
}
