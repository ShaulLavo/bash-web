//! Original, scriptless browser process acceptance fixture. No Bun APIs are emulated.
//! The only non-WASI imports are thin declarations of Waffle's runtime_proc ABI.

use std::env;
use std::fs;
use std::io::{self, IsTerminal, Read};
use std::path::PathBuf;
use std::time::{Duration, Instant};

#[link(wasm_import_module = "runtime_proc")]
extern "C" {
    #[link_name = "read"]
    fn proc_read(fd: u32, data: *mut u8, length: usize) -> i32;
    #[link_name = "write"]
    fn proc_write(fd: u32, data: *const u8, length: usize) -> i32;
    #[link_name = "pipe"]
    fn proc_pipe(output: *mut u32) -> i32;
    #[link_name = "poll"]
    fn proc_poll(
        subscriptions: *const Subscription,
        count: usize,
        timeout: i32,
        output: *mut u8,
    ) -> i32;
    #[link_name = "interrupted"]
    fn proc_interrupted() -> i32;
    #[link_name = "signal"]
    fn proc_signal(signal: u32, mode: u32) -> i32;
    #[link_name = "spawn"]
    fn proc_spawn(data: *const u8, length: usize) -> i32;
    #[link_name = "wait"]
    fn proc_wait(pid: u32, output: *mut u8) -> i32;
    #[link_name = "wait_job"]
    fn proc_wait_job(job: u32, flags: u32, output: *mut u8) -> i32;
    #[link_name = "job_of"]
    fn proc_job_of(pid: u32) -> i32;
    #[link_name = "kill"]
    fn proc_kill(pid: u32, signal: u32) -> i32;
}

#[link(wasm_import_module = "wasi_snapshot_preview1")]
extern "C" {
    #[link_name = "fd_close"]
    fn wasi_fd_close(fd: u32) -> u16;
}

fn close_fd(fd: u32) -> io::Result<()> {
    checked(-i32::from(unsafe { wasi_fd_close(fd) })).map(|_| ())
}

// ABI records are little-endian wasm32 structs, 16 bytes each. Poll kinds 0/1/2
// subscribe to readable fd / writable fd / child completion respectively.
#[repr(C)]
struct Subscription {
    kind: u32,
    id: u32,
    userdata: u64,
}

const AGAIN: i32 = 6;
const INTR: i32 = 27;
const PIPE: i32 = 64;
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

fn checkpoint() {
    // Waffle raises its typed default-signal unwind for fatal deliveries. This
    // fixture registers no handled signals; it does not turn traps into exit codes.
    unsafe { proc_interrupted() };
}

fn checked(value: i32) -> io::Result<i32> {
    if value < 0 {
        Err(io::Error::from_raw_os_error(-value))
    } else {
        Ok(value)
    }
}

fn poll(kind: u32, id: u32) -> io::Result<()> {
    checkpoint();
    let sub = Subscription {
        kind,
        id,
        userdata: 0,
    };
    let mut output = [0u8; 16];
    checked(unsafe { proc_poll(&sub, 1, 10, output.as_mut_ptr()) })?;
    checkpoint();
    Ok(())
}

fn sleep(milliseconds: u64) -> io::Result<()> {
    let start = Instant::now();
    let duration = Duration::from_millis(milliseconds);
    while start.elapsed() < duration {
        checkpoint();
        // No sleep or poll call can hide a fatal signal for an unbounded interval.
        let remaining = duration.saturating_sub(start.elapsed()).as_millis();
        let timeout = remaining.clamp(1, 10) as i32;
        checked(unsafe { proc_poll(std::ptr::null(), 0, timeout, std::ptr::null_mut()) })?;
    }
    checkpoint();
    Ok(())
}

fn read_fd(fd: u32, data: &mut [u8]) -> io::Result<usize> {
    loop {
        checkpoint();
        let result = unsafe { proc_read(fd, data.as_mut_ptr(), data.len()) };
        if result == -AGAIN {
            poll(0, fd)?;
        } else if result != -INTR {
            return checked(result).map(|count| count as usize);
        }
    }
}

fn write_fd(fd: u32, mut data: &[u8]) -> io::Result<()> {
    while !data.is_empty() {
        checkpoint();
        let result = unsafe { proc_write(fd, data.as_ptr(), data.len()) };
        if result == -AGAIN {
            poll(1, fd)?;
        } else if result != -INTR {
            let written = checked(result)? as usize;
            if written == 0 {
                return Err(io::ErrorKind::WriteZero.into());
            }
            data = &data[written..];
        }
    }
    Ok(())
}

fn line(fd: u32, text: &str) -> io::Result<()> {
    let mut record = String::with_capacity(text.len() + 1);
    record.push_str(text);
    record.push('\n');
    write_fd(fd, record.as_bytes())
}

fn copy_fd(input: u32, output: u32) -> io::Result<()> {
    let mut buffer = [0u8; 8192];
    loop {
        let count = read_fd(input, &mut buffer)?;
        if count == 0 {
            return Ok(());
        }
        write_fd(output, &buffer[..count])?;
    }
}

fn read_all() -> io::Result<Vec<u8>> {
    // Deliberately accumulates for child-memory accounting acceptance tests.
    let mut output = Vec::new();
    let mut buffer = [0u8; 8192];
    loop {
        let count = read_fd(0, &mut buffer)?;
        if count == 0 {
            return Ok(output);
        }
        output.extend_from_slice(&buffer[..count]);
    }
}

fn arg(args: &[String], index: usize) -> Result<&str> {
    args.get(index).map(String::as_str).ok_or_else(|| {
        format!(
            "missing argument {index} for {}",
            args.first().map_or("test-guest", String::as_str)
        )
        .into()
    })
}

fn number(args: &[String], index: usize) -> Result<usize> {
    Ok(arg(args, index)?.parse()?)
}

fn optional_number(args: &[String], index: usize, default: usize) -> Result<usize> {
    args.get(index)
        .map_or(Ok(default), |value| Ok(value.parse()?))
}

fn status(args: &[String], index: usize) -> Result<i32> {
    let value = optional_number(args, index, 0)?;
    if value > 255 {
        return Err("exit status must be 0..255".into());
    }
    Ok(value as i32)
}

fn cwd() -> String {
    // Preview1 has no chdir ABI. The launcher supplies the actual process cwd in
    // PWD; filesystem modes resolve relative paths against that explicit context.
    env::var("PWD").unwrap_or_else(|_| "/".into())
}

fn path(value: &str) -> PathBuf {
    let path = PathBuf::from(value);
    if path.is_absolute() {
        path
    } else {
        PathBuf::from(cwd()).join(path)
    }
}

fn input(path_arg: Option<&String>) -> io::Result<Vec<u8>> {
    if let Some(value) = path_arg {
        let mut file = fs::File::open(path(value))?;
        let mut data = Vec::new();
        file.read_to_end(&mut data)?;
        Ok(data)
    } else {
        read_all()
    }
}

fn count(data: &[u8], prefix: &str) -> io::Result<()> {
    line(
        1,
        &format!(
            "{prefix}:{}:{}",
            data.len(),
            data.iter().filter(|&&b| b == b'\n').count() + 1
        ),
    )
}

// Original JSON string encoder for the existing ABI's spawn request, not a guest
// runtime implementation. It handles all argv/env control characters without deps.
fn quote(value: &str) -> String {
    let mut output = String::from("\"");
    for character in value.chars() {
        match character {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            '\u{0}'..='\u{1f}' => output.push_str(&format!("\\u{:04x}", character as u32)),
            _ => output.push(character),
        }
    }
    output.push('"');
    output
}

fn spawn_request(executable: &str, args: &[String]) -> String {
    spawn_request_fds(executable, args, &[(0, 0), (1, 1), (2, 2)])
}

fn spawn_request_fds(executable: &str, args: &[String], fds: &[(u32, u32)]) -> String {
    let argv = std::iter::once(executable)
        .chain(args.iter().map(String::as_str))
        .map(quote)
        .collect::<Vec<_>>()
        .join(",");
    let env = env::vars()
        .map(|(key, value)| format!("{}:{}", quote(&key), quote(&value)))
        .collect::<Vec<_>>()
        .join(",");
    let bindings = fds
        .iter()
        .map(|(child, parent)| format!("{{\"child\":{child},\"parent\":{parent}}}"))
        .collect::<Vec<_>>()
        .join(",");
    format!("{{\"executable\":{},\"argv\":[{argv}],\"env\":{{{env}}},\"cwd\":{},\"job\":0,\"fds\":[{bindings}]}}", quote(executable), quote(&cwd()))
}

fn wait_status(bytes: [u8; 8]) -> io::Result<i32> {
    let kind = u32::from_le_bytes(bytes[..4].try_into().unwrap());
    let value = i32::from_le_bytes(bytes[4..].try_into().unwrap());
    match kind {
        0 => Ok(value),
        1 => Ok(128 + value),
        2 => Err(io::Error::from_raw_os_error(value)),
        _ => Err(io::Error::from_raw_os_error(28)),
    }
}

fn spawn_wait(request: &str, kill: Option<(u64, u32)>) -> Result<i32> {
    let pid = checked(unsafe { proc_spawn(request.as_ptr(), request.len()) })? as u32;
    let job = checked(unsafe { proc_job_of(pid) })? as u32;
    if let Some((milliseconds, signal)) = kill {
        sleep(milliseconds)?;
        checked(unsafe { proc_kill(pid, signal) })?;
    }
    let mut result = [0u8; 8];
    loop {
        checkpoint();
        let value = unsafe { proc_wait(pid, result.as_mut_ptr()) };
        if value == -AGAIN {
            poll(2, pid)?;
        } else if value != -INTR {
            checked(value)?;
            break;
        }
    }
    // Child completion alone does not reap the owned job or establish descendant
    // quiescence. Use the ABI's job wait before returning to the shell.
    let mut job_result = [0u8; 8];
    checked(unsafe { proc_wait_job(job, 0, job_result.as_mut_ptr()) })?;
    wait_status(job_result)?;
    Ok(wait_status(result)?)
}

fn run(args: &[String]) -> Result<i32> {
    match arg(args, 0)? {
        "emit" => {
            let text = arg(args, 1)?;
            for _ in 0..optional_number(args, 2, 1)? {
                write_fd(1, text.as_bytes())?;
            }
            return status(args, 3);
        }
        "emit-bytes" => {
            let data = args[1..]
                .iter()
                .flat_map(|argument| argument.split(','))
                .map(str::parse::<u8>)
                .collect::<std::result::Result<Vec<_>, _>>()?;
            write_fd(1, &data)?;
        }
        "preopen-probe" | "preopen-input" => test_guest::preopen_probe(args)?,
        "close-output-await-ack" => {
            // This process cannot exit until the consumer sees EOF. Retaining a
            // shell-side fd2 through terminal wait would make this cycle deadlock.
            write_fd(1, b"EOF_PAYLOAD\n")?;
            close_fd(1)?;
            close_fd(2)?;
            let mut ack = [0];
            if read_fd(3, &mut ack)? != 1 || ack != [b'!'] {
                return Err("missing downstream EOF acknowledgement".into());
            }
        }
        "ack-output-eof" => {
            copy_fd(0, 1)?;
            write_fd(3, b"!")?;
            line(1, "DOWNSTREAM_EOF_ACK")?;
        }
        "eof-handshake" => {
            let mut pipe = [0; 2];
            checked(unsafe { proc_pipe(pipe.as_mut_ptr()) })?;
            struct Pipe([u32; 2]);
            impl Drop for Pipe {
                fn drop(&mut self) {
                    for fd in self.0 {
                        let _ = close_fd(fd);
                    }
                }
            }
            let pipe = Pipe(pipe);
            let pipeline = "test-guest close-output-await-ack 3<&4 4<&- 5>&- 2>&1 | test-guest ack-output-eof 3>&5 4<&- 5>&-";
            let source = match arg(args, 1)? {
                "foreground" => {
                    format!("{pipeline}; printf 'EOF_JOB:%s:%s\\n' \"$?\" \"${{PIPESTATUS[*]}}\"")
                }
                "background" => {
                    format!("{pipeline} & job=$!; wait \"$job\"; printf 'EOF_JOB:%s\\n' \"$?\"")
                }
                _ => return Err("unknown EOF handshake job mode".into()),
            };
            let request = spawn_request_fds(
                "/usr/bin/bash",
                &["-c".into(), source],
                &[(0, 0), (1, 1), (2, 2), (4, pipe.0[0]), (5, pipe.0[1])],
            );
            return spawn_wait(&request, None);
        }
        "cat" => copy_fd(0, 1)?,
        "fd-read" => copy_fd(number(args, 1)?.try_into()?, 1)?,
        "fd-write" => write_fd(number(args, 1)?.try_into()?, arg(args, 2)?.as_bytes())?,
        "yes" => {
            checked(unsafe { proc_signal(13, 1) })?; // Ignore SIGPIPE, handle EPIPE explicitly.
            let text = args.get(1).map_or("y", String::as_str);
            loop {
                if let Err(error) = line(1, text) {
                    if error.raw_os_error() == Some(PIPE) {
                        return Ok(23);
                    }
                    return Err(error.into());
                }
            }
        }
        "ticker" => {
            let total = number(args, 1)?;
            let interval = number(args, 2)? as u64;
            let prefix = args.get(3).map_or("tick", String::as_str);
            let mut index = 0u64;
            loop {
                line(1, &format!("{prefix} {index}"))?;
                index += 1;
                if total != 0 && index >= total as u64 {
                    break;
                }
                sleep(interval)?;
            }
        }
        "sleep" => sleep(number(args, 1)? as u64)?,
        "spin" => {
            if let Some(marker) = args.get(1) {
                line(1, marker)?;
            }
            let mut value = 0u64;
            loop {
                for _ in 0..4096 {
                    value = std::hint::black_box(value.wrapping_add(1));
                }
                checkpoint();
            }
        }
        "exit" => return status(args, 1),
        "bytes" => {
            let data = input(args.get(1))?;
            let bytes = data.iter().map(u8::to_string).collect::<Vec<_>>().join(",");
            line(1, &format!("BYTES:{bytes}"))?;
        }
        "count" => count(&input(args.get(1))?, "COUNT")?,
        "delayed-count" => {
            line(2, "READER_WAITING")?;
            sleep(number(args, 1)? as u64)?;
            count(&read_all()?, args.get(2).map_or("COUNT", String::as_str))?;
        }
        "repeat-byte" => {
            let byte: u8 = number(args, 1)?.try_into()?;
            let mut remaining = number(args, 2)?;
            let buffer = [byte; 8192];
            while remaining != 0 {
                let count = remaining.min(buffer.len());
                write_fd(1, &buffer[..count])?;
                remaining -= count;
            }
        }
        "produce" => {
            let chunks = number(args, 1)?;
            let size = number(args, 2)?;
            let byte: u8 = optional_number(args, 3, 97)?.try_into()?;
            let buffer = vec![byte; size];
            for index in 0..chunks {
                write_fd(1, &buffer)?;
                line(2, &format!("WRITTEN:{index}"))?;
            }
        }
        "pattern" => {
            let size = number(args, 1)?;
            let blocks = number(args, 2)?;
            let modulus = number(args, 3)?;
            if modulus == 0 || modulus > 256 {
                return Err("modulus must be 1..256".into());
            }
            let mut buffer = vec![0u8; size];
            for index in 0..blocks {
                buffer.fill((index % modulus) as u8);
                write_fd(1, &buffer)?;
            }
        }
        "check-pattern" => {
            let size = number(args, 1)?;
            let modulus = number(args, 2)?;
            if size == 0 || modulus == 0 || modulus > 256 {
                return Err("block size must be positive; modulus must be 1..256".into());
            }
            let mut buffer = [0u8; 8192];
            let mut total = 0usize;
            let mut valid = true;
            loop {
                let count = read_fd(0, &mut buffer)?;
                if count == 0 {
                    break;
                }
                for (offset, &byte) in buffer[..count].iter().enumerate() {
                    valid &= byte == (((total + offset) / size) % modulus) as u8;
                }
                total += count;
            }
            line(1, &format!("COUNT:{total}:{valid}"))?;
        }
        "read-line" | "read-exact" => {
            let exact = args[0] == "read-exact";
            let (limit, prefix_index) = if exact {
                (number(args, 1)?, 2)
            } else {
                (usize::MAX, 1)
            };
            let prefix = args
                .get(prefix_index)
                .map_or(if exact { "PARTIAL:" } else { "INPUT:" }, String::as_str);
            if let Some(marker) = args.get(prefix_index + 1) {
                line(1, marker)?;
            }
            let mut data = Vec::new();
            while data.len() < limit {
                let mut byte = [0u8; 1];
                if read_fd(0, &mut byte)? == 0 {
                    break;
                }
                if !exact && (byte[0] == b'\r' || byte[0] == b'\n') {
                    break;
                }
                data.push(byte[0]);
            }
            line(1, &format!("{prefix}{}", String::from_utf8_lossy(&data)))?;
        }
        "zero-read" => {
            let count = read_fd(0, &mut [])?;
            line(1, &format!("ZERO_READ:{count}"))?;
        }
        "fd-types" => {
            line(
                1,
                &format!(
                    "STDIOTTY:{}:{}:{}",
                    u8::from(io::stdin().is_terminal()),
                    u8::from(io::stdout().is_terminal()),
                    u8::from(io::stderr().is_terminal())
                ),
            )?;
        }
        "write-order" => {
            for index in 0..optional_number(args, 1, 3)? {
                line(1, &format!("OUT:{index}"))?;
                line(2, &format!("ERR:{index}"))?;
            }
        }
        "context" => {
            line(1, &format!("CWD:{}", cwd()))?;
            if let Some(key) = args.get(1) {
                line(1, &format!("ENV:{}", env::var(key).unwrap_or_default()))?;
            }
        }
        "argv" => {
            for (index, value) in args[1..].iter().enumerate() {
                line(1, &format!("ARGV:{index}:{}", quote(value)))?;
            }
        }
        "write-file" => {
            fs::write(path(arg(args, 1)?), arg(args, 2)?.as_bytes())?;
            return status(args, 3);
        }
        "unlink" => fs::remove_file(path(arg(args, 1)?))?,
        "exists" => {
            let exists = match fs::metadata(path(arg(args, 1)?)) {
                Ok(_) => true,
                Err(error) if error.kind() == io::ErrorKind::NotFound => false,
                Err(error) => return Err(error.into()),
            };
            line(1, &format!("EXISTS:{exists}"))?;
        }
        "spawn" => return spawn_wait(&spawn_request(arg(args, 1)?, &args[2..]), None),
        "spawn-kill" => {
            let delay = number(args, 1)? as u64;
            let signal: u32 = number(args, 2)?.try_into()?;
            return spawn_wait(
                &spawn_request(arg(args, 3)?, &args[4..]),
                Some((delay, signal)),
            );
        }
        "spawn-json" => return spawn_wait(arg(args, 1)?, None),
        _ => return Err("unknown mode (see tests/guest/README.md)".into()),
    }
    Ok(0)
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let exit = match run(&args) {
        Ok(status) => status,
        Err(error) => {
            let _ = line(2, &format!("test-guest: {error}"));
            2
        }
    };
    std::process::exit(exit);
}
