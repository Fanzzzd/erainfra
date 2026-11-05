//! The shipped binary: `init`, `id`, `daemon` with SIGTERM, and `ctl`.

#![cfg(unix)]

use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_erainfra-mesh");

fn mesh(args: &[&str]) -> std::process::Output {
    Command::new(BIN).args(args).output().unwrap()
}

fn path(p: &Path) -> &str {
    p.to_str().unwrap()
}

#[test]
fn init_creates_a_key_once_and_refuses_to_overwrite() {
    let dir = tempfile::tempdir().unwrap();
    let key = dir.path().join("mesh.key");

    let first = mesh(&["init", "--key", path(&key)]);
    assert!(first.status.success(), "{first:?}");
    let id = String::from_utf8(first.stdout).unwrap().trim().to_string();
    assert_eq!(id.len(), 64, "init prints the EndpointId: {id:?}");
    let bytes = std::fs::read(&key).unwrap();

    let second = mesh(&["init", "--key", path(&key)]);
    assert!(!second.status.success(), "a second init must fail");
    let err = String::from_utf8_lossy(&second.stderr);
    assert!(err.contains("refusing to overwrite"), "{err}");
    assert_eq!(std::fs::read(&key).unwrap(), bytes, "the key is untouched");

    let shown = mesh(&["id", "--key", path(&key)]);
    assert!(shown.status.success());
    assert_eq!(String::from_utf8(shown.stdout).unwrap().trim(), id);
}

#[test]
fn the_daemon_serves_ctl_and_exits_cleanly_on_sigterm() {
    let dir = tempfile::tempdir().unwrap();
    let key = dir.path().join("mesh.key");
    let socket = dir.path().join("mesh.sock");
    assert!(mesh(&["init", "--key", path(&key)]).status.success());
    let id = String::from_utf8(mesh(&["id", "--key", path(&key)]).stdout).unwrap();

    let mut child = Command::new(BIN)
        .args([
            "daemon",
            "--key",
            path(&key),
            "--socket",
            path(&socket),
            "--no-portmap",
            "--log-format",
            "json",
        ])
        // Trace level, so the token check below also covers whatever iroh itself logs.
        .env("RUST_LOG", "trace")
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(20);
    while !socket.exists() {
        assert!(
            Instant::now() < deadline,
            "daemon did not create its socket"
        );
        std::thread::sleep(Duration::from_millis(50));
    }

    let out = mesh(&["ctl", "--socket", path(&socket), r#"{"v":1,"op":"status"}"#]);
    assert!(out.status.success(), "{out:?}");
    let status: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(status["result"]["endpoint_id"], id.trim());

    let out = mesh(&[
        "ctl",
        "--socket",
        path(&socket),
        r#"{"v":1,"op":"set_relays","relays":["https://127.0.0.1:9"],"auth_token":"tok-do-not-log"}"#,
    ]);
    assert!(out.status.success(), "{out:?}");
    let bad = mesh(&["ctl", "--socket", path(&socket), r#"{"v":1,"op":"bogus"}"#]);
    assert!(
        !bad.status.success(),
        "ctl exits non-zero on an error response"
    );

    let kill = Command::new("kill")
        .args(["-TERM", &child.id().to_string()])
        .status()
        .unwrap();
    assert!(kill.success());
    let deadline = Instant::now() + Duration::from_secs(20);
    let status = loop {
        if let Some(s) = child.try_wait().unwrap() {
            break s;
        }
        assert!(Instant::now() < deadline, "daemon did not exit on SIGTERM");
        std::thread::sleep(Duration::from_millis(50));
    };
    assert!(status.success(), "SIGTERM is a clean exit: {status:?}");
    assert!(!socket.exists(), "the socket is removed on shutdown");

    let mut logs = String::new();
    use std::io::Read;
    child
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut logs)
        .unwrap();
    assert!(logs.contains("shutting down"), "{logs}");
    assert!(
        !logs.contains("tok-do-not-log"),
        "the relay token reached the log: {logs}"
    );
    for line in logs.lines() {
        serde_json::from_str::<serde_json::Value>(line)
            .unwrap_or_else(|e| panic!("--log-format json wrote a non-JSON line {line:?}: {e}"));
    }
}

#[test]
fn the_daemon_refuses_a_missing_key() {
    let dir = tempfile::tempdir().unwrap();
    let out = mesh(&[
        "daemon",
        "--key",
        path(&dir.path().join("absent.key")),
        "--socket",
        path(&dir.path().join("s.sock")),
    ]);
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("erainfra-mesh init"));
}
