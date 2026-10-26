// uutils coreutils head, MIT licensed. See docs/head.md and the distribution notices.
mod upstream {
    uucore::bin!(uu_head);
}

fn main() {
    #[cfg(target_os = "wasi")]
    initialize_cwd();
    upstream::main();
}

#[cfg(target_os = "wasi")]
fn initialize_cwd() {
    // Waffle passes the process directory as PWD; WASI libc starts at the preopen root.
    let Ok(cwd) = std::env::var("PWD") else {
        return;
    };
    if let Err(error) = std::env::set_current_dir(&cwd) {
        eprintln!("head: set cwd {cwd}: {error}");
        std::process::exit(1);
    }
}
