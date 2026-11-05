//! Unit tests that need test-only switches on [`Config`]: a relay on loopback with a self-signed
//! certificate. Everything else is exercised end to end in `tests/`.

use std::time::Duration;

use serde_json::{Value, json};

use super::*;

async fn start(dir: &std::path::Path, name: &str) -> Running {
    let key_path = dir.join(format!("{name}.key"));
    key::init(&key_path).unwrap();
    let mut cfg = Config::new(key_path, dir.join(format!("{name}.sock")));
    cfg.bind = Some("127.0.0.1:0".parse().unwrap());
    cfg.insecure_relay_tls = true;
    cfg.portmapper = false;
    Daemon::start(cfg).await.unwrap()
}

async fn call(d: &Daemon, req: Value) -> Result<Value, ApiError> {
    let (_, req) = api::parse_request(&req.to_string());
    d.handle(req?).await
}

async fn wait_for<F: Fn(&Value) -> bool>(d: &Daemon, what: &str, f: F) -> Value {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        let status = call(d, json!({"v":1,"op":"status"})).await.unwrap();
        if f(&status) {
            return status;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for {what}: {status:#}"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// Collects every log line, at every level and from every crate, for the token check.
#[derive(Clone, Default)]
struct Capture(Arc<Mutex<Vec<u8>>>);

impl std::io::Write for Capture {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

// A current-thread runtime, so every task the daemon spawns logs into the capture below.
#[tokio::test(flavor = "current_thread")]
async fn relays_are_configured_at_runtime_and_reported() {
    let logs = Capture::default();
    let writer = logs.clone();
    let _guard = tracing::subscriber::set_default(
        tracing_subscriber::fmt()
            .with_max_level(tracing::Level::TRACE)
            .with_writer(move || writer.clone())
            .finish(),
    );
    let (_map, relay_url, _server) = iroh::test_utils::run_relay_server_with(false)
        .await
        .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let a = start(dir.path(), "a").await;

    let status = call(&a.daemon, json!({"v":1,"op":"status"})).await.unwrap();
    assert_eq!(status["relay"]["mode"], "direct_only");
    assert_eq!(status["addr"]["relay_urls"], json!([]));

    let set =
        json!({"v":1,"op":"set_relays","relays":[relay_url.to_string()],"auth_token":"s3cret"});
    let r = call(&a.daemon, set.clone()).await.unwrap();
    assert_eq!(r["changed"], true);
    assert_eq!(r["mode"], "relays");
    assert_eq!(call(&a.daemon, set).await.unwrap()["changed"], false);

    let status = wait_for(&a.daemon, "home relay connected", |s| {
        s["relay"]["home"]
            .as_array()
            .is_some_and(|h| h.iter().any(|r| r["connected"] == true))
    })
    .await;
    assert_eq!(status["relay"]["auth_token_set"], true);
    assert!(
        !status.to_string().contains("s3cret"),
        "status must never echo the relay token"
    );
    wait_for(&a.daemon, "relay URL in own address", |s| {
        s["addr"]["relay_urls"]
            .as_array()
            .is_some_and(|u| !u.is_empty())
    })
    .await;

    // Removing every relay goes back to direct-only.
    let r = call(&a.daemon, json!({"v":1,"op":"set_relays","relays":[]}))
        .await
        .unwrap();
    assert_eq!(r["mode"], "direct_only");

    {
        let inner = a.daemon.inner.lock().await;
        assert!(
            inner.applied_relays.is_empty(),
            "nothing stays in the relay map"
        );
    }
    a.shutdown().await;

    // The token was sent to the relay on every connection, and neither erainfra-mesh nor iroh
    // wrote it to a log line, even at trace level.
    let logs = String::from_utf8_lossy(&logs.0.lock().unwrap()).into_owned();
    assert!(logs.contains("relays updated"), "capture is working");
    assert!(!logs.contains("s3cret"), "the relay token reached the log");
}

// Computed without an endpoint: applying n0's relays would make the test reach the internet.
#[test]
fn n0_fallback_is_opt_in_and_gets_no_token() {
    let spec = |relays: &[&str], token: Option<&str>, n0: bool| RelaysSpec {
        relays: relays.iter().map(|s| s.to_string()).collect(),
        auth_token: token.map(str::to_string),
        n0_fallback: n0,
    };
    let is_n0 = |u: &RelayUrl| u.to_string().contains("n0.iroh.link");

    let without = relay_configs(&spec(&["https://relay.example.com"], Some("t"), false)).unwrap();
    assert_eq!(without.len(), 1);
    assert!(
        !without.keys().any(is_n0),
        "n0 relays appear only when asked for"
    );
    assert!(relay_configs(&spec(&[], None, false)).unwrap().is_empty());

    let with = relay_configs(&spec(&["https://relay.example.com"], Some("t"), true)).unwrap();
    let ours: Vec<_> = with.iter().filter(|(u, _)| !is_n0(u)).collect();
    assert_eq!(ours.len(), 1);
    assert_eq!(ours[0].1.auth_token.as_deref(), Some("t"));
    let n0: Vec<_> = with.iter().filter(|(u, _)| is_n0(u)).collect();
    assert!(!n0.is_empty(), "n0 fallback relays added");
    assert!(
        n0.iter().all(|(_, c)| c.auth_token.is_none()),
        "n0 relays must not get the fleet's token"
    );

    // Plain http with a token is refused: the token would cross the network in the clear.
    let err = relay_configs(&spec(&["http://relay.example.com"], Some("t"), false)).unwrap_err();
    assert_eq!(err.code, "bad_request");
    assert!(relay_configs(&spec(&["http://relay.example.com"], None, false)).is_ok());
    assert!(relay_configs(&spec(&["ftp://relay.example.com"], None, false)).is_err());
    assert!(relay_configs(&spec(&["https://relay.example.com"], Some(""), false)).is_err());
}

#[test]
fn relay_spec_debug_never_shows_the_token() {
    let spec = RelaysSpec {
        relays: vec!["https://relay.example.com".into()],
        auth_token: Some("hunter2".into()),
        n0_fallback: false,
    };
    let shown = format!("{spec:?}");
    assert!(!shown.contains("hunter2"), "{shown}");
    assert!(shown.contains("redacted"), "{shown}");
}

#[tokio::test]
async fn links_connect_through_a_relay_when_no_direct_address_is_known() {
    let (_map, relay_url, _server) = iroh::test_utils::run_relay_server_with(false)
        .await
        .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let a = start(dir.path(), "a").await;
    let b = start(dir.path(), "b").await;
    let relays = json!({"v":1,"op":"set_relays","relays":[relay_url.to_string()]});
    call(&a.daemon, relays.clone()).await.unwrap();
    call(&b.daemon, relays).await.unwrap();

    let echo = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let echo_addr = echo.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((mut s, _)) = echo.accept().await {
            tokio::spawn(async move {
                let (mut r, mut w) = s.split();
                let _ = tokio::io::copy(&mut r, &mut w).await;
            });
        }
    });
    call(
        &b.daemon,
        json!({"v":1,"op":"expose","name":"echo","target":echo_addr.to_string()}),
    )
    .await
    .unwrap();

    // Each side knows the other only by id and relay URL: no direct address at all.
    let a_id = a.endpoint_id().to_string();
    let b_id = b.endpoint_id().to_string();
    let url = relay_url.to_string();
    call(
        &a.daemon,
        json!({"v":1,"op":"set_fleet","peers":[{"id":b_id,"relay_urls":[url]}]}),
    )
    .await
    .unwrap();
    call(
        &b.daemon,
        json!({"v":1,"op":"set_fleet","peers":[{"id":a_id,"relay_urls":[url]}]}),
    )
    .await
    .unwrap();
    let r = call(
        &a.daemon,
        json!({"v":1,"op":"link","name":"echo","peer":b_id,"service":"echo","listen":"127.0.0.1:0"}),
    )
    .await
    .unwrap();
    let listen: std::net::SocketAddr = r["listen"].as_str().unwrap().parse().unwrap();

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut s = tokio::net::TcpStream::connect(listen).await.unwrap();
    s.write_all(b"over the relay").await.unwrap();
    let mut buf = [0u8; 14];
    tokio::time::timeout(Duration::from_secs(20), s.read_exact(&mut buf))
        .await
        .expect("echo through the relay")
        .unwrap();
    assert_eq!(&buf, b"over the relay");
    a.shutdown().await;
    b.shutdown().await;
}
