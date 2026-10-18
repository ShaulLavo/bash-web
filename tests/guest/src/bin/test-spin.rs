//! Original CPU-only fixture for Waffle's source-admission loop instrumentation.
//! Intentionally has no cooperative checkpoints or runtime_proc imports.

use std::io::{self, Write};

fn main() {
    if let Some(marker) = std::env::args().nth(1) {
        let mut stdout = io::stdout().lock();
        writeln!(stdout, "{marker}").expect("write marker");
        stdout.flush().expect("flush marker");
    }
    let mut value = 0u64;
    loop {
        value = std::hint::black_box(value.wrapping_add(1));
    }
}
