//! Helpers for the in-process integration tests.
//!
//! Every endpoint binds 127.0.0.1 with relays disabled and port mapping off, so nothing here
//! leaves the machine: peers reach each other at the loopback addresses `status` reports.

#![allow(dead_code)]

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::time::Duration;

use erainfra_mesh::daemon::{Config, Daemon, Running};
use erainfra_mesh::key;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream, UnixStream};

pub struct Node {
    pub running: Option<Running>,
    pub socket: PathBuf,
    pub key: PathBuf,
    pub state: Option<PathBuf>,
}

pub fn config(dir: &Path, name: &str, state: bool) -> Config {
    let mut cfg = Config::new(
        dir.join(format!("{name}.key")),
        dir.join(format!("{name}.sock")),
    );
    cfg.bind = Some("127.0.0.1:0".parse().unwrap());
    cfg.portmapper = false;
    if state {
        cfg.state_dir = Some(dir.join(format!("{name}-state")));
    }
    cfg
}

impl Node {
    pub async fn start(dir: &Path, name: &str) -> Node {
        Self::start_with(dir, name, false, None).await
    }

    pub async fn start_with(dir: &Path, name: &str, state: bool, idle: Option<Duration>) -> Node {
        let mut cfg = config(dir, name, state);
        if !cfg.key_path.exists() {
            key::init(&cfg.key_path).unwrap();
        }
        if let Some(idle) = idle {
            cfg.idle_timeout = idle;
        }
        let socket = cfg.socket_path.clone();
        let key = cfg.key_path.clone();
        let state = cfg.state_dir.clone();
        let running = Daemon::start(cfg).await.unwrap();
        Node {
            running: Some(running),
            socket,
            key,
            state,
        }
    }

    pub fn id(&self) -> String {
        self.running.as_ref().unwrap().endpoint_id().to_string()
    }

    pub async fn stop(&mut self) {
        if let Some(r) = self.running.take() {
            r.shutdown().await;
        }
    }

    /// Sends one raw line and returns the parsed response line.
    pub async fn raw(&self, line: &str) -> Value {
        let mut s = UnixStream::connect(&self.socket).await.unwrap();
        s.write_all(line.as_bytes()).await.unwrap();
        s.write_all(b"\n").await.unwrap();
        let mut reader = BufReader::new(s);
        let mut out = String::new();
        reader.read_line(&mut out).await.unwrap();
        serde_json::from_str(&out).unwrap_or_else(|e| panic!("bad response {out:?}: {e}"))
    }

    /// Sends a request and returns the whole response.
    pub async fn call(&self, req: Value) -> Value {
        self.raw(&req.to_string()).await
    }

    /// Sends a request that must succeed and returns its result.
    pub async fn ok(&self, req: Value) -> Value {
        let resp = self.call(req.clone()).await;
        assert_eq!(resp["ok"], true, "request {req} failed: {resp}");
        resp["result"].clone()
    }

    pub async fn status(&self) -> Value {
        self.ok(json!({"v":1,"op":"status"})).await
    }

    /// This Node's fleet entry, exactly as another Node's `set_fleet` takes it.
    pub async fn entry(&self) -> Value {
        let s = self.status().await;
        assert!(
            !s["addr"]["direct_addrs"].as_array().unwrap().is_empty(),
            "no direct address yet: {s}"
        );
        s["addr"].clone()
    }

    pub async fn set_fleet(&self, peers: &[&Node]) {
        let mut entries = Vec::new();
        for p in peers {
            entries.push(p.entry().await);
        }
        self.ok(json!({"v":1,"op":"set_fleet","peers":entries}))
            .await;
    }

    pub async fn link(&self, name: &str, peer: &Node, service: &str) -> SocketAddr {
        let r = self
            .ok(json!({"v":1,"op":"link","name":name,"peer":peer.id(),"service":service,"listen":"127.0.0.1:0"}))
            .await;
        r["listen"].as_str().unwrap().parse().unwrap()
    }

    pub async fn wait_status<F: Fn(&Value) -> bool>(&self, what: &str, f: F) -> Value {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        loop {
            let s = self.status().await;
            if f(&s) {
                return s;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "timed out waiting for {what}: {s:#}"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}

/// A TCP echo server on loopback. Returns its address.
pub async fn echo_server() -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((mut s, _)) = listener.accept().await {
            tokio::spawn(async move {
                let (mut r, mut w) = s.split();
                let _ = tokio::io::copy(&mut r, &mut w).await;
                let _ = w.shutdown().await;
            });
        }
    });
    addr
}

/// Two Nodes in each other's fleet, B exposing an echo server as `echo`, A linking to it.
pub async fn linked_pair(dir: &Path) -> (Node, Node, SocketAddr) {
    let a = Node::start(dir, "a").await;
    let b = Node::start(dir, "b").await;
    let echo = echo_server().await;
    b.ok(json!({"v":1,"op":"expose","name":"echo","target":echo.to_string()}))
        .await;
    a.set_fleet(&[&b]).await;
    b.set_fleet(&[&a]).await;
    let listen = a.link("echo", &b, "echo").await;
    (a, b, listen)
}

/// Writes `payload` through `addr`, half-closes, and returns everything read back.
pub async fn round_trip(addr: SocketAddr, payload: &[u8]) -> Vec<u8> {
    let s = TcpStream::connect(addr).await.unwrap();
    let (mut r, mut w) = s.into_split();
    let data = payload.to_vec();
    let writer = tokio::spawn(async move {
        w.write_all(&data).await.unwrap();
        w.shutdown().await.unwrap();
    });
    let mut out = Vec::with_capacity(payload.len());
    tokio::time::timeout(Duration::from_secs(60), r.read_to_end(&mut out))
        .await
        .expect("round trip timed out")
        .unwrap();
    writer.await.unwrap();
    out
}

/// Connects to `addr` and expects the mesh to close the connection without echoing anything.
pub async fn expect_refused(addr: SocketAddr) {
    let mut s = TcpStream::connect(addr).await.unwrap();
    let _ = s.write_all(b"hello?").await;
    let mut buf = Vec::new();
    let r = tokio::time::timeout(Duration::from_secs(20), s.read_to_end(&mut buf))
        .await
        .expect("a refused connection must be closed, not left hanging");
    if let Ok(n) = r {
        assert_eq!(
            n, 0,
            "a refused connection must carry no data back, got {buf:?}"
        );
    }
}

pub fn pattern(len: usize) -> Vec<u8> {
    let mut x: u32 = 0x9e37_79b9;
    (0..len)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            x as u8
        })
        .collect()
}
