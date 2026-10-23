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
