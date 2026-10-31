use super::Rig;
use shell_engine::Limits;

#[test]
fn mapfile_and_readarray_publish_complete_records() {
    let rig = Rig::new(Limits::default());
    assert_eq!(
        rig.run(
            "mapfile a <<EOF\nfirst\nsecond\n\nEOF\nreadarray -t b <<EOF\nthird\nfourth\nEOF\nprintf 'a=%s|%s|%s b=%s|%s\\n' \"${a[0]}\" \"${a[1]}\" \"${a[2]}\" \"${b[0]}\" \"${b[1]}\""
        ),
        0
    );
    assert_eq!(
        rig.output.bytes(),
        b"a=first\n|second\n|\n b=third|fourth\n"
    );
}

#[test]
fn mapfile_options_keep_origin_skip_delimiter_and_count() {
    let rig = Rig::new(Limits::default());
    assert_eq!(
        rig.run(
            "a=(old0 old1 old2 old3); mapfile -d : -n 2 -s 1 -O 1 -t a <<EOF\nskip:x:y:tail\nEOF\nprintf 'a=%s|%s|%s|%s\\n' \"${a[0]}\" \"${a[1]}\" \"${a[2]}\" \"${a[3]}\""
        ),
        0
    );
    assert_eq!(rig.output.bytes(), b"a=old0|x|y|old3\n");
}

#[test]
fn mapfile_replaces_and_overlay_converts_scalars() {
    let rig = Rig::new(Limits::default());
    assert_eq!(
        rig.run(
            "a=(old); mapfile -t a <<EOF\nnew\nEOF\nb=scalar; mapfile -O 2 -t b <<EOF\nvalue\nEOF\nprintf 'a=%s b=%s|%s\\n' \"${a[0]}\" \"${b[0]}\" \"${b[2]}\""
        ),
        0
    );
    assert_eq!(rig.output.bytes(), b"a=new b=scalar|value\n");
}

#[test]
fn mapfile_rejects_callbacks_and_indexed_nameref_before_input() {
    let rig = Rig::new(Limits::default());
    assert_eq!(
        rig.run(
            "a=(old); mapfile -C callback a <<EOF\nnew\nEOF\nprintf '%s:%s\\n' \"$?\" \"${a[0]}\""
        ),
        0
    );
    assert_eq!(rig.output.bytes(), b"2:old\n");

    let rig = Rig::new(Limits::default());
    assert_eq!(
        rig.run(
            "a=(old); declare -n r='a[1]'; mapfile -t r <<EOF\nnew\nEOF\nprintf '%s:%s\\n' \"$?\" \"${a[0]}\""
        ),
        0
    );
    assert_eq!(rig.output.bytes(), b"1:old\n");
}

#[test]
fn mapfile_rejects_zero_callback_quantum_and_negative_counts() {
    for option in ["0", "+0", "-0"] {
        let rig = Rig::new(Limits::default());
        assert_eq!(
            rig.run(&format!(
                "a=(old); mapfile -c {option} a <<EOF\nnew\nEOF\nprintf '%s:%s\\n' \"$?\" \"${{a[0]}}\""
            )),
            0
        );
        assert_eq!(rig.output.bytes(), b"1:old\n");
    }
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("mapfile -n -1 a <<EOF\nnew\nEOF"), 1);
}

#[test]
fn mapfile_positive_count_leaves_trailing_input_unread() {
    let rig = Rig::new(Limits::default());
    assert_eq!(
        rig.run(
            "printf 'first\\nsecond\\ntail\\n' | { mapfile -n 2 -t a; read -r tail; printf 'n=%s:%s:%s:%s\\n' \"${#a[@]}\" \"${a[0]}\" \"${a[1]}\" \"$tail\"; }"
        ),
        0
    );
    assert_eq!(rig.output.bytes(), b"n=2:first:second:tail\n");
}

#[test]
fn mapfile_default_target_and_empty_operations() {
    let rig = Rig::new(Limits::default());
    assert_eq!(
        rig.run(
            "mapfile -t <<EOF\none\ntwo\nEOF\na=(old); mapfile a <<EOF
EOF
b=one; mapfile -O 2 b <<EOF
EOF
printf 'm=%s:%s a=%s b=%s:%s\\n' \"${MAPFILE[0]}\" \"${MAPFILE[1]}\" \"${#a[@]}\" \"${#b[@]}\" \"${b[0]}\""
        ),
        0
    );
    assert_eq!(rig.output.bytes(), b"m=one:two a=0 b=1:one\n");
}

#[test]
fn mapfile_nul_truncates_only_stored_prefix() {
    let rig = Rig::new(Limits::default());
    assert_eq!(
        rig.run(
            "printf 'x\\0\\377\\n' | { mapfile -t a; printf 'n=%s:<%s>\\n' \"${#a[@]}\" \"${a[0]}\"; }"
        ),
        0
    );
    assert_eq!(rig.output.bytes(), b"n=1:<x>\n");
}

#[test]
fn mapfile_alias_local_and_prefix_lifetimes() {
    let rig = Rig::new(Limits::default());
    assert_eq!(
        rig.run(
            "a=(global keep); a=1 mapfile -t a <<< new; declare -n r=a; mapfile -O 1 -t r <<< through; f() { local a=local; mapfile -O 1 -t a <<< value; printf 'local=%s:%s\\n' \"${a[0]}\" \"${a[1]}\"; }; f; printf 'global=%s:%s\\n' \"${a[0]}\" \"${a[1]}\""
        ),
        0
    );
    assert_eq!(
        rig.output.bytes(),
        b"local=local:value\nglobal=global:through\n"
    );
}

#[test]
fn mapfile_case_attributes_apply_only_new_records() {
    let rig = Rig::new(Limits::default());
    assert_eq!(
        rig.run(
            "a=(old keep); declare -u a; mapfile -O 1 -t a <<< mixed; declare -l b; mapfile -t b <<< MIXED; printf '%s:%s:%s\\n' \"${a[0]}\" \"${a[1]}\" \"${b[0]}\""
        ),
        0
    );
    assert_eq!(rig.output.bytes(), b"old:MIXED:mixed\n");
}

#[test]
fn mapfile_numeric_options_accept_unsigned_32_bit_boundaries() {
    for option in ["-n", "-s", "-O"] {
        for value in ["0", "+0", "-0", "4294967295", " 1 "] {
            let rig = Rig::new(Limits::default());
            assert_eq!(
                rig.run(&format!(
                    "mapfile {option} '{value}' a <<EOF
EOF"
                )),
                0,
                "{option} {value}"
            );
        }
        for value in ["-1", "4294967296", "", "1x", "1.0"] {
            let rig = Rig::new(Limits::default());
            assert_eq!(
                rig.run(&format!(
                    "mapfile {option} '{value}' a <<EOF
EOF"
                )),
                1,
                "{option} {value}"
            );
        }
    }
}

#[test]
fn mapfile_extra_operands_and_repeated_options() {
    let rig = Rig::new(Limits::default());
    assert_eq!(
        rig.run(
            "mapfile -n 1 -n 2 -t a ignored <<EOF\none\ntwo\nthree\nEOF\nprintf '%s:%s:%s\\n' \"${#a[@]}\" \"${a[0]}\" \"${a[1]}\""
        ),
        0
    );
    assert_eq!(rig.output.bytes(), b"2:one:two\n");
}

#[test]
fn mapfile_writes_ten_thousand_records_under_default_limits() {
    let rig = Rig::new(Limits::default());
    let source = format!(
        "mapfile -t a <<EOF\n{}EOF\nprintf '%s:%s:%s\\n' \"${{#a[@]}}\" \"${{a[0]}}\" \"${{a[9999]}}\"",
        "record\n".repeat(10_000)
    );
    assert_eq!(rig.run(&source), 0);
    assert_eq!(rig.output.bytes(), b"10000:record:record\n");
}

fn input(rig: &Rig, input: shell_engine::io::Endpoint) {
    let mut fds = shell_engine::io::FdTable::default();
    fds.insert(0, input);
    fds.insert(1, shell_engine::io::Endpoint::null());
    fds.insert(2, shell_engine::io::Endpoint::null());
    rig.shell.set_descriptors(fds).unwrap();
}

fn pending_prefix(overlay: bool) {
    use futures::FutureExt;
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("a=(o0 o1 o2 o3)"), 0);
    let (reader, writer) = shell_engine::io::pipe();
    assert_eq!(
        writer.write(b"first\nsecond\nunfinished").now_or_never(),
        Some(Ok(23))
    );
    input(&rig, reader);
    let command = if overlay {
        "mapfile -t -O 1 a"
    } else {
        "mapfile -t a"
    };
    let job = rig.shell.start(command).unwrap();
    for _ in 0..50 {
        rig.ex.drive(64);
    }
    assert!(!job.is_finished());
    assert_eq!(
        rig.value("a").as_deref(),
        Some(if overlay { "o0" } else { "first" })
    );
    rig.shell.interrupt();
    assert_eq!(rig.finish(job), 130);
    assert_eq!(rig.run("args \"${a[@]}\""), 0);
    let expected = if overlay {
        vec!["o0", "first", "second", "o3"]
    } else {
        vec!["first", "second"]
    };
    assert_eq!(*rig.calls.borrow(), vec![expected]);
    drop(writer);
}

#[test]
fn mapfile_interruption_preserves_completed_prefix_in_same_session() {
    pending_prefix(false);
    pending_prefix(true);
}

struct BrokenInput(shell_engine::io::Endpoint);
impl shell_engine::io::HostEndpoint for BrokenInput {
    fn read<'a>(
        &'a self,
        output: &'a mut [u8],
    ) -> futures::future::LocalBoxFuture<'a, Result<usize, shell_engine::io::IoError>> {
        use futures::FutureExt;
        async move {
            let count = self.0.read(output).await?;
            if count == 0 {
                return Err(shell_engine::io::IoError::Runtime(5));
            }
            Ok(count)
        }
        .boxed_local()
    }
    fn write<'a>(
        &'a self,
        _input: &'a [u8],
    ) -> futures::future::LocalBoxFuture<'a, Result<usize, shell_engine::io::IoError>> {
        use futures::FutureExt;
        async { Err(shell_engine::io::IoError::BadDescriptor) }.boxed_local()
    }
}

fn broken_input(rig: &Rig) {
    use shell_engine::io::Endpoint;
    let source = BrokenInput(Endpoint::bytes(b"x\ny\npart".to_vec()));
    input(rig, Endpoint::host(std::rc::Rc::new(source)));
}

#[test]
fn mapfile_input_error_publishes_nonempty_partial_tail() {
    let rig = Rig::new(Limits::default());
    broken_input(&rig);
    assert_eq!(rig.run("mapfile -t a; args \"${a[@]}\""), 0);
    assert_eq!(*rig.calls.borrow(), vec![vec!["x", "y", "part"]]);
}

#[test]
fn mapfile_later_invalid_utf8_and_long_record_keep_prefix() {
    use shell_engine::io::Endpoint;
    let rig = Rig::new(Limits {
        line_bytes: 4,
        ..Limits::default()
    });
    input(&rig, Endpoint::bytes(b"a\nb\n12345\n".to_vec()));
    assert_eq!(rig.run("mapfile -t a"), 2);
    assert_eq!(rig.run("args \"${a[@]}\""), 0);
    assert_eq!(*rig.calls.borrow(), vec![vec!["a", "b"]]);
    let rig = Rig::new(Limits::default());
    input(&rig, Endpoint::bytes(b"a\nb\n\xff\n".to_vec()));
    assert_eq!(rig.run("mapfile -t a"), 2);
    assert_eq!(rig.run("args \"${a[@]}\""), 0);
    assert_eq!(*rig.calls.borrow(), vec![vec!["a", "b"]]);
}

#[test]
fn mapfile_rejected_target_leaves_shared_input_unread() {
    for setup in ["readonly a=old", "a=(old); declare -n a_ref='a[1]'"] {
        let rig = Rig::new(Limits::default());
        let target = if setup.contains("a_ref") {
            "a_ref"
        } else {
            "a"
        };
        input(
            &rig,
            shell_engine::io::Endpoint::bytes(b"unread\n".to_vec()),
        );
        assert_eq!(rig.run(setup), 0);
        assert_eq!(rig.run(&format!("mapfile -t {target}")), 1);
        assert_eq!(rig.run("read -r next; args \"$next\""), 0);
        assert_eq!(*rig.calls.borrow(), vec![vec!["unread"]]);
    }
}

#[test]
fn mapfile_input_errors_overlay_and_write_only_files_follow_eof_policy() {
    let rig = Rig::new(Limits::default());
    broken_input(&rig);
    assert_eq!(
        rig.run("a=(o0 o1 o2 o3 o4); mapfile -t -O 1 a; args \"${a[@]}\""),
        0
    );
    assert_eq!(
        *rig.calls.borrow(),
        vec![vec!["o0", "x", "y", "part", "o4"]]
    );
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("a=(old keep); mapfile -t a 0>output; args \"$?\" \"${a[@]}\"; a=(old keep); mapfile -t -O 1 a 0>output; args \"$?\" \"${a[@]}\""), 0);
    assert_eq!(
        *rig.calls.borrow(),
        vec![vec!["0"], vec!["0", "old", "keep"]]
    );
}

#[test]
fn mapfile_projected_targets_and_despecialized_funcname() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("f() { for name in FUNCNAME BASH_SOURCE BASH_LINENO BASH_ARGC BASH_ARGV; do mapfile -t \"$name\" <<< x; args \"$name\" \"$?\"; done; }; f; mapfile -t PIPESTATUS <<< x; args \"$?\"; unset FUNCNAME; mapfile -t FUNCNAME <<< ordinary; args \"${FUNCNAME[@]}\""), 0);
    assert_eq!(
        *rig.calls.borrow(),
        vec![
            vec!["FUNCNAME", "1"],
            vec!["BASH_SOURCE", "1"],
            vec!["BASH_LINENO", "1"],
            vec!["BASH_ARGC", "1"],
            vec!["BASH_ARGV", "1"],
            vec!["2"],
            vec!["ordinary"]
        ]
    );
}

#[test]
fn mapfile_local_prefix_restore_and_exported_arrays() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("a=(global); f() { local a; a=(L1 L2); a=1 mapfile -t -O 1 a <<< z; args \"${a[@]}\"; }; f; args \"${a[@]}\"; export a; mapfile -t a <<< value; args \"${a[@]}\""), 0);
    assert_eq!(
        *rig.calls.borrow(),
        vec![vec!["L1", "L2"], vec!["global"], vec!["value"]]
    );
}

#[test]
fn mapfile_ifs_policy_and_getopts_cursor_are_explicit() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("getopts ab opt -a -b; mapfile -t OPTIND <<< 7; args \"$?\" \"$opt\" \"${OPTIND[0]}\"; getopts ab opt -a -b; args \"$opt\" \"$OPTIND\"; mapfile -t IFS <<< :; v=a:b; args $v; set -- a b; args \"$*\""), 0);
    assert_eq!(
        *rig.calls.borrow(),
        vec![
            vec!["0", "a", "7"],
            vec!["b", "3"],
            vec!["a:b"],
            vec!["a:b"]
        ]
    );
}

#[test]
fn mapfile_ten_thousand_record_overlay_does_not_copy_each_record() {
    let rig = Rig::new(Limits::default());
    let source = format!(
        "mapfile -t a <<EOF\n{}EOF\nmapfile -O 0 -t a <<EOF\n{}EOF\nargs \"${{#a[@]}}\" \"${{a[0]}}\" \"${{a[9999]}}\"",
        "old\n".repeat(10_000),
        "new\n".repeat(10_000)
    );
    assert_eq!(rig.run(&source), 0);
    assert_eq!(*rig.calls.borrow(), vec![vec!["10000", "new", "new"]]);
}
