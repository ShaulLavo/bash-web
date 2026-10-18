#[cfg(not(target_os = "wasi"))]
fn main() {
    eprintln!("printenv.py fixture requires wasm32-wasip1 and a runtime_proc host");
    std::process::exit(2);
}
#[cfg(target_os = "wasi")]
fn main() {
    shell_utilities::guest_main(|invocation| async move {
        let (request, cancel) = shell_compat_fixtures::request("printenv.py", invocation);
        shell_compat_fixtures::compat::printenv(request, cancel).await
    });
}
