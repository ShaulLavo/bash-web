//! Source-admitted program using the delivered Shell descriptor enumeration.
#[cfg(all(target_arch = "wasm32", target_os = "wasi"))]
fn main() {
    println!(
        "LAUNCH_PROBE:{}",
        serde_json::json!({
            "argv": std::env::args().collect::<Vec<_>>(),
            "env": std::env::vars().collect::<std::collections::BTreeMap<_, _>>(),
            "cwd": std::env::current_dir().unwrap(),
            "inherited": shell_wasi_process::inherited_shell_descriptors().unwrap(),
        })
    );
}

#[cfg(not(all(target_arch = "wasm32", target_os = "wasi")))]
fn main() {
    panic!("launch probe requires the Shell WASI worker");
}
