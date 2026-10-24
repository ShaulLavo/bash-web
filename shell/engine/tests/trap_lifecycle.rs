//! Frozen lifecycle witnesses from docs/evidence/own-shell-oracle.json.
//! No host Bash, new recording, fixture identity or baseline change is involved.
//! Missing lifecycle behavior stays explicitly ignored until the contract lands.
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
#[ignore = "pending trap lifecycle contract implementation"]
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
#[ignore = "pending trap lifecycle contract implementation"]
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
#[ignore = "pending trap lifecycle contract implementation"]
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
#[ignore = "pending trap lifecycle contract implementation"]
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
#[ignore = "pending trap lifecycle contract implementation"]
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
#[ignore = "pending trap lifecycle contract implementation"]
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

#[test]
#[ignore = "pending trap lifecycle contract implementation"]
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
#[ignore = "pending trap lifecycle contract implementation"]
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
#[ignore = "pending trap lifecycle contract implementation"]
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
#[ignore = "pending trap lifecycle contract implementation"]
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
#[ignore = "pending trap lifecycle contract implementation"]
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
#[ignore = "pending trap lifecycle contract implementation"]
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
#[ignore = "pending trap lifecycle contract implementation"]
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
#[ignore = "pending trap lifecycle contract implementation"]
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
#[ignore = "pending trap lifecycle contract implementation"]
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
