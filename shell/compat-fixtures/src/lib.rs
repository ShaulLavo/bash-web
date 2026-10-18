use shell_engine::{
    executor::Cancel,
    io::{Endpoint, FdTable},
};

pub fn python_repr(argument: &[u8], output: &mut Vec<u8>) {
    let delimiter = if argument.contains(&b'\'') && !argument.contains(&b'"') {
        b'"'
    } else {
        b'\''
    };
    output.push(delimiter);
    for &byte in argument {
        let escaped: &[u8] = match byte {
            b'\\' => b"\\\\",
            b'\n' => b"\\n",
            b'\r' => b"\\r",
            b'\t' => b"\\t",
            b'\'' if delimiter == b'\'' => b"\\'",
            0x20..=0x7e => {
                output.push(byte);
                continue;
            }
            _ => {
                output.extend(format!("\\x{byte:02x}").bytes());
                continue;
            }
        };
        output.extend_from_slice(escaped);
    }
    output.push(delimiter);
}

pub fn argv_line(arguments: &[String]) -> Vec<u8> {
    let mut line = vec![b'['];
    for (index, argument) in arguments.iter().enumerate() {
        if index > 0 {
            line.extend_from_slice(b", ");
        }
        python_repr(argument.as_bytes(), &mut line);
    }
    line.extend_from_slice(b"]\n");
    line
}

pub fn printenv_lines(
    names: &[String],
    environment: &std::collections::BTreeMap<String, String>,
) -> Vec<u8> {
    let mut lines = Vec::new();
    for name in names {
        lines.extend_from_slice(
            environment
                .get(name)
                .map_or("None", String::as_str)
                .as_bytes(),
        );
        lines.push(b'\n');
    }
    lines
}

pub async fn emit(fds: &FdTable, bytes: &[u8], cancel: &Cancel) -> i32 {
    let Some(output): Option<Endpoint> = fds.get(1) else {
        return 1;
    };
    match output.write_all(bytes, cancel).await {
        Ok(()) => 0,
        Err(_) if cancel.is_cancelled() => 130,
        Err(_) => 1,
    }
}

#[cfg(target_os = "wasi")]
pub fn guest_main(
    helper: fn(&[String], &std::collections::BTreeMap<String, String>) -> Vec<u8>,
) -> ! {
    use futures::FutureExt;
    use shell_engine::{
        executor::Executor,
        runtime::{Runtime, WasiAbi},
    };
    use std::rc::Rc;
    let abi = Rc::new(WasiAbi::new().expect("root preopen"));
    abi.handle_interrupts().expect("signal setup");
    let executor = Executor::new();
    let runtime = Runtime::new(abi, executor.clone());
    let fds = runtime.stdio().expect("inherited descriptors");
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let environment = std::env::vars().collect();
    let bytes = helper(&arguments, &environment);
    let cancel = Cancel::new();
    let token = cancel.clone();
    let job = executor.spawn(async move { emit(&fds, &bytes, &token).await });
    while !job.is_finished() {
        if runtime.take_interrupt() {
            cancel.cancel();
        }
        let turn = executor.drive(64);
        if !job.is_finished() {
            runtime
                .poll(if turn.runnable { 0 } else { -1 })
                .expect("poll");
        }
    }
    std::process::exit(job.now_or_never().unwrap());
}

#[cfg(not(target_os = "wasi"))]
pub fn guest_main(
    _helper: fn(&[String], &std::collections::BTreeMap<String, String>) -> Vec<u8>,
) -> ! {
    eprintln!("this fixture requires wasm32-wasip1 and a runtime_proc host");
    std::process::exit(2);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn argv_matches_the_standalone_fixture_repr() {
        let arguments = [
            "a",
            "b c",
            "it's",
            "say \"hi\" it's",
            "tab\tnl\n\\",
            "\u{1}é",
        ]
        .map(String::from);
        assert_eq!(
            String::from_utf8(argv_line(&arguments)).unwrap(),
            "['a', 'b c', \"it's\", 'say \"hi\" it\\'s', 'tab\\tnl\\n\\\\', '\\x01\\xc3\\xa9']\n"
        );
        assert_eq!(argv_line(&[]), b"[]\n");
    }

    #[test]
    fn printenv_prints_values_or_none() {
        let environment = [("HOME".to_owned(), "/home/user".to_owned())].into();
        let names = ["HOME", "MISSING"].map(String::from);
        assert_eq!(printenv_lines(&names, &environment), b"/home/user\nNone\n");
    }
}
