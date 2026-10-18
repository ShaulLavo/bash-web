//! Original fixture commands matching the compatibility harness's Python helpers.
//! Output goes through bounded descriptors, including for a long argument list.
use futures::FutureExt;
use serde::Deserialize;
use shell_engine::{
    executor::{Budget, Cancel},
    io::{Endpoint, MemoryFs},
    process::{InProcessHost, SpawnRequest},
};

pub fn register(host: &InProcessHost) {
    host.register("argv.py", |request, cancel| {
        argv(request, cancel).boxed_local()
    });
    host.register("printenv.py", |request, cancel| {
        printenv(request, cancel).boxed_local()
    });
}

#[derive(Deserialize)]
struct FixtureManifest {
    schema: u32,
    nodes: Vec<FixtureNode>,
}
#[derive(Deserialize, Clone)]
struct FixtureNode {
    path: String,
    kind: String,
    mode: u32,
    marker: Option<String>,
    status: Option<i32>,
}

/// Install the opt-in portable path fixture. The manifest is bounded before any
/// filesystem or process registration, and access results are explicit host
/// capability data rather than spawn probes.
pub fn register_fixture(
    host: &InProcessHost,
    fs: &MemoryFs,
    cwd: &str,
    raw: &str,
) -> Result<(), String> {
    let manifest: FixtureManifest =
        serde_json::from_str(raw).map_err(|_| "invalid fixture JSON".to_owned())?;
    if manifest.schema != 1 || manifest.nodes.len() > 128 {
        return Err("unsupported or oversized fixture manifest".to_owned());
    }
    let root = cwd.trim_end_matches('/');
    let absolute = |path: &str| {
        if path.starts_with('/') {
            path.to_owned()
        } else {
            format!("{root}/{path}")
        }
    };
    for node in &manifest.nodes {
        if node.path.is_empty() || node.path.contains('\0') || node.path.len() > 4096 {
            return Err("invalid fixture path".to_owned());
        }
        let path = absolute(&node.path);
        if node.kind == "directory" {
            fs.mkdir(&path, true)
                .map_err(|_| "fixture mkdir failed".to_owned())?;
        } else if node.kind == "file" {
            fs.write_file(&path, &[])
                .map_err(|_| "fixture file failed".to_owned())?;
            fs.set_executable(&path, node.mode & 0o111 != 0)
                .map_err(|_| "fixture metadata failed".to_owned())?;
        } else {
            return Err("invalid fixture node kind".to_owned());
        }
    }
    for node in &manifest.nodes {
        let path = absolute(&node.path);
        let denied = manifest.nodes.iter().any(|ancestor| {
            ancestor.kind == "directory"
                && ancestor.mode & 0o111 == 0
                && (node.path == ancestor.path
                    || node.path.starts_with(&(ancestor.path.clone() + "/")))
        });
        let result = if denied {
            Err(44)
        } else if node.kind == "directory" {
            Err(54)
        } else if node.mode & 0o111 != 0 {
            Ok(())
        } else {
            Err(2)
        };
        host.register_access(path.clone(), cwd, result);
        if let (Some(marker), Some(status)) = (node.marker.clone(), node.status) {
            let marker = marker.into_bytes();
            host.register(path, move |request, cancel| {
                let marker = marker.clone();
                async move {
                    let Some(output) = request.fds.get(1) else {
                        return 1;
                    };
                    output.write_all(b"marker=<", &cancel).await.ok();
                    output.write_all(&marker, &cancel).await.ok();
                    output.write_all(b">\n", &cancel).await.ok();
                    for arg in request.argv.iter().skip(1) {
                        output.write_all(b"arg=<", &cancel).await.ok();
                        output.write_all(arg.as_bytes(), &cancel).await.ok();
                        output.write_all(b">\n", &cancel).await.ok();
                    }
                    status
                }
                .boxed_local()
            });
        }
    }
    let command_names: Vec<String> = manifest
        .nodes
        .iter()
        .filter(|node| node.kind == "file")
        .filter_map(|node| node.path.rsplit('/').next().map(str::to_owned))
        .collect();
    for node in &manifest.nodes {
        if node.kind == "file" {
            let parent = absolute(&node.path);
            for command in &command_names {
                host.register_access(format!("{parent}/{command}"), cwd, Err(54));
            }
        }
    }
    Ok(())
}

async fn argv(request: SpawnRequest, cancel: Cancel) -> i32 {
    let Some(output) = request.fds.get(1) else {
        return 1;
    };
    if output.write_all(b"[", &cancel).await.is_err() {
        return 1;
    }
    for (index, arg) in request.argv.iter().skip(1).enumerate() {
        if index > 0 && output.write_all(b", ", &cancel).await.is_err() {
            return 1;
        }
        if repr(&output, arg.as_bytes(), &cancel).await.is_err() {
            return 1;
        }
    }
    if output.write_all(b"]\n", &cancel).await.is_err() {
        return 1;
    }
    0
}

async fn printenv(request: SpawnRequest, cancel: Cancel) -> i32 {
    let Some(output) = request.fds.get(1) else {
        return 1;
    };
    let mut budget = Budget::default();
    for name in request.argv.iter().skip(1) {
        if budget.checkpoint(&cancel).await.is_err() {
            return 130;
        }
        let value = request.env.get(name).map(String::as_str).unwrap_or("None");
        if output.write_all(value.as_bytes(), &cancel).await.is_err()
            || output.write_all(b"\n", &cancel).await.is_err()
        {
            return 1;
        }
    }
    0
}

async fn repr(output: &Endpoint, bytes: &[u8], cancel: &Cancel) -> Result<(), ()> {
    let quote = if bytes.contains(&b'\'') && !bytes.contains(&b'"') {
        b'"'
    } else {
        b'\''
    };
    let mut buffer = vec![quote];
    let mut budget = Budget::default();
    for byte in bytes {
        budget.checkpoint(cancel).await.map_err(|_| ())?;
        escape(*byte, quote, &mut buffer);
        if buffer.len() >= 8192 {
            output.write_all(&buffer, cancel).await.map_err(|_| ())?;
            buffer.clear();
        }
    }
    buffer.push(quote);
    output.write_all(&buffer, cancel).await.map_err(|_| ())
}

fn escape(byte: u8, quote: u8, buffer: &mut Vec<u8>) {
    match byte {
        b'\\' => buffer.extend_from_slice(b"\\\\"),
        b'\n' => buffer.extend_from_slice(b"\\n"),
        b'\r' => buffer.extend_from_slice(b"\\r"),
        b'\t' => buffer.extend_from_slice(b"\\t"),
        b'\'' if quote == b'\'' => buffer.extend_from_slice(b"\\'"),
        0x20..=0x7e => buffer.push(byte),
        _ => {
            let hex = b"0123456789abcdef";
            buffer.extend_from_slice(&[
                b'\\',
                b'x',
                hex[(byte >> 4) as usize],
                hex[(byte & 15) as usize],
            ]);
        }
    }
}
