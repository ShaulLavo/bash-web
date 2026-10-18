//! Original fixture commands matching the compatibility harness's Python helpers.
//! Output goes through bounded descriptors, including for a long argument list.
use futures::FutureExt;
use serde::Deserialize;
use shell_engine::{
    executor::{Budget, Cancel},
    io::{Endpoint, MemoryFs},
    process::{InProcessHost, SpawnRequest},
};

pub fn register(host: &InProcessHost, fs: &MemoryFs) {
    fs.mkdir("/usr/bin", true)
        .expect("fixture helper directory");
    for path in ["/usr/bin/argv.py", "/usr/bin/printenv.py"] {
        fs.write_file(path, &[]).expect("fixture helper file");
        fs.set_executable(path, true)
            .expect("fixture helper metadata");
        host.register_access(path, "/", Ok(()));
        host.register_traversal_error(path, "/", 54);
    }
    host.register("/usr/bin/argv.py", |request, cancel| {
        argv(request, cancel).boxed_local()
    });
    host.register("/usr/bin/printenv.py", |request, cancel| {
        printenv(request, cancel).boxed_local()
    });
}

// These are wire-contract limits, not a second fixture tree. The sole tree is
// supplied by scripts/fuzz-shell-path.ts through BASH_WEB_PATH_FIXTURE.
const MAX_MANIFEST_BYTES: usize = 32768;
const MAX_NODES: usize = 128;
const MAX_PATH_BYTES: usize = 256;
const MAX_MARKER_BYTES: usize = 64;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct FixtureManifest {
    schema: u32,
    #[serde(deserialize_with = "bounded_nodes")]
    nodes: Vec<FixtureNode>,
}
#[derive(Debug, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum FixtureKind {
    Directory,
    File,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct FixtureNode {
    #[serde(deserialize_with = "fixture_path")]
    path: String,
    kind: FixtureKind,
    mode: u32,
    #[serde(default, deserialize_with = "fixture_marker")]
    marker: Option<String>,
    #[serde(default, deserialize_with = "fixture_status")]
    status: Option<i32>,
}

fn bounded_string<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
    limit: usize,
) -> Result<String, D::Error> {
    struct Bounded(usize);
    impl<'de> serde::de::Visitor<'de> for Bounded {
        type Value = String;
        fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(f, "a string of at most {} bytes", self.0)
        }
        fn visit_str<E: serde::de::Error>(self, value: &str) -> Result<String, E> {
            if value.len() > self.0 {
                return Err(E::custom("oversized fixture string"));
            }
            Ok(value.to_owned())
        }
    }
    deserializer.deserialize_str(Bounded(limit))
}
fn fixture_path<'de, D: serde::Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    bounded_string(d, MAX_PATH_BYTES)
}
fn fixture_marker<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    bounded_string(d, MAX_MARKER_BYTES).map(Some)
}
fn fixture_status<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<i32>, D::Error> {
    i32::deserialize(d).map(Some)
}
fn bounded_nodes<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<FixtureNode>, D::Error> {
    struct Nodes;
    impl<'de> serde::de::Visitor<'de> for Nodes {
        type Value = Vec<FixtureNode>;
        fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(f, "at most {MAX_NODES} fixture nodes")
        }
        fn visit_seq<A: serde::de::SeqAccess<'de>>(
            self,
            mut seq: A,
        ) -> Result<Self::Value, A::Error> {
            use serde::de::Error;
            if seq.size_hint().is_some_and(|size| size > MAX_NODES) {
                return Err(A::Error::custom("too many fixture nodes"));
            }
            // Never reserve from the deserializer's untrusted size hint.
            let mut nodes = Vec::new();
            while nodes.len() < MAX_NODES {
                let Some(node) = seq.next_element()? else {
                    return Ok(nodes);
                };
                nodes.push(node);
            }
            // Detect overflow without allocating the extra node or its strings.
            if seq.next_element::<serde::de::IgnoredAny>()?.is_some() {
                return Err(A::Error::custom("too many fixture nodes"));
            }
            Ok(nodes)
        }
    }
    d.deserialize_seq(Nodes)
}

fn parse_manifest(raw: &str) -> Result<FixtureManifest, String> {
    if raw.len() > MAX_MANIFEST_BYTES {
        return Err("oversized fixture JSON".to_owned());
    }
    let manifest: FixtureManifest =
        serde_json::from_str(raw).map_err(|error| format!("invalid fixture JSON: {error}"))?;
    if manifest.schema != 1 {
        return Err("unsupported fixture schema".to_owned());
    }
    for (index, node) in manifest.nodes.iter().enumerate() {
        if node.path.is_empty()
            || node.path.bytes().any(|byte| byte < 0x20 || byte == 0x7f)
            || node
                .path
                .split('/')
                .any(|part| matches!(part, "" | "." | ".."))
            || manifest.nodes[..index]
                .iter()
                .any(|prior| prior.path == node.path)
        {
            return Err("invalid or duplicate fixture path".to_owned());
        }
        if let Some((parent, _)) = node.path.rsplit_once('/') {
            if !manifest.nodes[..index]
                .iter()
                .any(|prior| prior.kind == FixtureKind::Directory && prior.path == parent)
            {
                return Err("fixture parent must be an earlier directory".to_owned());
            }
        }
        if node.mode > 0o777 {
            return Err("invalid fixture mode".to_owned());
        }
        match (&node.marker, node.status) {
            (None, None) => (),
            (Some(marker), Some(1..=255))
                if node.kind == FixtureKind::File
                    && !marker.is_empty()
                    && marker.bytes().all(|byte| {
                        byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')
                    }) =>
            {
                ()
            }
            _ => return Err("invalid fixture program".to_owned()),
        }
    }
    Ok(manifest)
}

/// Validate the complete bounded manifest before filesystem/process mutation.
/// Access outcomes and exact programs come only from this document; a callback
/// registration alone never establishes executable eligibility.
pub fn register_fixture(
    host: &InProcessHost,
    fs: &MemoryFs,
    cwd: &str,
    raw: &str,
) -> Result<(), String> {
    let manifest = parse_manifest(raw)?;
    let root = cwd.trim_end_matches('/');
    // Reserve enough room for the derived not-a-directory access paths too.
    if !cwd.starts_with('/')
        || root.len() + 2 * MAX_PATH_BYTES + 2 > 4096
        || cwd.bytes().any(|byte| byte < 0x20 || byte == 0x7f)
        || root
            .split('/')
            .skip(1)
            .any(|part| matches!(part, "" | "." | ".."))
    {
        return Err("invalid fixture cwd".to_owned());
    }
    let absolute = |path: &str| format!("{root}/{path}");
    host.register_directory(cwd, cwd);
    for node in &manifest.nodes {
        let path = absolute(&node.path);
        if node.kind == FixtureKind::Directory {
            fs.mkdir(&path, false)
                .map_err(|_| "fixture mkdir failed".to_owned())?;
        } else {
            fs.write_file(&path, &[])
                .map_err(|_| "fixture file failed".to_owned())?;
            fs.set_executable(&path, node.mode & 0o111 != 0)
                .map_err(|_| "fixture metadata failed".to_owned())?;
        }
    }
    for node in &manifest.nodes {
        let path = absolute(&node.path);
        let denied = manifest.nodes.iter().any(|ancestor| {
            ancestor.kind == FixtureKind::Directory
                && ancestor.mode & 0o111 == 0
                && (node.path == ancestor.path
                    || node
                        .path
                        .strip_prefix(ancestor.path.as_str())
                        .is_some_and(|rest| rest.starts_with('/')))
        });
        let result = if denied {
            Err(44)
        } else if node.kind == FixtureKind::Directory {
            Err(2)
        } else if node.mode & 0o111 != 0 {
            Ok(())
        } else {
            Err(2)
        };
        host.register_access(path.clone(), cwd, result);
        if node.kind == FixtureKind::Directory {
            host.register_directory(path.clone(), cwd);
        }
        if node.kind == FixtureKind::File {
            host.register_traversal_error(path.clone(), cwd, 54);
        } else if node.mode & 0o111 == 0 {
            host.register_traversal_error(path.clone(), cwd, 44);
        }
        if let (Some(marker), Some(status)) = (node.marker.clone(), node.status) {
            let marker = marker.into_bytes();
            host.register(path, move |request, cancel| {
                let marker = marker.clone();
                async move {
                    let Some(output) = request.fds.get(1) else {
                        return 1;
                    };
                    for bytes in [b"marker=<".as_slice(), &marker, b">\n"] {
                        if output.write_all(bytes, &cancel).await.is_err() {
                            return 1;
                        }
                    }
                    for arg in request.argv.iter().skip(1) {
                        for bytes in [b"arg=<".as_slice(), arg.as_bytes(), b">\n"] {
                            if output.write_all(bytes, &cancel).await.is_err() {
                                return 1;
                            }
                        }
                    }
                    status
                }
                .boxed_local()
            });
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use shell_engine::{executor::Executor, io::IoError};

    fn file(path: &str) -> serde_json::Value {
        json!({"path": path, "kind": "file", "mode": 384})
    }
    fn parse_nodes(nodes: serde_json::Value) -> Result<FixtureManifest, String> {
        parse_manifest(&json!({"schema": 1, "nodes": nodes}).to_string())
    }

    #[test]
    fn manifest_rejects_invalid_late_nodes_without_mutation() {
        let invalid = [
            json!(null),
            json!({}),
            json!({"path": "bad", "kind": "link", "mode": 493}),
            json!({"path": "bad", "kind": "file", "mode": 512}),
            json!({"path": "bad", "kind": "file", "mode": -1}),
            json!({"path": "bad", "kind": "file", "mode": 1.5}),
            json!({"path": "bad", "kind": "file", "mode": 493, "extra": true}),
            json!({"path": "bad", "kind": "file", "mode": 493, "marker": "ok"}),
            json!({"path": "bad", "kind": "file", "mode": 493, "status": 7}),
            json!({"path": "bad", "kind": "file", "mode": 493, "marker": null, "status": null}),
            json!({"path": "bad", "kind": "file", "mode": 493, "marker": "ok", "status": 0}),
            json!({"path": "bad", "kind": "file", "mode": 493, "marker": "ok", "status": 256}),
            json!({"path": "bad", "kind": "file", "mode": 493, "marker": "bad\nmarker", "status": 7}),
            json!({"path": "bad", "kind": "directory", "mode": 493, "marker": "ok", "status": 7}),
            json!({"path": "bad", "kind": "file", "mode": 493, "marker": "x".repeat(MAX_MARKER_BYTES + 1), "status": 7}),
        ];
        let paths = [
            "",
            "/absolute",
            "../escape",
            "a/../b",
            "a//b",
            "a/./b",
            "trailing/",
            "nul\0",
            "line\n",
            "first",
            "first/child",
            "missing/child",
        ];
        for node in invalid.into_iter().chain(paths.into_iter().map(file)) {
            let executor = Executor::new();
            let host = InProcessHost::new(executor);
            let fs = MemoryFs::new(4096);
            fs.mkdir("/fixture", true).unwrap();
            let raw = json!({"schema": 1, "nodes": [file("first"), node]}).to_string();
            assert!(
                register_fixture(&host, &fs, "/fixture", &raw).is_err(),
                "{raw}"
            );
            assert_eq!(fs.stat("/fixture/first", true), Err(IoError::NotFound));
            assert_eq!(fs.used_bytes(), 0);
        }
    }

    #[test]
    fn manifest_derives_traversal_capabilities_before_parent_reduction() {
        use shell_engine::process::{ProcessError, ProcessHost};
        let host = InProcessHost::new(Executor::new());
        let fs = MemoryFs::new(4096);
        fs.mkdir("/fixture", true).unwrap();
        let raw = json!({"schema": 1, "nodes": [
            {"path": "bin", "kind": "directory", "mode": 493},
            {"path": "empty", "kind": "directory", "mode": 493},
            {"path": "denied", "kind": "directory", "mode": 0},
            file("plain"),
            {"path": "bin/probe", "kind": "file", "mode": 493}
        ]})
        .to_string();
        register_fixture(&host, &fs, "/fixture", &raw).unwrap();
        for (path, expected) in [
            ("empty/../bin/probe", Ok(())),
            ("plain/../bin/probe", Err(ProcessError::Runtime(54))),
            ("denied/../bin/probe", Err(ProcessError::Runtime(44))),
            ("missing/../bin/probe", Err(ProcessError::Runtime(44))),
        ] {
            assert_eq!(
                host.access(path.into(), "/fixture".into())
                    .now_or_never()
                    .unwrap(),
                expected,
                "{path}"
            );
        }
    }

    #[test]
    fn manifest_enforces_wire_bounds_and_exact_schema() {
        let empty = r#"{"schema":1,"nodes":[]}"#;
        let padded = format!("{empty}{}", " ".repeat(MAX_MANIFEST_BYTES - empty.len()));
        assert!(parse_manifest(&padded).is_ok());
        assert!(
            parse_manifest(&(padded + " "))
                .unwrap_err()
                .contains("oversized")
        );
        assert!(
            parse_manifest(&(" ".repeat(MAX_MANIFEST_BYTES) + "not JSON"))
                .unwrap_err()
                .contains("oversized")
        );
        let mut nodes: Vec<_> = (0..MAX_NODES)
            .map(|index| file(&format!("file-{index}")))
            .collect();
        assert!(parse_nodes(json!(nodes)).is_ok());
        nodes.push(file("overflow"));
        assert!(parse_nodes(json!(nodes)).is_err());
        assert!(parse_nodes(json!([file(&"x".repeat(MAX_PATH_BYTES))])).is_ok());
        assert!(parse_nodes(json!([file(&"x".repeat(MAX_PATH_BYTES + 1))])).is_err());
        assert!(parse_nodes(json!([file(&"é".repeat(MAX_PATH_BYTES / 2 + 1))])).is_err());
        assert!(parse_nodes(json!([{"path": "max", "kind": "file", "mode": 511, "marker": "x".repeat(MAX_MARKER_BYTES), "status": 255}])).is_ok());
        for raw in [
            "null",
            "[]",
            "{}",
            r#"{"schema":2,"nodes":[]}"#,
            r#"{"schema":1,"nodes":[],"extra":1}"#,
            r#"{"schema":1,"nodes":{}}"#,
            r#"{"schema":1,"schema":1,"nodes":[]}"#,
        ] {
            assert!(parse_manifest(raw).is_err(), "{raw}");
        }
        assert!(
            parse_nodes(
                json!([{"path": "dir", "kind": "directory", "mode": 0}, file("dir/child")])
            )
            .is_ok()
        );
    }
}
