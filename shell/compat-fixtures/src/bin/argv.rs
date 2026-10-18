#[cfg(not(target_os = "wasi"))]
fn main() {
    eprintln!("argv.py fixture requires wasm32-wasip1 and a runtime_proc host");
    std::process::exit(2);
}
#[cfg(target_os = "wasi")]
fn main() {
    shell_utilities::guest_main(|invocation| async move {
        let (request, cancel) = shell_compat_fixtures::request("argv.py", invocation);
        shell_compat_fixtures::compat::argv(request, cancel).await
    });
}
