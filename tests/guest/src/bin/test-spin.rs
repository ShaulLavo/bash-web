//! Original CPU-only fixture for Waffle's source-admission loop instrumentation.
//! Intentionally has no cooperative checkpoints or runtime_proc imports.

use std::io::{self, Write};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if matches!(
        args.first().map(String::as_str),
        Some("preopen-probe" | "preopen-input")
    ) {
        if let Err(error) = test_guest::preopen_probe(&args) {
            eprintln!("test-spin: {error}");
            std::process::exit(2);
        }
        return;
    }
    if let Some(marker) = args.first() {
        let mut stdout = io::stdout().lock();
        writeln!(stdout, "{marker}").expect("write marker");
        stdout.flush().expect("flush marker");
    }
    let mut value = 0u64;
    loop {
        value = std::hint::black_box(value.wrapping_add(1));
    }
}
