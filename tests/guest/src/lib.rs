//! Shared, opt-in libc/preopen regression probe for both original WASI guests.

use std::fs;
use std::io::{self, Read, Write};
use std::os::fd::{FromRawFd, RawFd};
use std::path::Path;

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

// A borrowed descriptor must not be closed by the probe. Files opened by std::fs,
// in contrast, deliberately use the guest libc's ordinary preopen discovery.
fn with_fd<T>(fd: RawFd, operation: impl FnOnce(&mut fs::File) -> io::Result<T>) -> io::Result<T> {
    let mut file = std::mem::ManuallyDrop::new(unsafe { fs::File::from_raw_fd(fd) });
    operation(&mut file)
}

/// Read and write absolute filesystem paths with the real guest libc while fd 3
/// remains inherited. No adapter-side root lookup or runtime_proc I/O is involved.
pub fn preopen_probe(args: &[String]) -> Result<()> {
    let [mode, input, output, marker, extra_fds @ ..] = args else {
        return Err("expected preopen-{probe,input} <input> <output> <marker> [fd]...".into());
    };
    if !Path::new(input).is_absolute() || !Path::new(output).is_absolute() {
        return Err("preopen probe paths must be absolute".into());
    }
    let data = fs::read(input)?;
    if data != b"ROOT_PREOPEN_DATA\n" {
        return Err("unexpected preopen input".into());
    }
    let record = format!("{marker}:FILESYSTEM\n");
    fs::write(output, record.as_bytes())?;
    if fs::read(output)? != record.as_bytes() {
        return Err("preopen output readback differs".into());
    }
    match mode.as_str() {
        "preopen-probe" => {
            // Keep 3 literal: discovering a relocated root must never translate
            // the guest's own fd numbers, even when several bindings precede it.
            with_fd(3, |file| writeln!(file, "{marker}:FD3"))?;
            for fd in extra_fds {
                let fd: RawFd = fd.parse()?;
                with_fd(fd, |file| writeln!(file, "{marker}:FD{fd}"))?;
            }
        }
        "preopen-input" => {
            let mut inherited = Vec::new();
            with_fd(3, |file| file.read_to_end(&mut inherited))?;
            if inherited != data {
                return Err("inherited fd 3 does not match stdin".into());
            }
            println!("{marker}:FD3_INPUT");
        }
        _ => return Err("unknown preopen probe mode".into()),
    }
    Ok(())
}
