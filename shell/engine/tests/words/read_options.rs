use super::*;
use shell_engine::io::{DescriptorKind, HostEndpoint, IoError};

#[test]
fn read_delimiters_preserve_shared_input_offsets_and_eof_status() {
    check_output(
        r#"printf 'a:b:c' | { read -d : a; read -d : b; read -d : c; printf '%s:[%s][%s][%s]\n' "$?" "$a" "$b" "$c"; }"#,
        "1:[a][b][c]\n",
    );
    check_output(
        r#"printf 'a\0b\0tail' | { read -d '' a; read -rd '' b; read -rd '' c; printf '%s:[%s][%s][%s]\n' "$?" "$a" "$b" "$c"; }"#,
        "1:[a][b][tail]\n",
    );
}

#[test]
fn exact_reads_disable_ifs_splitting_but_keep_escape_processing() {
    check_output(
        r#"read -N5 a b <<<'a b c'; printf '%s:[%s][%s]\n' "$?" "$a" "$b""#,
        "0:[a b c][]\n",
    );
    check_output(
        r#"read -N5 -n3 a b <<<'  abc'; printf '%s:[%s][%s]\n' "$?" "$a" "$b""#,
        "0:[  a][]\n",
    );
    check_output(
        "read -N4 a b <<'END'\na b\nc\nEND\nprintf '%s:[%s][%s]\\n' \"$?\" \"$a\" \"$b\"",
        "0:[a b\n][]\n",
    );
    check_output(
        r#"printf 'a\\:b:c' | { read -d : a; read -rd : b; printf '%s:[%s][%s]\n' "$?" "$a" "$b"; }"#,
        "1:[a:b][c]\n",
    );
}

#[test]
fn terminal_flags_do_not_print_prompts_for_redirected_input() {
    check_output(
        r#"read -sn2 a b <<<'x y:z'; printf '%s:[%s][%s]\n' "$?" "$a" "$b""#,
        "0:[x][]\n",
    );
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("read -p 'Enter: ' a <<< hello; echo \"$a\""), 0);
    assert_eq!(rig.output.bytes(), b"hello\n");
    assert!(rig.errors.bytes().is_empty());
}

struct TerminalInput(Endpoint);

impl HostEndpoint for TerminalInput {
    fn descriptor_kind(&self) -> Result<DescriptorKind, IoError> {
        Ok(DescriptorKind::Terminal)
    }

    fn read<'a>(
        &'a self,
        output: &'a mut [u8],
    ) -> futures::future::LocalBoxFuture<'a, Result<usize, IoError>> {
        self.0.read(output).boxed_local()
    }

    fn write<'a>(
        &'a self,
        _input: &'a [u8],
    ) -> futures::future::LocalBoxFuture<'a, Result<usize, IoError>> {
        async { Err(IoError::Unsupported) }.boxed_local()
    }
}

#[test]
fn prompts_use_reported_terminal_metadata() {
    let rig = Rig::new(Limits::default());
    let input = Endpoint::host(Rc::new(TerminalInput(Endpoint::bytes(b"hello\n".to_vec()))));
    let mut fds = FdTable::default();
    fds.insert(0, input);
    fds.insert(1, Endpoint::null());
    let (stderr, errors) = capture(1024);
    fds.insert(2, stderr);
    rig.shell.set_descriptors(fds).unwrap();
    assert_eq!(rig.run("read -p 'Enter: ' value"), 0);
    assert_eq!(rig.value("value").as_deref(), Some("hello"));
    assert_eq!(errors.bytes(), b"Enter: ");
}

#[derive(serde::Deserialize)]
struct TerminalFixture {
    bash: String,
    cases: Vec<TerminalCase>,
}

#[derive(serde::Deserialize)]
struct TerminalCase {
    name: String,
    command: String,
    stderr_mode: String,
    input: String,
    stdout: String,
    stderr: String,
    status: i32,
}

fn terminal_cases() -> Vec<TerminalCase> {
    let fixture: TerminalFixture = serde_json::from_str(include_str!(
        "../../../../scripts/fixtures/shell-read-terminal.json"
    ))
    .unwrap();
    assert_eq!(
        fixture.bash,
        "GNU bash, version 5.3.15(1)-release (x86_64-pc-linux-gnu)"
    );
    fixture.cases
}

enum PromptOutput {
    Failure(IoError),
    Pending(Rc<std::cell::Cell<bool>>),
}

impl HostEndpoint for PromptOutput {
    fn read<'a>(
        &'a self,
        _output: &'a mut [u8],
    ) -> futures::future::LocalBoxFuture<'a, Result<usize, IoError>> {
        async { Err(IoError::Unsupported) }.boxed_local()
    }

    fn write<'a>(
        &'a self,
        _input: &'a [u8],
    ) -> futures::future::LocalBoxFuture<'a, Result<usize, IoError>> {
        match self {
            Self::Failure(error) => futures::future::ready(Err(error.clone())).boxed_local(),
            Self::Pending(started) => {
                started.set(true);
                futures::future::pending().boxed_local()
            }
        }
    }
}

fn check_terminal_case(case: &TerminalCase) {
    let rig = Rig::new(Limits::default());
    let input = Endpoint::host(Rc::new(TerminalInput(Endpoint::bytes(
        case.input.as_bytes().to_vec(),
    ))));
    let mut fds = FdTable::default();
    fds.insert(0, input);
    let (stdout, output) = capture(1024);
    fds.insert(1, stdout);
    let (stderr, errors) = capture(1024);
    let stderr = match case.stderr_mode.as_str() {
        "capture" => Some(stderr),
        "closed" => None,
        "readonly" => Some(Endpoint::bytes(Vec::new())),
        "full" => Some(Endpoint::host(Rc::new(PromptOutput::Failure(
            IoError::Runtime(28),
        )))),
        "broken" => Some(Endpoint::host(Rc::new(PromptOutput::Failure(
            IoError::BrokenPipe,
        )))),
        _ => panic!("unknown stderr mode"),
    };
    if let Some(stderr) = stderr {
        fds.insert(2, stderr);
    }
    rig.shell.set_descriptors(fds).unwrap();
    let script = format!(
        "value=old; {}; printf '%s|<%s>\\n' \"$?\" \"$value\"",
        case.command
    );
    assert_eq!(rig.run(&script), case.status, "{}", case.name);
    assert_eq!(output.bytes(), case.stdout.as_bytes(), "{}", case.name);
    if case.stderr.is_empty() || case.stderr == "PROMPT" {
        assert_eq!(errors.bytes(), case.stderr.as_bytes(), "{}", case.name);
    }
    assert!(!errors.bytes().windows(6).any(|bytes| bytes == b"PROMPT") || case.stderr == "PROMPT");
}

#[test]
fn terminal_count_prompts_match_recorded_bash() {
    for case in terminal_cases().iter().filter(|case| {
        case.name.starts_with("count ") && !matches!(case.name.as_str(), "count -n0" | "count -N0")
    }) {
        check_terminal_case(case);
    }
}

#[test]
fn zero_maximum_terminal_read_does_not_prompt() {
    let case = terminal_cases()
        .into_iter()
        .find(|case| case.name == "count -n0")
        .unwrap();
    check_terminal_case(&case);
}

#[test]
fn zero_exact_terminal_read_does_not_prompt() {
    let case = terminal_cases()
        .into_iter()
        .find(|case| case.name == "count -N0")
        .unwrap();
    check_terminal_case(&case);
}

#[test]
fn failed_terminal_prompt_writes_match_recorded_bash() {
    for case in terminal_cases()
        .iter()
        .filter(|case| case.name.starts_with("failed prompt "))
    {
        check_terminal_case(case);
    }
}

#[test]
fn zero_terminal_reads_keep_validation_and_input_offsets() {
    for case in terminal_cases()
        .iter()
        .filter(|case| !case.name.starts_with("count ") && !case.name.starts_with("failed prompt "))
    {
        check_terminal_case(case);
    }
}

#[test]
fn cancelling_a_pending_terminal_prompt_does_not_read_or_assign() {
    let rig = Rig::new(Limits::default());
    rig.variable("value", "old");
    let pending = Rc::new(std::cell::Cell::new(false));
    let input = Endpoint::bytes(b"hello\n".to_vec());
    let mut fds = FdTable::default();
    fds.insert(0, Endpoint::host(Rc::new(TerminalInput(input.clone()))));
    fds.insert(
        2,
        Endpoint::host(Rc::new(PromptOutput::Pending(pending.clone()))),
    );
    rig.shell.set_descriptors(fds).unwrap();
    let job = rig.shell.start("read -p 'Enter: ' value").unwrap();
    rig.ex.drive(128);
    assert!(pending.get());
    assert!(!job.is_finished());
    rig.shell.interrupt();
    assert_eq!(rig.finish(job), 130);
    assert_eq!(rig.value("value").as_deref(), Some("old"));
    let mut fds = FdTable::default();
    fds.insert(0, input);
    rig.shell.set_descriptors(fds).unwrap();
    assert_eq!(rig.run("read -r value"), 0);
    assert_eq!(rig.value("value").as_deref(), Some("hello"));
}
