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

struct NoexecSourceFs {
    inner: MemoryFs,
    opens: std::cell::Cell<usize>,
}

impl shell_engine::io::FileSystem for NoexecSourceFs {
    fn mkdir<'a>(
        &'a self,
        path: &'a str,
        parents: bool,
    ) -> futures::future::LocalBoxFuture<'a, Result<(), shell_engine::io::IoError>> {
        Box::pin(async move { self.inner.mkdir(path, parents) })
    }

    fn open<'a>(
        &'a self,
        path: &'a str,
        options: &'a shell_engine::io::OpenOptions,
    ) -> futures::future::LocalBoxFuture<'a, Result<Endpoint, shell_engine::io::IoError>> {
        self.opens.set(self.opens.get() + 1);
        Box::pin(async move { self.inner.open(path, options) })
    }
}

#[test]
fn noexec_skips_source_before_opening_while_the_paired_control_really_executes() {
    for name in [".", "source"] {
        let rig = Rig::new(Limits::default());
        rig.fs
            .write_file("/home/guest/lib", b"loaded=yes; return 9\n")
            .unwrap();
        let fs = Rc::new(NoexecSourceFs {
            inner: rig.fs.clone(),
            opens: std::cell::Cell::new(0),
        });
        let shell = Session::new(
            rig.ex.clone(),
            Rc::new(rig.host.clone()),
            fs.clone(),
            Limits::default(),
        );
        let (output, captured) = capture(4096);
        let mut descriptors = FdTable::default();
        descriptors.insert(1, output);
        shell.set_descriptors(descriptors).unwrap();
        assert_eq!(rig.finish(shell.start("set -- original tail").unwrap()), 0);
        let source = format!("{name} /home/guest/lib supplied");
        let arguments = r#"printf '%s:%s:%s\n' "$#" "$1" "$2""#;
        shell.state().borrow_mut().publish_status(7);
        shell.state().borrow_mut().noexec = true;
        assert_eq!(rig.finish(shell.start(&source).unwrap()), 7);
        assert_eq!(fs.opens.get(), 0, "no source open or body read: {name}");
        assert!(!shell.state().borrow().bindings().contains_key("loaded"));
        assert!(captured.bytes().is_empty());
        shell.state().borrow_mut().noexec = false;
        assert_eq!(rig.finish(shell.start(arguments).unwrap()), 0);
        assert_eq!(captured.bytes(), b"2:original:tail\n");
        assert_eq!(rig.finish(shell.start(&source).unwrap()), 9);
        assert_eq!(fs.opens.get(), 1, "positive source dispatch: {name}");
        assert_eq!(shell.state().borrow().bindings()["loaded"], "yes");
        assert_eq!(rig.finish(shell.start(arguments).unwrap()), 0);
        assert_eq!(captured.bytes(), b"2:original:tail\n2:original:tail\n");
        rig.fs
            .write_file(
                "/home/guest/lib",
                b"local v+=S; eval 'local v+=E'; loaded_append=$v; return 9\n",
            )
            .unwrap();
        let define = format!("v=outer; f(){{ {name} /home/guest/lib supplied; }}");
        assert_eq!(rig.finish(shell.start(&define).unwrap()), 0);
        shell.state().borrow_mut().publish_status(7);
        shell.state().borrow_mut().noexec = true;
        let invocation = "v=prefix f function";
        assert_eq!(rig.finish(shell.start(invocation).unwrap()), 7);
        assert_eq!(
            fs.opens.get(),
            1,
            "suppressed prefix/function/source: {name}"
        );
        assert!(
            !shell
                .state()
                .borrow()
                .bindings()
                .contains_key("loaded_append")
        );
        assert_eq!(shell.state().borrow().bindings()["v"], "outer");
        shell.state().borrow_mut().noexec = false;
        assert_eq!(rig.finish(shell.start(invocation).unwrap()), 9);
        assert_eq!(fs.opens.get(), 2, "enabled prefix/function/source: {name}");
        assert_eq!(
            shell.state().borrow().bindings()["loaded_append"],
            "prefixSE"
        );
        assert_eq!(shell.state().borrow().bindings()["v"], "outer");
        assert_eq!(rig.finish(shell.start(arguments).unwrap()), 0);
        assert_eq!(
            captured.bytes(),
            b"2:original:tail\n2:original:tail\n2:original:tail\n"
        );
        assert_eq!(rig.host.active_count(), 0);
        assert_eq!(rig.host.retained_count(), 0);
        assert!(shell.shutdown().now_or_never().is_some());
        assert_eq!(rig.ex.drive(64).pending, 0);
    }
}

#[test]
fn source_eval_local_append_preserves_function_prefix_and_caller_positionals() {
    for name in [".", "source"] {
        let rig = Rig::new(Limits::default());
        rig.fs.write_file("/home/guest/lib", br#"local v+=S; eval 'local v+=E'; printf 'body:%s:%s:%s\n' "$v" "$#" "$1"; return 9
"#).unwrap();
        let source = format!(
            r#"v=outer; set -- caller tail; f(){{ {name} ./lib supplied tail; result=$?; printf 'after:%s:%s:%s:%s\n' "$result" "$v" "$#" "$1"; }}; v=prefix f function; printf 'outer:%s:%s:%s\n' "$v" "$#" "$1""#
        );
        assert_eq!(rig.run(&source), 0);
        assert_eq!(
            rig.output.bytes(),
            b"body:prefixSE:2:supplied\nafter:9:prefixSE:1:function\nouter:outer:2:caller\n"
        );
        assert!(rig.errors.bytes().is_empty());
        command::shutdown_and_check(&rig);
    }
}

#[test]
fn source_eval_local_append_cancellation_restores_array_reference_prefix_and_arguments() {
    let rig = Rig::new(Limits::default());
    rig.variable("payload", &"a".repeat(12000));
    rig.fs
        .write_file(
            "/home/guest/lib",
            b"ready=yes; eval 'local r+=x'; after=yes\n",
        )
        .unwrap();
    assert_eq!(
        rig.run("a=(outer keep); declare -n r=a; v=outer; set -- caller tail"),
        0
    );
    let job = rig.start_until_value(
        r#"f(){ local a; a=("$payload" keep); local -n r=a; . ./lib supplied tail; }; v=prefix f function"#,
        100_000, "ready", "yes",
    );
    rig.interrupt_after_counting_yields(job);
    assert_eq!(rig.value("after"), None);
    assert_eq!(rig.value("v").as_deref(), Some("outer"));
    assert_eq!(
        rig.run(r#"declare -p r; printf '<%s>\n' "${a[@]}"; printf '%s:%s:%s\n' "$#" "$1" "$2""#),
        0
    );
    assert_eq!(
        rig.output.bytes(),
        b"declare -n r=\"a\"\n<outer>\n<keep>\n2:caller:tail\n"
    );
    assert!(rig.errors.bytes().is_empty());
    rig.fs
        .write_file("/home/guest/small", b"recovered=yes\n")
        .unwrap();
    assert_eq!(rig.run(". ./small"), 0);
    assert_eq!(rig.value("recovered").as_deref(), Some("yes"));
    command::shutdown_and_check(&rig);
}
