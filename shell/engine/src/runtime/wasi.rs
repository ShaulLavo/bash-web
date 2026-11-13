//! Guest-side bindings, written from the runtime's documented process ABI.
use super::*;
use crate::io::DescriptorKind;
#[link(wasm_import_module = "runtime_proc")]
unsafe extern "C" {
    #[link_name = "access_start"]
    fn proc_access_start(
        path_ptr: *const u8,
        path_len: usize,
        cwd_ptr: *const u8,
        cwd_len: usize,
        mode: i32,
    ) -> i32;
    #[link_name = "access_take"]
    fn proc_access_take(request: u32) -> i32;
    #[link_name = "access_cancel"]
    fn proc_access_cancel(request: u32) -> i32;
    #[link_name = "spawn"]
    fn proc_spawn(ptr: *const u8, length: usize) -> i32;
    #[link_name = "exec"]
    fn proc_exec(ptr: *const u8, length: usize) -> i32;
    #[link_name = "spawn_error"]
    fn proc_spawn_error(pid: u32, output: *mut u8, capacity: usize) -> i32;
    #[link_name = "job_of"]
    fn proc_job_of(pid: u32) -> i32;
    #[link_name = "start_status"]
    fn proc_start_status(pid: u32) -> i32;
    #[link_name = "wait"]
    fn proc_wait(pid: u32, output: *mut u8) -> i32;
    #[link_name = "wait_job"]
    fn proc_wait_job(job: u32, flags: u32, output: *mut u8) -> i32;
    #[link_name = "kill"]
    fn proc_kill(pid: u32, signal: i32) -> i32;
    #[link_name = "kill_job"]
    fn proc_kill_job(job: u32, signal: i32) -> i32;
    #[link_name = "signal"]
    fn proc_signal(signal: i32, disposition: i32) -> i32;
}
// Original shell-launch metadata, separate from the shared runtime_proc ABI.
#[link(wasm_import_module = "shell_terminal")]
unsafe extern "C" {
    #[link_name = "inherited_fd"]
    fn shell_inherited_fd(index: u32) -> i32;
}
fn result(value: i32) -> Result<u32, i32> {
    if value < 0 {
        Err(-value)
    } else {
        Ok(value as u32)
    }
}
#[link(wasm_import_module = "wasi_snapshot_preview1")]
unsafe extern "C" {
    fn fd_prestat_get(fd: u32, stat: *mut u8) -> u16;
    fn fd_prestat_dir_name(fd: u32, name: *mut u8, length: usize) -> u16;
}

fn root_preopen(inherited_count: usize) -> Option<u32> {
    let last = 3u32.checked_add(u32::try_from(inherited_count).ok()?)?;
    (3..=last).find(|&fd| {
        let mut stat = [0; 8];
        if unsafe { fd_prestat_get(fd, stat.as_mut_ptr()) } != 0 || stat[0] != 0 {
            return false;
        }
        let length = u32::from_le_bytes(stat[4..8].try_into().unwrap());
        let mut name = [0];
        length == 1
            && unsafe { fd_prestat_dir_name(fd, name.as_mut_ptr(), 1) } == 0
            && name[0] == b'/'
    })
}

pub struct WasiAbi(support::WasiAbi, Option<u32>, Vec<u32>);
impl WasiAbi {
    pub fn new() -> Result<Self, i32> {
        let mut inherited = Vec::new();
        for index in 0.. {
            let fd = unsafe { shell_inherited_fd(index) };
            if fd < 0 {
                break;
            }
            inherited.push(fd as u32);
        }
        let root = root_preopen(inherited.len());
        let abi = support::WasiAbi::with_inherited_fds(inherited.clone())?;
        inherited.retain(|&fd| {
            let mut stat = [0; 8];
            (unsafe { fd_prestat_get(fd, stat.as_mut_ptr()) }) != 0
        });
        Ok(Self(abi, root, inherited))
    }
    pub fn handle_interrupts(&self) -> Result<(), i32> {
        register_interrupt_handler(|signal, disposition| unsafe {
            proc_signal(signal, disposition)
        })
    }
    /// Only a shell started with `--prompt-host` asks for SIGWINCH.
    pub fn handle_window_changes(&self) -> Result<(), i32> {
        register_handler(SIGWINCH, |signal, disposition| unsafe {
            proc_signal(signal, disposition)
        })
    }
}
impl support::Abi for WasiAbi {
    fn inherited_fds(&self) -> Vec<u32> {
        self.2.clone()
    }
    fn pipe(&self) -> Result<(u32, u32), i32> {
        support::Abi::pipe(&self.0)
    }
    fn fd_kind(&self, fd: u32) -> Result<DescriptorKind, i32> {
        support::Abi::fd_kind(&self.0, fd)
    }
    fn dup(&self, fd: u32) -> Result<u32, i32> {
        support::Abi::dup(&self.0, fd)
    }
    fn close(&self, fd: u32) {
        support::Abi::close(&self.0, fd);
    }
    fn mkdir(&self, path: &str, allow_existing: bool) -> Result<(), i32> {
        support::Abi::mkdir(&self.0, path, allow_existing)
    }
    fn stat(&self, path: &str, follow_symlinks: bool) -> Result<FileMetadata, i32> {
        support::Abi::stat(&self.0, path, follow_symlinks)
    }
    fn open_dir(&self, path: &str) -> Result<u32, i32> {
        support::Abi::open_dir(&self.0, path)
    }
    fn read_dir(&self, fd: u32, cookie: u64, output: &mut [u8]) -> Result<usize, i32> {
        support::Abi::read_dir(&self.0, fd, cookie, output)
    }
    fn open(&self, path: &str, options: &OpenOptions) -> Result<u32, i32> {
        support::Abi::open(&self.0, path, options)
    }
    fn read(&self, fd: u32, output: &mut [u8]) -> Result<usize, i32> {
        support::Abi::read(&self.0, fd, output)
    }
    fn write(&self, fd: u32, input: &[u8]) -> Result<usize, i32> {
        support::Abi::write(&self.0, fd, input)
    }
    fn poll(
        &self,
        subscriptions: &[Subscription],
        timeout: i32,
        output: &mut [PollEvent],
    ) -> Result<usize, i32> {
        support::Abi::poll(&self.0, subscriptions, timeout, output)
    }
    fn interrupted(&self) -> i32 {
        support::Abi::interrupted(&self.0)
    }
}

impl Abi for WasiAbi {
    fn root_preopen(&self) -> Option<u32> {
        self.1
    }
    fn exec(&self, request: &RuntimeExec) -> Result<std::convert::Infallible, i32> {
        let json = serde_json::to_vec(request).map_err(|_| 28)?;
        // The host unwinds success. A returning nonnegative result violates the ABI.
        let value = unsafe { proc_exec(json.as_ptr(), json.len()) };
        Err(if value < 0 { -value } else { 29 })
    }
    fn access_start(&self, path: &str, cwd: &str) -> Result<u32, i32> {
        result(unsafe { proc_access_start(path.as_ptr(), path.len(), cwd.as_ptr(), cwd.len(), 1) })
    }
    fn access_take(&self, request: u32) -> Result<(), i32> {
        result(unsafe { proc_access_take(request) }).map(|_| ())
    }
    fn access_cancel(&self, request: u32) {
        let _ = unsafe { proc_access_cancel(request) };
    }
    fn spawn(&self, request: &RuntimeSpawn) -> Result<u32, i32> {
        let json = serde_json::to_vec(request).map_err(|_| 28)?;
        result(unsafe { proc_spawn(json.as_ptr(), json.len()) })
    }
    fn spawn_error(&self, pid: u32, output: &mut [u8]) -> Result<usize, i32> {
        result(unsafe { proc_spawn_error(pid, output.as_mut_ptr(), output.len()) })
            .map(|count| count as usize)
    }
    fn job_of(&self, pid: u32) -> Result<u32, i32> {
        result(unsafe { proc_job_of(pid) })
    }
    fn start_status(&self, pid: u32) -> Result<i32, i32> {
        result(unsafe { proc_start_status(pid) }).map(|status| status as i32)
    }
    fn wait(&self, pid: u32) -> Result<WaitResult, i32> {
        let mut bytes = [0; 8];
        result(unsafe { proc_wait(pid, bytes.as_mut_ptr()) })?;
        WaitResult::decode(bytes)
    }
    fn wait_job(&self, job: u32) -> Result<WaitResult, i32> {
        let mut bytes = [0; 8];
        result(unsafe { proc_wait_job(job, 1, bytes.as_mut_ptr()) })?;
        WaitResult::decode(bytes)
    }
    fn kill(&self, pid: u32, signal: i32) -> Result<(), i32> {
        result(unsafe { proc_kill(pid, signal) }).map(|_| ())
    }
    fn kill_job(&self, job: u32, signal: i32) -> Result<(), i32> {
        result(unsafe { proc_kill_job(job, signal) }).map(|_| ())
    }
}
