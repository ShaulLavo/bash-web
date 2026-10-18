mod support;
use shell_engine::{
    io::{PIPE_CAPACITY, pipe},
    process::ProcessHost,
};
fn register_utilities(
    host: &shell_engine::process::InProcessHost,
    fs: &shell_engine::io::MemoryFs,
    _line_bytes: usize,
) {
    support::register_utilities(host, fs, true);
}
include!("support/streaming.rs");
#[test]
fn ticker_streams_through_filter_before_exit() {
    let rig = Rig::new();
    let job = rig.start("ticker | filter tick | cat");
    rig.until("tick 0\n");
    assert!(!job.is_finished());
    assert!(rig.host.active_count() > 0);
    rig.ticks[0].cancel();
    rig.until("tick 1\n");
    assert!(!job.is_finished());
    rig.ticks[1].cancel();
    rig.until("tick 2\n");
    rig.shell.interrupt();
    assert_eq!(rig.finish(job), 130);
    assert_eq!(rig.host.active_count(), 0);
    assert_eq!(rig.run("echo INTERRUPT:$?"), 0);
    assert!(rig.text().contains("INTERRUPT:130\n"));
}
#[test]
fn more_than_one_mib_builtin_to_external() {
    let r = Rig::new();
    assert_eq!(r.run("seq 1 400000 | count"), 0);
    assert_eq!(r.text(), "COUNT:2688895:400000\n");
}
#[test]
fn more_than_one_mib_external_to_builtin() {
    let r = Rig::new();
    assert_eq!(r.run("emit 2097169 | cat > complete"), 0);
    let bytes = r.fs.read_file("/home/guest/complete").unwrap();
    assert_eq!(bytes.len(), 2097169);
    assert!(
        bytes
            .iter()
            .enumerate()
            .all(|(i, &v)| v == (i / 8192 % 251) as u8)
    );
}
#[test]
fn more_than_one_mib_external_to_external() {
    let r = Rig::new();
    assert_eq!(r.run("emit 4202496 | verify"), 0);
    assert_eq!(r.text(), "COUNT:4202496:true\n");
}
#[test]
fn more_than_one_mib_builtin_to_builtin() {
    let r = Rig::new();
    assert_eq!(r.run("seq 1 400000 | cat > complete"), 0);
    let bytes = r.fs.read_file("/home/guest/complete").unwrap();
    assert_eq!(bytes.len(), 2688895);
    let expected = (1..=400000).map(|n| format!("{n}\n")).collect::<String>();
    assert_eq!(bytes, expected.as_bytes());
}
#[test]
fn interrupt_confirms_every_stage_exit_and_suppresses_remaining_list() {
    let r = Rig::new();
    let job =
        r.start("export KEEP=kept; endless | copy | filter unmatched; echo BAD_AFTER_INTERRUPT");
    r.until("PRODUCER_READY");
    r.ex.drive(1000);
    assert!(r.host.active_count() >= 3);
    r.shell.interrupt();
    assert_eq!(r.finish(job), 130);
    assert_eq!(r.host.active_count(), 0);
    assert!(!r.text().contains("BAD_AFTER_INTERRUPT"));
    assert_eq!(r.run("echo STATUS:$?:$KEEP"), 0);
    assert!(r.text().contains("STATUS:130:kept\n"));
}

macro_rules! status_case {
    ($name:ident,$script:literal,$expected:literal) => {
        #[test]
        fn $name() {
            let r = Rig::new();
            assert_eq!(
                r.run(concat!(
                    $script,
                    "; printf 'STATUS:%s:%s\\n' \"$?\" \"${PIPESTATUS[*]}\""
                )),
                0
            );
            assert_eq!(r.text(), $expected);
        }
    };
}
status_case!(status_false_true, "false | true", "STATUS:0:1 0\n");
status_case!(status_true_false, "true | false", "STATUS:1:0 1\n");
status_case!(status_three, "false | false | true", "STATUS:0:1 1 0\n");
status_case!(
    status_pipefail,
    "set -o pipefail; false | true",
    "STATUS:1:1 0\n"
);
status_case!(
    status_middle,
    "set -o pipefail; true | false | true",
    "STATUS:1:0 1 0\n"
);
status_case!(
    status_subshell,
    "set -o pipefail; (exit 7) | (exit 3) | true",
    "STATUS:3:7 3 0\n"
);
status_case!(status_negated, "! false | true", "STATUS:1:1 0\n");
#[test]
fn early_exit_sigpipe_and_guest_handled_epipe_keep_distinct_statuses() {
    for (name, status) in [("endless", 141), ("handled", 23)] {
        let r = Rig::new();
        assert_eq!(r.run(&format!("set -o pipefail; {name} | take; printf 'STATUS:%s:%s\\n' \"$?\" \"${{PIPESTATUS[*]}}\"")),0);
        assert!(
            r.text()
                .contains(&format!("first\nSTATUS:{status}:{status} 0\n"))
        );
        assert_eq!(r.host.active_count(), 0);
    }
}
#[test]
fn pipeline_inherits_function_unexported_state_cwd_and_redirect() {
    let r = Rig::new();
    assert_eq!(r.run("cd nested; secret=retained; f() { printf '%s\\n' \"$secret:$PWD:$1\"; }; f value | cat > result; cat result"),0);
    assert_eq!(r.text(), "retained:/home/guest/nested:value\n");
}
#[test]
fn slow_reader_applies_exact_byte_backpressure() {
    let r = Rig::new();
    let job = r.start("emit 5242880 | slow-count");
    r.until("READER_WAITING");
    r.ex.drive(1000);
    assert!(!job.is_finished());
    assert!(r.written.get() <= PIPE_CAPACITY);
    r.slow.cancel();
    assert_eq!(r.finish(job), 0);
    assert!(r.text().contains("COUNT:5242880:"));
}
#[test]
fn always_ready_background_loop_cannot_starve_foreground() {
    let r = Rig::new();
    assert_eq!(r.run("while :; do :; done & echo FOREGROUND"), 0);
    assert_eq!(r.text(), "FOREGROUND\n");
    assert_eq!(r.shell.background_jobs(), 1);
    assert_eq!(r.run("kill %1; wait %1"), 143);
    assert_eq!(r.shell.background_jobs(), 0);
}
#[test]
fn foreground_interrupt_leaves_background_alive_and_controllable() {
    let r = Rig::new();
    assert_eq!(r.run("hold & echo BACKGROUND"), 0);
    r.until("HOLDING");
    let job = r.start("hold");
    for _ in 0..100 {
        r.ex.drive(32);
        if r.host.active_count() == 2 {
            break;
        }
    }
    assert_eq!(r.host.active_count(), 2);
    r.shell.interrupt();
    assert_eq!(r.finish(job), 130);
    assert_eq!(r.host.active_count(), 1);
    assert_eq!(r.run("kill %1; wait %1"), 143);
    assert_eq!(r.host.active_count(), 0);
}
#[test]
fn cancelled_function_restores_local_positional_and_export_frames() {
    let r = Rig::new();
    let job =
        r.start("x=outer; f() { local x=inner; export x; export MARK=kept; hold; }; f argument");
    r.until("HOLDING");
    r.shell.interrupt();
    assert_eq!(r.finish(job), 130);
    assert_eq!(
        r.run("printf '%s:%s:%s:%s\\n' \"$x\" \"$#\" \"$1\" \"$MARK\""),
        0
    );
    assert!(r.text().contains("outer:0::kept\n"));
    assert!(!r.shell.state().borrow().exported_bindings().contains("x"));
}
#[test]
fn ordinary_function_shares_state_but_pipeline_subshell_and_background_do_not() {
    let r = Rig::new();
    assert_eq!(r.run("x=old; f() { x=new; }; f; echo $x; x=old; f | cat; echo $x; (f); echo $x; f & wait %1; echo $x"),0);
    assert_eq!(r.text(), "new\nold\nold\nold\n");
}
#[test]
fn arbitrary_inherited_fds_share_open_offset_and_environment() {
    let r = Rig::new();
    assert_eq!(r.run("printf 'fd data' > file; exec 4<file; fdcat 3>&1; secret=private; export EXPORTED=value; cd nested; environment"),0);
    assert_eq!(r.text(), "fd datavalue:false:/home/guest/nested\n");
    assert_eq!(r.run("fdcat 3>&1"), 0);
}
#[test]
fn accumulating_consumer_fails_at_its_explicit_limit() {
    let r = Rig::new();
    assert_eq!(
        r.run("set -o pipefail; emit 2097169 | accumulate; printf '%s\\n' \"${PIPESTATUS[*]}\""),
        0
    );
    assert_eq!(r.text(), "141 1\n");
}
#[test]
fn slow_terminal_backpressures_without_an_accumulated_result_buffer() {
    let r = Rig::new();
    let (reader, writer) = pipe();
    let mut fds = r.fds.clone();
    fds.insert(1, writer);
    r.shell.set_descriptors(fds).unwrap();
    let job = r.shell.start("seq 1 400000").unwrap();
    r.ex.drive(10000);
    assert!(!job.is_finished());
    let mut total = 0;
    let mut buffer = [0; 4096];
    for _ in 0..200000 {
        r.ex.drive(64);
        loop {
            match reader.read(&mut buffer).now_or_never() {
                Some(Ok(0)) => break,
                Some(Ok(n)) => total += n,
                None => break,
                Some(Err(e)) => panic!("{e}"),
            }
        }
        if job.is_finished() {
            break;
        }
    }
    assert!(job.is_finished());
    assert_eq!(job.now_or_never(), Some(0));
    assert_eq!(total, 2688895);
}
#[test]
fn background_wait_does_not_join_itself() {
    let r = Rig::new();
    assert_eq!(r.run("wait & wait"), 0);
    assert_eq!(r.shell.background_jobs(), 0);
}

#[test]
fn isolated_job_builtins_cannot_wait_for_or_kill_parent_jobs() {
    for (script, status) in [
        ("(wait)", 0),
        ("(wait %1)", 127),
        ("(kill %1)", 1),
        ("wait | cat", 0),
        ("wait %1 | cat", 127),
        ("kill %1 | cat", 1),
    ] {
        let r = Rig::new();
        assert_eq!(r.run("set -o pipefail; hold & echo ROOT_READY"), 0);
        r.until("HOLDING");
        assert_eq!(r.run(script), status, "{script}");
        assert_eq!(r.host.active_count(), 1, "{script}");
        assert_eq!(r.shell.background_jobs(), 1, "{script}");
        assert_eq!(r.run("kill %1; wait %1"), 143);
        assert_eq!(r.host.retained_count(), 0);
    }
}

#[test]
fn external_fd_close_delivers_epipe_before_consumer_exit() {
    let r = Rig::new();
    let closed = Cancel::new();
    let producer_done = Cancel::new();
    let consumer_exited = Rc::new(Cell::new(false));
    let epipe_before_exit = Rc::new(Cell::new(false));
    let closed_gate = closed.clone();
    let done_gate = producer_done.clone();
    let exited = consumer_exited.clone();
    r.host
        .register("/home/guest/close-input", move |mut req, _cancel| {
            let closed = closed_gate.clone();
            let done = done_gate.clone();
            let exited = exited.clone();
            async move {
                drop(req.fds.remove(0).unwrap());
                closed.cancel();
                // The consumer cannot exit to release an accidentally retained fd.
                // Only the producer completing its write can release this latch.
                done.cancelled().await;
                exited.set(true);
                0
            }
            .boxed_local()
        });
    let producer_exited = consumer_exited.clone();
    let producer_observed = epipe_before_exit.clone();
    r.host
        .register("/home/guest/write-after-close", move |req, cancel| {
            let closed = closed.clone();
            let done = producer_done.clone();
            let exited = producer_exited.clone();
            let observed = producer_observed.clone();
            async move {
                closed.cancelled().await;
                let result = req
                    .fds
                    .get(1)
                    .unwrap()
                    .write_all(&vec![b'x'; PIPE_CAPACITY * 2], &cancel)
                    .await;
                observed.set(result == Err(IoError::BrokenPipe) && !exited.get());
                done.cancel();
                match result {
                    Ok(()) => 0,
                    Err(error) => error.status(),
                }
            }
            .boxed_local()
        });
    // Keep observer handles outside the registry callbacks.
    let observed = epipe_before_exit.clone();
    let exited = consumer_exited.clone();
    assert_eq!(
        r.run("write-after-close | close-input; printf '%s\\n' \"${PIPESTATUS[*]}\""),
        0
    );
    assert!(observed.get(), "producer did not observe EPIPE before exit");
    assert!(exited.get());
    assert_eq!(r.text(), "141 0\n");
    assert_eq!(r.host.retained_count(), 0);
}

#[test]
fn command_byte_limit_includes_prefix_and_assignment_only_values() {
    for script in [
        "A=$VALUE B=$VALUE",
        "A=$VALUE okay xyz",
        "A=12345678 echo abcde",
    ] {
        let r = Rig::with_limits(Limits {
            expansion_bytes: 16,
            ..Limits::default()
        });
        r.shell
            .state()
            .borrow_mut()
            .assign_parameter("VALUE".into(), "123456789".into())
            .unwrap();
        assert_eq!(r.run(script), 2, "{script}");
        assert!(!r.shell.state().borrow().bindings().contains_key("A"));
        assert!(r.output.is_empty());
        assert_eq!(r.host.retained_count(), 0);
    }
    let r = Rig::with_limits(Limits {
        expansion_bytes: 16,
        ..Limits::default()
    });
    assert_eq!(r.run("A=1234 B=5678"), 0);
    assert_eq!(r.run("C=1234 okay"), 0);
    assert_eq!(
        r.shell.state().borrow().bindings().get("A").unwrap(),
        "1234"
    );
}

#[test]
fn command_word_limit_includes_prefix_and_assignment_only_values() {
    for script in ["A=x okay arg", "A=x B=y okay", "A=x B=y C=z"] {
        let r = Rig::with_limits(Limits {
            arguments: 2,
            ..Limits::default()
        });
        assert_eq!(r.run(script), 2, "{script}");
        assert!(!r.shell.state().borrow().bindings().contains_key("A"));
    }
    let r = Rig::with_limits(Limits {
        arguments: 2,
        ..Limits::default()
    });
    assert_eq!(r.run("A=x B=y"), 0);
    assert_eq!(r.run("C=z okay"), 0);
    assert_eq!(r.run("true arg"), 0);
}

#[test]
fn sessions_sharing_a_host_have_independent_first_process_groups() {
    let r = Rig::new();
    let other = Session::new(
        r.ex.clone(),
        Rc::new(r.host.clone()),
        Rc::new(r.fs.clone()),
        Limits::default(),
    );
    other.set_descriptors(r.fds.clone()).unwrap();
    r.host.register("/home/guest/other-hold", |req, cancel| {
        async move {
            req.fds
                .get(1)
                .unwrap()
                .write_all(b"OTHER_HOLDING\n", &cancel)
                .await
                .unwrap();
            futures::future::pending().await
        }
        .boxed_local()
    });
    let first_job = r.start("hold");
    r.until("HOLDING");
    let other_job = other.start("other-hold").unwrap();
    r.until("OTHER_HOLDING");
    assert_eq!(r.host.active_count(), 2);
    r.shell.interrupt();
    let first_status = r.finish(first_job);
    r.ex.drive(256);
    let unrelated_survived = !other_job.is_finished() && r.host.active_count() == 1;
    // Clean both sessions even if a group collision killed the wrong child.
    other.interrupt();
    let other_status = r.finish(other_job);
    let shutdown = r.ex.spawn(async move {
        other.shutdown().await;
        0
    });
    assert_eq!(r.finish(shutdown), 0);
    assert_eq!(first_status, 130);
    assert!(unrelated_survived, "interrupt crossed the session boundary");
    assert_eq!(other_status, 130);
    assert_eq!(r.host.retained_count(), 0);
}

#[test]
fn isolated_foreground_interrupt_reaps_its_background_but_not_roots() {
    let r = Rig::new();
    assert_eq!(r.run("hold & echo ROOT_READY"), 0);
    r.until("HOLDING");
    let job = r.start("(hold & while :; do :; done)");
    for _ in 0..1000 {
        r.ex.drive(64);
        if r.host.active_count() == 2 {
            break;
        }
    }
    assert_eq!(r.host.active_count(), 2);
    r.shell.interrupt();
    assert_eq!(r.finish(job), 130);
    assert_eq!(r.host.active_count(), 1);
    assert_eq!(r.host.retained_count(), 1);
    assert_eq!(r.shell.background_jobs(), 1);
    assert_eq!(r.run("kill %1; wait %1"), 143);
    assert_eq!(r.host.active_count(), 0);
    assert_eq!(r.host.retained_count(), 0);
}

#[test]
fn interrupt_after_ast_completion_reaps_lingering_group_descendant() {
    let r = Rig::new();
    // Avoid making the registry own its own host through a strong Rc cycle.
    let host = Rc::new(r.host.clone());
    let weak_host = Rc::downgrade(&host);
    let descendant = Rc::new(Cell::new(None));
    let spawned = descendant.clone();
    r.host
        .register("/home/guest/leave-descendant", move |mut req, _cancel| {
            let host = weak_host.upgrade().unwrap();
            let spawned = spawned.clone();
            async move {
                req.executable = "/home/guest/hold".into();
                req.argv = vec!["hold".into()];
                // The host boundary supplies the process group, not the caller pid.
                // Membership must keep this process under the foreground lifetime.
                spawned.set(Some(host.spawn(req).unwrap()));
                0
            }
            .boxed_local()
        });
    let job = r.start("leave-descendant; echo AST_DONE");
    r.until("AST_DONE");
    r.until("HOLDING");
    let drive = r.ex.drive(256);
    assert!(!drive.runnable, "shell has not parked in group completion");
    assert!(!job.is_finished());
    assert!(descendant.get().is_some());
    assert_eq!(r.host.active_count(), 1);
    assert_eq!(r.host.retained_count(), 1);
    r.shell.interrupt();
    assert_eq!(r.finish(job), 130);
    assert_eq!(r.host.active_count(), 0);
    assert_eq!(r.host.retained_count(), 0);
}

#[test]
fn local_restores_export_state_at_declaration_not_function_entry() {
    let r = Rig::new();
    assert_eq!(r.run("f() { export X=outer; local X=inner; }; f"), 0);
    assert_eq!(
        r.shell.state().borrow().bindings().get("X").unwrap(),
        "outer"
    );
    assert!(r.shell.state().borrow().exported_bindings().contains("X"));
}

#[test]
fn negated_single_command_preserves_exec_descriptor_changes() {
    let r = Rig::new();
    assert_eq!(r.run("! exec >log; echo hello"), 0);
    assert!(r.output.is_empty());
    assert_eq!(r.fs.read_file("/home/guest/log").unwrap(), b"hello\n");
}

#[test]
fn successful_background_launch_sets_status_to_zero() {
    let r = Rig::new();
    assert_eq!(r.run("false; true & printf '%s\\n' \"$?\""), 0);
    assert_eq!(r.text(), "0\n");
    assert_eq!(r.run("wait"), 0);
}

#[test]
fn assignment_values_expand_against_prior_assignments_in_the_same_command() {
    let r = Rig::new();
    assert_eq!(
        r.run("a=before; a=after b=$a; printf '%s:%s\\n' \"$a\" \"$b\""),
        0
    );
    assert_eq!(r.text(), "after:after\n");
}

#[test]
fn command_byte_limit_counts_assignment_names_and_accepts_exact_boundary() {
    for script in ["A=1234 okay", "A=1234 B=12", "LONGNAME=x"] {
        for (limit, status) in [(9, 2), (10, 0)] {
            let r = Rig::with_limits(Limits {
                expansion_bytes: limit,
                ..Limits::default()
            });
            assert_eq!(r.run(script), status, "limit={limit}: {script}");
        }
    }
}

#[test]
fn rejected_pipeline_and_background_publish_failure_status() {
    let r = Rig::with_limits(Limits {
        pipeline_stages: 1,
        ..Limits::default()
    });
    assert_eq!(
        r.run("true; false | true; printf '%s:%s\\n' \"$?\" \"${PIPESTATUS[*]}\""),
        0
    );
    assert_eq!(r.text(), "2:2\n");
    let r = Rig::with_limits(Limits {
        jobs: 0,
        ..Limits::default()
    });
    assert_eq!(
        r.run("true; true & printf '%s:%s\\n' \"$?\" \"${PIPESTATUS[*]}\""),
        0
    );
    assert_eq!(r.text(), "2:2\n");
}

// Acceptance-only utility ports: these tests exercise the engine descriptor
