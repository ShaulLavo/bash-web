//! Native test composition for the shell fuzzers: the core-only standalone harness
//! plus the separately linked utilities, each started through the harness's own
//! process host as an external program at /bin/<name>. Never shipped.
fn main() {
    shell_compat_fixtures::compat::standalone(|host, fs, filesystem| {
        fs.mkdir("/bin", true).expect("utility directory");
        for (name, _) in shell_utilities::UTILITIES {
            let path = format!("/bin/{name}");
            fs.write_file(&path, &[]).expect("utility marker");
            fs.set_executable(&path, true).expect("utility metadata");
        }
        let line_bytes = shell_engine::Limits::default().line_bytes;
        shell_utilities::register_in_process(host, "/bin", filesystem, line_bytes);
    });
}
