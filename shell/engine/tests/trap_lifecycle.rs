//! Frozen lifecycle witnesses and explicit owner-contract causal checks.
//! No host Bash, new recording, fixture identity or baseline change is involved.
use std::{
    process::{Child, Command, Output, Stdio},
    thread::sleep,
    time::{Duration, Instant},
};

struct OwnedChild(Option<Child>);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        let Some(mut child) = self.0.take() else {
            return;
        };
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn run(source: &str) -> Output {
    let child = Command::new(env!("CARGO_BIN_EXE_shell-engine"))
        .args(["-c", source])
        .env_clear()
        .env("LC_ALL", "C.UTF-8")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut owned = OwnedChild(Some(child));
    let deadline = Instant::now() + Duration::from_secs(5);
    while owned.0.as_mut().unwrap().try_wait().unwrap().is_none() {
        assert!(
            Instant::now() < deadline,
            "lifecycle case exceeded five seconds"
        );
        sleep(Duration::from_millis(5));
    }
    owned.0.take().unwrap().wait_with_output().unwrap()
}

fn check(id: &str, source: &str, status: i32, stdout: &str) {
    let output = run(source);
    assert_eq!(output.status.code(), Some(status), "{id} status");
    assert_eq!(output.stdout, stdout.as_bytes(), "{id} stdout");
    assert!(output.stderr.is_empty(), "{id} stderr: {:?}", output.stderr);
}

#[test]
fn exit_at_actual_cli_eof() {
    check(
        "oils:builtin-trap:51",
        r#"trap -- 'echo hi' EXIT
echo ok
"#,
        0,
        r#"ok
hi
"#,
    );
}

#[test]
fn explicit_exit_preserves_trigger_status() {
    check(
        "oils:builtin-trap:395",
        r#"trap 'echo IN TRAP; echo $stdout' EXIT 
stdout=FOO
exit 42

"#,
        42,
        r#"IN TRAP
FOO
"#,
    );
}

#[test]
fn inherited_child_exit_is_query_only() {
    check(
        "brush-suite:builtins/trap:27",
        r#"trap 'echo "[exit]"' EXIT
trap -p EXIT
echo "---"
(trap -p EXIT)
"#,
        0,
        r#"trap -- 'echo "[exit]"' EXIT
---
trap -- 'echo "[exit]"' EXIT
[exit]
"#,
    );
}

#[test]
fn child_installed_exit_runs_at_child_completion() {
    check(
        "brush-suite:builtins/trap:30",
        r#"trap 'echo "[parent exit]"' EXIT
echo "parent"
(trap 'echo "[subshell exit]"' EXIT; echo "subshell")
echo "back in parent"
"#,
        0,
        r#"parent
subshell
[subshell exit]
back in parent
[parent exit]
"#,
    );
}

#[test]
fn capture_queries_inherited_exit_without_running_it() {
    check(
        "brush-suite:builtins/trap:35",
        r#"trap 'echo "[parent exit]"' EXIT
result=$(trap -p EXIT; echo "inside")
echo "result: $result"
"#,
        0,
        r#"result: trap -- 'echo "[parent exit]"' EXIT
inside
[parent exit]
"#,
    );
}

#[test]
fn capture_includes_child_installed_exit_before_eof() {
    check(
        "brush-suite:builtins/trap:36",
        r#"trap 'echo "[parent exit]"' EXIT
result=$(trap 'echo "[sub exit]"' EXIT; echo "inside")
echo "result: $result"
"#,
        0,
        r#"result: inside
[sub exit]
[parent exit]
"#,
    );
}

// Owner lifecycle invariants are causal checks, not new frozen oracle rows.
fn check_causal(id: &str, source: &str, status: i32, stdout: &str) {
    check(id, source, status, stdout);
}

#[test]
fn background_child_installed_exit_runs_before_wait_completion() {
    check_causal(
        "owner contract: late background EXIT",
        r#"{ trap 'printf "bg-exit\n"' EXIT; printf 'bg-body\n'; } & wait
"#,
        0,
        "bg-body\nbg-exit\n",
    );
}

#[test]
fn capture_background_child_installed_exit_runs_before_capture_eof() {
    check_causal(
        "owner contract: late capture background EXIT",
        r#"result=$( { trap 'printf "cap-exit\n"' EXIT; printf 'cap-body\n'; } & wait ); printf 'capture=<%s>\n' "$result"
"#,
        0,
        "capture=<cap-body\ncap-exit>\n",
    );
}

#[test]
fn isolated_pipeline_errexit_does_not_abort_parent_with_errexit_off() {
    check_causal(
        "owner invariant: isolated pipeline errexit",
        r#"set +e; true | { set -e; false; printf 'BAD\n'; }; printf 'after\n'
"#,
        0,
        "after\n",
    );
}

#[test]
fn background_exit_uses_effective_compound_and_function_redirects() {
    check_causal(
        "owner contract: redirected background EXIT",
        r#"f() { trap 'printf "function-exit\n"' EXIT; }
value=$( { trap 'printf "brace-exit\n"' EXIT; :; } >/brace-exit & f >/function-exit & wait )
read -r brace </brace-exit
read -r function </function-exit
printf '<%s>:%s:%s\n' "$value" "$brace" "$function"
"#,
        0,
        "<>:brace-exit:function-exit\n",
    );
}

#[test]
fn isolated_pipeline_status_obeys_parent_errexit_and_negation() {
    check_causal(
        "owner invariant: parent pipeline failure policy",
        r#"set -e; ! true | { set -e; false; }; printf 'negated\n'; true | { set -e; false; }; printf 'BAD\n'
"#,
        1,
        "negated\n",
    );
}

#[test]
fn background_inherited_exit_does_not_duplicate_parent() {
    check(
        "brush-suite:builtins/trap:47",
        r#"trap 'echo "[exit]"' EXIT
{ trap -p EXIT; echo "bg job"; } &
wait
echo "main continues"
"#,
        0,
        r#"trap -- 'echo "[exit]"' EXIT
bg job
main continues
[exit]
"#,
    );
}

#[test]
fn untraced_function_has_no_parent_return_event() {
    check(
        "brush-suite:builtins/trap:52",
        r#"trap 'echo "[return]"' RETURN
myfunc() {
  echo "in func"
}
myfunc
echo "after func"
"#,
        0,
        r#"in func
after func
"#,
    );
}

#[test]
fn traced_nested_returns_see_live_function_frames() {
    check(
        "brush-suite:builtins/trap:56",
        r#"set -T
trap 'echo "[return: ${FUNCNAME[0]:-main}]"' RETURN
outer() {
  inner() {
    echo "in inner"
  }
  inner
  echo "after inner"
}
outer
echo "done"
"#,
        0,
        r#"in inner
[return: inner]
after inner
[return: outer]
done
"#,
    );
}

#[test]
fn ordinary_commands_are_not_return_boundaries() {
    check(
        "brush-suite:builtins/trap:58",
        r#"trap 'echo "[return]"' RETURN
echo "cmd1"
echo "cmd2"
true
echo "done"
"#,
        0,
        r#"cmd1
cmd2
done
"#,
    );
}

#[test]
fn exit_inside_exit_handler_transfers_once() {
    check(
        "brush-suite:builtins/trap:82",
        r#"trap 'exit 0' EXIT
exit 99
"#,
        0,
        r#""#,
    );
}

#[test]
fn pipeline_debug_runs_in_parent_before_each_stage() {
    check(
        "brush-suite:builtins/trap:91",
        r#"trap 'echo "debug: $BASH_COMMAND"' DEBUG
true | false
echo done
trap - DEBUG
"#,
        0,
        r#"debug: true
debug: false
debug: echo done
done
debug: trap - DEBUG
"#,
    );
}

#[test]
fn err_runs_with_errexit_off_at_function_call_boundary() {
    check(
        "bashkit-suite:bashbox-err-trap:13",
        r#"trap 'echo err' ERR; f(){ g; }; g(){ false; }; f; echo end
"#,
        0,
        r#"err
end
"#,
    );
}

#[test]
fn conditional_function_calls_suppress_err_with_errexit_off() {
    check(
        "bashkit-suite:bashbox-err-trap:73",
        r#"trap 'echo err' ERR; f(){ false; echo in; }; f || true; f && true; ! f; if f; then :; fi; echo end
"#,
        0,
        r#"in
in
in
in
end
"#,
    );
}

#[test]
fn err_runs_in_unsuppressed_compound_bodies() {
    check(
        "bashkit-suite:bashbox-err-trap:92",
        r#"trap 'echo err' ERR; { false; }; if true; then false; fi; for i in 1; do false; done; case x in x) false;; esac; echo end
"#,
        0,
        r#"err
err
err
err
end
"#,
    );
}

#[test]
fn function_err_scope_merges_without_losing_parent_handler() {
    check(
        "bashkit-suite:trap-scope:81",
        r#"trap 'echo A' ERR
f() { trap - ERR; return 1; }
f
trap -p ERR
g() { trap 'echo B' ERR; return 1; }
g
trap -p ERR
"#,
        0,
        r#"A
trap -- 'echo A' ERR
B
trap -- 'echo B' ERR
"#,
    );
}

#[test]
fn source_and_function_return_order_preserves_live_frames() {
    check(
        "bashkit-suite:trap-scope:110",
        r#"echo 'echo in' > ret_src.sh
trap 'echo "ret ${FUNCNAME[0]:-top}"' RETURN
. ./ret_src.sh
f() { . ./ret_src.sh; }
f
set -T
f
"#,
        0,
        r#"in
ret top
in
in
ret f
ret f
"#,
    );
}

#[test]
fn normal_return_handler_preserves_trigger_status() {
    check(
        "bashkit-suite:trap-scope:128",
        r#"f() { trap 'echo "ret $?"' RETURN; false; }
f
echo "status $?"
"#,
        0,
        r#"ret 1
status 1
"#,
    );
}

#[test]
fn for_header_debug_runs_before_each_iteration() {
    check(
        "brush-suite:builtins/trap:79",
        "trap 'echo \"[debug: $BASH_COMMAND]\"' DEBUG\nfor i in 1 2; do\n  echo \"iter $i\"\ndone\n",
        0,
        "[debug: for i in 1 2]\n[debug: echo \"iter $i\"]\niter 1\n[debug: for i in 1 2]\n[debug: echo \"iter $i\"]\niter 2\n",
    );
}

#[test]
fn extdebug_repeats_function_entry_before_its_body() {
    check(
        "brush-suite:options/extdebug:1",
        "shopt -s extdebug\ntrap 'echo \"[debug: $BASH_COMMAND]\"' DEBUG\nmyfunc() {\n  echo \"in func\"\n}\necho \"before\"\nmyfunc\necho \"after\"\n",
        0,
        "[debug: echo \"before\"]\nbefore\n[debug: myfunc]\n[debug: myfunc]\n[debug: echo \"in func\"]\nin func\n[debug: echo \"after\"]\nafter\n",
    );
}

#[test]
fn review_err_traced_reset_survives_function_restore() {
    check(
        "brush-suite:options/errtrace:18",
        r###"set -E
trap 'echo "ERR"' ERR
myfunc() {
  trap - ERR
  false
  echo "no ERR in func"
}
myfunc
false
echo "after"
"###,
        0,
        r###"no ERR in func
after
"###,
    );
}

#[test]
fn review_err_final_explicit_subshell_keeps_its_event() {
    check(
        "oils:builtin-trap-err:127",
        r###"trap 'echo assign' ERR
a=$(false) | a=$(false) | a=$(false)

trap 'echo dparen' ERR
(( 0 )) | (( 0 )) | (( 0 ))

trap 'echo dbracket' ERR
[[ a = b ]] | [[ a = b ]] | [[ a = b ]]

trap 'echo subshell' ERR
(false) | (false) | (false) | (false)

trap 'echo subshell2' ERR
(false) | (false) | (false) | (false; false)

trap 'echo group' ERR
{ false; } | { false; } | { false; }

echo ok

"###,
        0,
        r###"assign
dparen
dbracket
subshell
subshell
subshell2
subshell2
group
ok
"###,
    );
}

#[test]
fn review_err_function_registration_is_not_retroactive() {
    check(
        "bashkit-suite:bashbox-err-trap:47",
        r###"f(){ trap 'echo t' ERR; return 1; }; f; false; echo end
"###,
        0,
        r###"t
end
"###,
    );
}

#[test]
fn review_err_reports_original_command_without_debug() {
    check(
        "brush-suite:builtins/trap:22",
        r###"trap 'echo "ERR for: $BASH_COMMAND"' ERR
nonexistent_command_xyz 2>/dev/null
echo "after"
"###,
        0,
        r###"ERR for: nonexistent_command_xyz 2> /dev/null
after
"###,
    );
}

#[test]
fn review_err_brace_pipeline_has_only_aggregate_event() {
    check(
        "oils:builtin-trap-err:174",
        r###"trap 'echo group2' ERR
{ false; } | { false; } | { false; false; }

echo ok

"###,
        0,
        r###"group2
ok
"###,
    );
}
