//! Original function and dynamic-scope controls against GNU Bash 5.3.
use super::*;

#[test]
fn bare_local_is_unset_and_redeclaration_keeps_current_value() {
    check_output(
        r#"x=global; f() { local x missing; printf '<%s:%s><%s>\n' "${x+x}" "$x" "${missing+x}"; x=inside; local x; printf '%s\n' "$x"; }; f; printf '%s\n' "$x""#,
        "<:><>\ninside\nglobal\n",
    );
}

#[test]
fn function_prefixes_are_dynamic_exported_bindings_and_restore_caller() {
    let rig = Rig::new(Limits::default());
    rig.host.register("/home/guest/environment", |req, _| {
        async move {
            let value = req.env.get("x").map(String::as_str).unwrap_or("unset");
            req.fds
                .get(1)
                .unwrap()
                .write_all(value.as_bytes(), &shell_engine::executor::Cancel::new())
                .await
                .unwrap();
            0
        }
        .boxed_local()
    });
    assert_eq!(rig.run(r#"x=global; g() { printf '<%s>' "$x"; x=changed; environment; }; f() { g; local x; printf '<%s>' "$x"; }; x=temporary f; printf '<%s>\n' "$x"; environment"#), 0);
    assert_eq!(
        rig.output.bytes(),
        b"<temporary>changed<changed><global>\nunset"
    );
}

#[test]
fn function_prefix_unset_reveals_caller_and_local_stays_unset() {
    check_output(
        r#"x=global; f() { unset x; printf '<%s>' "${x-unset}"; }; x=temporary f; printf '<%s>\n' "$x"; f() { local x; unset x; printf '<%s>' "${x-unset}"; }; x=temporary f; printf '<%s>\n' "$x""#,
        "<global><global>\n<unset><global>\n",
    );
}

#[test]
fn shift_changes_only_current_positional_frame_and_failures_are_atomic() {
    check_output(
        r#"set -- outer tail; f() { printf '<%s:%s>' "$#" "$1"; shift; printf '<%s:%s>' "$#" "$1"; shift 0; shift 3; printf '<%s:%s:%s>' "$?" "$#" "$1"; shift -1; printf '<%s:%s>' "$?" "$1"; shift nope; printf '<%s:%s>' "$?" "$1"; set -- reset; printf '<%s>' "$1"; }; f first second; printf '<%s:%s>\n' "$#" "$1""#,
        "<2:first><1:second><1:1:second><1:second><2:second><reset><2:outer>\n",
    );
}

#[test]
fn return_accepts_signed_shell_integers_without_unwinding_caller() {
    check_output(
        r#"f() { return +257; echo bad; }; f; echo "$?"; f() { return -9223372036854775808; }; f; echo "$?"; f() { false; return; }; f; echo "$?"; return 3; echo "$?""#,
        "1\n0\n1\n2\n",
    );
}

#[test]
fn ordinary_functions_share_state_while_fork_forms_isolate() {
    check_output(
        r#"x=global; g() { printf '<%s>' "$x"; x=changed; }; f() { local x=local; g; printf '<%s>' "$x"; shared=yes; }; f; printf '<%s:%s>\n' "$x" "$shared"; (g); printf '<%s>' "$x"; g | cat; printf '<%s>' "$x"; g & wait; printf '<%s>\n' "$x""#,
        "<local><changed><global:yes>\n<global><global><global><global><global><global>\n",
    );
}

#[test]
fn default_functions_really_execute_512_nested_calls_with_completed_evals() {
    for increment in ["n=$((n+1))", "eval 'n=$((n+1))'"] {
        let rig = Rig::new(Limits::default());
        assert_eq!(rig.run(&format!("n=0; seen=0; unwound=0; f() {{ local saved=$1; {increment}; seen=$((seen+1)); case $n in 512) printf '%s:%s\\n' \"$n\" \"$saved\";; *) f inner;; esac; unwound=$((unwound+1)); }}; f outer")), 0);
        assert_eq!(rig.output.bytes(), b"512:inner\n");
        for counter in ["n", "seen", "unwound"] {
            assert_eq!(
                rig.shell.state().borrow().variables[counter],
                "512",
                "{counter}"
            );
        }
        assert_eq!(rig.run(r#"printf '<%s:%s>\n' "${saved-unset}" "$#""#), 0);
        assert_eq!(rig.output.bytes(), b"512:inner\n<unset:0>\n");
        assert_eq!(rig.ex.drive(64).pending, 0);
    }
}

#[test]
fn lastpipe_only_shares_the_final_stage_with_job_control_disabled() {
    check_output(
        r#"x=global; f() { x=$1; set -- function; }; : | f isolated; printf '<%s:%s>' "$x" "$#"; shopt -s lastpipe; : | f shared; printf '<%s:%s:%s>' "$x" "$#" "$1"; set -m; : | f isolated; printf '<%s>' "$x"; set +m; f left | :; printf '<%s>' "$x"; f() { : | return 7; echo bad; }; f; printf '<%s>\n' "$?""#,
        "<global:0><shared:0:><shared><shared><7>\n",
    );
}

#[test]
fn funcnest_accepts_bash_integer_spellings_and_recovers_after_unwind() {
    for value in ["2", "+2", "02", " 2 "] {
        let rig = Rig::new(Limits::default());
        rig.variable("FUNCNEST", value);
        assert_eq!(
            rig.run("n=0; f() { local x=inner; n=$((n+1)); f; }; f; args bad"),
            1,
            "{value}"
        );
        assert_eq!(rig.shell.state().borrow().variables["n"], "2");
        assert!(
            String::from_utf8(rig.errors.bytes())
                .unwrap()
                .contains("maximum function nesting")
        );
        assert!(rig.calls.borrow().is_empty());
        assert!(!rig.shell.exit_requested());
        assert_eq!(rig.run(r#"args "${x-unset}" "$#""#), 0);
        assert_eq!(*rig.calls.borrow(), [vec!["unset", "0"]]);
        assert_eq!(rig.ex.drive(64).pending, 0);
    }
    for value in ["0", "-1", "bad"] {
        let rig = Rig::new(Limits::default());
        rig.variable("FUNCNEST", value);
        assert_eq!(
            rig.run("n=0; f() { n=$((n+1)); if test $n -lt 4; then f; fi; }; f"),
            0
        );
        assert_eq!(rig.shell.state().borrow().variables["n"], "4");
    }
}

#[test]
fn return_errors_and_option_sentinels_have_bash_control_flow() {
    check_output(
        r#"return bad; echo "$?"; f() { return bad; echo bad; }; f; echo "$?"; f() { return -- 7; }; f; echo "$?"; set -- a b; shift --; printf '%s:%s\n' "$#" "$1""#,
        "2\n2\n7\n1:b\n",
    );
    for source in [
        "f() { return 7 8; echo bad; }; f; echo bad",
        "f() { shift 1 2; echo bad; }; f; echo bad",
    ] {
        let rig = Rig::new(Limits::default());
        assert_eq!(rig.run(source), 1);
        assert!(rig.output.bytes().is_empty());
        assert!(rig.shell.exit_requested());
    }
}

#[test]
fn local_attributes_restore_and_readonly_prefix_still_calls_function() {
    check_output(
        r#"x=outer; f() { local -rx x=inner; printf '%s\n' "$x"; }; f; x=changed; printf '%s\n' "$x"; readonly x=locked; f() { printf 'called\n'; }; x=temporary f; printf '%s:%s\n' "$?" "$x""#,
        "inner\nchanged\ncalled\n0:locked\n",
    );
    check_output(r#"f() { local 'bad-name=1'; echo "$?"; }; f"#, "1\n");
}

fn park(rig: &Rig, name: &str) -> shell_engine::executor::Cancel {
    let release = shell_engine::executor::Cancel::new();
    let gate = release.clone();
    rig.host
        .register(format!("/home/guest/{name}"), move |_, cancel| {
            let gate = gate.clone();
            async move {
                if cancel.run(gate.cancelled()).await.is_ok() {
                    0
                } else {
                    130
                }
            }
            .boxed_local()
        });
    release
}

fn drive_active(rig: &Rig, count: usize) {
    for _ in 0..10_000 {
        rig.ex.drive(64);
        if rig.host.active_count() == count {
            return;
        }
    }
    panic!(
        "expected {count} active parked host calls, saw {}",
        rig.host.active_count()
    );
}

#[test]
fn cancelled_nested_prefix_local_and_positional_frames_leave_background_peer_alive() {
    for drop_observer in [false, true] {
        let rig = Rig::new(Limits::default());
        let peer = park(&rig, "park_peer");
        let _foreground = park(&rig, "park_foreground");
        assert_eq!(rig.run("peer() { local x=peer; set -- peer; park_peer; args peer \"$x\" \"$1\"; }; peer & peer_job=$!"), 0);
        let job = rig.shell.start("x=caller; set -- caller; n=0; f() { local x=$1; n=$((n+1)); case $n in 32) park_foreground;; *) x=prefix f nested;; esac; }; x=prefix f outer").unwrap();
        drive_active(&rig, 2);
        assert_eq!(rig.shell.state().borrow().variables["n"], "32");
        let observed = if drop_observer {
            drop(job);
            None
        } else {
            Some(job)
        };
        rig.shell.interrupt();
        if let Some(job) = observed {
            assert_eq!(rig.finish(job), 130);
        }
        for _ in 0..10_000 {
            rig.ex.drive(64);
            if rig.host.active_count() == 1 {
                break;
            }
        }
        assert_eq!(
            rig.host.active_count(),
            1,
            "peer must outlive foreground cancellation"
        );
        assert_eq!(rig.run(r#"args recovered "$x" "$1" "$#""#), 0);
        assert_eq!(
            *rig.calls.borrow(),
            [vec!["recovered", "caller", "caller", "1"]]
        );
        peer.cancel();
        assert_eq!(rig.run(r#"wait "$peer_job""#), 0);
        assert_eq!(
            *rig.calls.borrow(),
            [
                vec!["recovered", "caller", "caller", "1"],
                vec!["peer", "peer", "peer"]
            ]
        );
        assert_eq!(rig.ex.drive(64).pending, 0);
    }
}

#[test]
fn dropping_session_with_parked_nested_calls_unwinds_before_join_completion() {
    let ex = Executor::new();
    let host = InProcessHost::new(ex.clone());
    host.register("/home/guest/park_foreground", |_, cancel| {
        async move {
            cancel.cancelled().await;
            130
        }
        .boxed_local()
    });
    let shell = Session::new(
        ex.clone(),
        Rc::new(host.clone()),
        Rc::new(MemoryFs::new(1024)),
        Limits::default(),
    );
    let state = shell.state();
    let job = shell.start("x=caller; set -- caller; f() { local x=inner; g child; }; g() { local y=inner; park_foreground; }; x=prefix f outer").unwrap();
    for _ in 0..10_000 {
        ex.drive(64);
        if host.active_count() == 1 {
            break;
        }
    }
    assert_eq!(host.active_count(), 1);
    drop(shell);
    for _ in 0..10_000 {
        ex.drive(64);
        if job.is_finished() {
            break;
        }
    }
    assert_eq!(job.now_or_never(), Some(130));
    assert_eq!(state.borrow().variables["x"], "caller");
    assert!(!state.borrow().variables.contains_key("y"));
    assert_eq!(ex.drive(64).pending, 0);
    assert_eq!(host.active_count(), 0);
    assert_eq!(host.retained_count(), 0);
}

#[test]
fn live_memory_exhaustion_is_explicit_and_refunds_frames_for_recovery() {
    let rig = Rig::new(Limits {
        execution_bytes: 256 * 1024,
        ..Limits::default()
    });
    assert_eq!(rig.run("x=caller; set -- caller; n=0; f() { local x=inner; n=$((n+1)); f child; }; f outer; args bad"), 2);
    let depth: usize = rig.shell.state().borrow().variables["n"].parse().unwrap();
    assert!(
        depth > 1 && depth < 512,
        "actual memory-limited depth {depth}"
    );
    assert!(
        String::from_utf8(rig.errors.bytes())
            .unwrap()
            .contains("memory limit exceeded")
    );
    assert!(rig.calls.borrow().is_empty());
    assert_eq!(
        rig.run(r#"args recovered "$x" "$1"; f() { local x=small; :; }; f"#),
        0
    );
    assert_eq!(*rig.calls.borrow(), [vec!["recovered", "caller", "caller"]]);
    assert_eq!(rig.ex.drive(64).pending, 0);
}

#[test]
fn command_bypasses_functions_reports_names_and_retains_external_prefixes_and_status() {
    check_output(
        r#"printf() { echo shadow; }; printf; command printf '%s\n' builtin; command command echo nested; command -v printf if fn_missing; echo "$?"; command -V printf if; command -v fn_missing; echo "$?"; command --; command -p echo default; command -x echo no; echo "$?""#,
        "shadow\nbuiltin\nnested\nprintf\nif\n0\nprintf is a function\nprintf () \n{ \n    echo shadow\n}\nif is a shell keyword\n1\ndefault\n2\n",
    );
    let rig = Rig::new(Limits::default());
    let observed = Rc::new(RefCell::new(Vec::new()));
    let seen = observed.clone();
    rig.host
        .register("/home/guest/external", move |request, _| {
            seen.borrow_mut().push((request.argv, request.env));
            async { 37 }.boxed_local()
        });
    assert_eq!(
        rig.run("external() { echo bad; }; x=temporary command external one two"),
        37
    );
    assert!(rig.output.bytes().is_empty());
    assert_eq!(
        observed.borrow()[0].0,
        ["/home/guest/external", "one", "two"]
    );
    assert_eq!(
        observed.borrow()[0].1.get("x").map(String::as_str),
        Some("temporary")
    );
    assert_eq!(rig.run("command missing_external"), 127);
    assert_eq!(rig.run("command -v missing_external"), 1);
    assert_eq!(rig.run("command -v; command -V; command"), 0);
}

#[test]
fn command_query_last_option_wins_and_function_shadow_of_command_is_ordinary() {
    check_output(
        r#"f() { :; }; command -Vv f printf; command -v -V printf; command() { echo shadow; }; command; command command echo still-shadow"#,
        "f\nprintf\nprintf is a shell builtin\nshadow\nshadow\n",
    );
}

#[test]
fn command_path_queries_use_executable_metadata_without_running_programs() {
    use shell_engine::io::{FileKind, FileMetadata, FileSystem, IoError, OpenOptions};
    struct ExecutableFs(MemoryFs);
    impl FileSystem for ExecutableFs {
        fn stat<'a>(
            &'a self,
            path: &'a str,
            _: bool,
        ) -> futures::future::LocalBoxFuture<'a, Result<FileMetadata, IoError>> {
            async move {
                if !matches!(
                    path,
                    "/custom/tool" | "/usr/bin/tool" | "/home/guest/relative"
                ) {
                    return Err(IoError::NotFound);
                }
                let mut metadata = self.0.stat("/", true)?;
                metadata.kind = FileKind::Regular;
                metadata.executable = Some(true);
                Ok(metadata)
            }
            .boxed_local()
        }
        fn mkdir<'a>(
            &'a self,
            path: &'a str,
            parents: bool,
        ) -> futures::future::LocalBoxFuture<'a, Result<(), IoError>> {
            FileSystem::mkdir(&self.0, path, parents)
        }
        fn open<'a>(
            &'a self,
            path: &'a str,
            options: &'a OpenOptions,
        ) -> futures::future::LocalBoxFuture<'a, Result<Endpoint, IoError>> {
            FileSystem::open(&self.0, path, options)
        }
    }
    let ex = Executor::new();
    let host = InProcessHost::new(ex.clone());
    let invocations = Rc::new(RefCell::new(Vec::new()));
    let seen = invocations.clone();
    host.register("/usr/bin/tool", move |request, _| {
        seen.borrow_mut().push((request.argv, request.env));
        async { 126 }.boxed_local()
    });
    for path in ["/custom/tool", "/usr/bin/tool", "./relative"] {
        host.register_access(path, "/home/guest", Ok(()));
    }
    let session = Session::new(
        ex.clone(),
        Rc::new(host.clone()),
        Rc::new(ExecutableFs(MemoryFs::new(1024))),
        Limits::default(),
    );
    let (out, output) = capture(4096);
    let mut fds = FdTable::default();
    fds.insert(1, out);
    session.set_descriptors(fds).unwrap();
    let finish = |job: JoinHandle<i32>| {
        for _ in 0..10_000 {
            ex.drive(64);
            if job.is_finished() {
                break;
            }
        }
        job.now_or_never().unwrap()
    };
    assert_eq!(finish(session.start("PATH=/custom; command -v tool; command -V tool; command -p -v tool; command -v ./relative; command -v /missing").unwrap()), 1);
    assert_eq!(
        output.bytes(),
        b"/custom/tool\ntool is /custom/tool\n/usr/bin/tool\n./relative\n"
    );
    assert!(
        invocations.borrow().is_empty(),
        "queries must not execute probes"
    );
    assert_eq!(
        finish(session.start("x=temporary command -p tool arg").unwrap()),
        126
    );
    assert_eq!(invocations.borrow()[0].0, ["/usr/bin/tool", "arg"]);
    assert_eq!(
        invocations.borrow()[0].1.get("x").map(String::as_str),
        Some("temporary")
    );
    assert_eq!(session.state().borrow().variables["PATH"], "/custom");
    assert!(!session.state().borrow().variables.contains_key("x"));
    assert_eq!(host.retained_count(), 0);
    assert_eq!(ex.drive(64).pending, 0);
}

#[test]
fn command_flow_control_keeps_the_current_function_positional_and_local_frames() {
    check_output(
        r#"x=global; set -- caller; f() { command local x=local; command shift; printf '%s:%s:%s\n' "$x" "$#" "$1"; command return 7; echo bad; }; f first second; printf '%s:%s:%s\n' "$?" "$x" "$1"; command -Vv printf; command -v -V printf"#,
        "local:1:second\n7:global:caller\nprintf\nprintf is a shell builtin\n",
    );
}

#[test]
fn return_and_shift_numeric_errors_take_priority_over_excess_operands() {
    check_output(
        r#"f() { return bad extra; echo bad; }; f; echo "$?"; f() { shift bad extra; echo "$?"; }; f; echo "$?"; echo caller"#,
        "2\n2\n0\ncaller\n",
    );
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("f() { shift -1 extra; echo bad; }; f; echo bad"), 1);
    assert!(rig.output.bytes().is_empty());
}

#[test]
fn command_function_reporting_admits_small_buffers_and_refuses_large_ones_before_allocation() {
    let rig = Rig::new(Limits {
        execution_bytes: 64 * 1024,
        ..Limits::default()
    });
    assert_eq!(rig.run("f() { :; }; command -V f"), 0);
    assert_eq!(
        rig.output.bytes(),
        b"f is a function\nf () \n{ \n    :\n}\n"
    );
    assert_eq!(
        rig.run(&format!(
            "large() {{ echo '{}'; }}; command -V large",
            "x".repeat(100 * 1024)
        )),
        2
    );
    assert!(
        String::from_utf8(rig.errors.bytes())
            .unwrap()
            .contains("function description exceeds memory")
    );
    assert_eq!(
        rig.run("command -V f"),
        0,
        "failed print refunds admission for later small queries"
    );
    assert_eq!(rig.ex.drive(64).pending, 0);
}

#[test]
fn function_prefix_funcnest_controls_entry_and_body_changes_control_later_calls() {
    check_output(
        r#"FUNCNEST=1; n=0; f() { n=$((n+1)); printf '%s:%s\n' "$n" "$FUNCNEST"; case $n in 1) FUNCNEST=2 f;; esac; }; f; printf 'done:%s:%s\n' "$n" "$FUNCNEST""#,
        "1:1\n2:2\ndone:2:1\n",
    );
    for nested in ["FUNCNEST=1 f", "FUNCNEST=1; f"] {
        let rig = Rig::new(Limits::default());
        assert_eq!(
            rig.run(&format!(
                "n=0; f() {{ n=$((n+1)); {nested}; }}; f; args bad"
            )),
            1
        );
        assert_eq!(rig.shell.state().borrow().variables["n"], "1");
        assert!(rig.calls.borrow().is_empty());
        assert_eq!(rig.run("printf recovered"), 0);
    }
}
