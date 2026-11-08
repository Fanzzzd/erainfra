//! Unit tests that need test-only switches on [`Config`]: a relay on loopback with a self-signed
//! certificate. Everything else is exercised end to end in `tests/`.

use std::time::Duration;

use serde_json::{Value, json};

use super::*;

async fn start(dir: &std::path::Path, name: &str) -> Running {
    let key_path = dir.join(format!("{name}.key"));
    key::init(&key_path).unwrap();
    let mut cfg = Config::new(key_path, dir.join(format!("{name}.sock")));
    cfg.loopback_only = true;
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

/// Every log line this test binary writes, from every test and thread. The capture is the global
/// subscriber, not a scoped one: tracing caches whether a log site is enabled when the site is
/// first reached, and with a single scoped subscriber it asks the reaching thread's subscriber. A
/// parallel test that reached "relays updated" first would then turn that line off for the
/// capture too.
fn capture() -> &'static Capture {
    static CAPTURE: std::sync::OnceLock<Capture> = std::sync::OnceLock::new();
    CAPTURE.get_or_init(|| {
        let logs = Capture::default();
        let writer = logs.clone();
        tracing::subscriber::set_global_default(
            tracing_subscriber::fmt()
                .with_max_level(tracing::Level::TRACE)
                .with_writer(move || writer.clone())
                .finish(),
        )
        .expect("no other test sets a global subscriber");
        logs
    })
}

#[tokio::test]
async fn relays_are_configured_at_runtime_and_reported() {
    let logs = capture();
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
        relays: relays.iter().map(|s| api::RelayEntry::url(*s)).collect(),
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
        relays: vec![api::RelayEntry::url("https://relay.example.com")],
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
        json!({"v":1,"op":"expose","name":"echo","target":echo_addr.to_string(),"allowed_peers":[a.endpoint_id().to_string()]}),
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

#[tokio::test]
async fn direct_only_cannot_dial_peer_relays_and_removing_relays_closes_connections() {
    let (_map, url, _server) = iroh::test_utils::run_relay_server_with(false)
        .await
        .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let a = start(dir.path(), "a").await;
    let b = start(dir.path(), "b").await;
    let relays = json!({"v":1,"op":"set_relays","relays":[url.to_string()]});
    call(&b.daemon, relays.clone()).await.unwrap();
    tokio::time::timeout(Duration::from_secs(10), b.daemon.endpoint().online())
        .await
        .unwrap();
    let a_id = a.endpoint_id();
    let b_id = b.endpoint_id();
    call(&a.daemon, json!({"v":1,"op":"set_fleet","peers":[{"id":b_id.to_string(),"relay_urls":[url.to_string()]}]})).await.unwrap();
    call(&b.daemon, json!({"v":1,"op":"set_fleet","peers":[{"id":a_id.to_string(),"relay_urls":[url.to_string()]}]})).await.unwrap();

    let addr = EndpointAddr::new(b_id).with_relay_url(url.clone());
    // An empty relay map with an enabled relay transport would connect here. Disabled means
    // there is no relay transport, even if the peer's address explicitly names a relay.
    assert!(!matches!(
        tokio::time::timeout(
            Duration::from_secs(2),
            a.daemon.endpoint().connect(addr.clone(), ALPN_TCP)
        )
        .await,
        Ok(Ok(_))
    ));

    let direct = a.daemon.endpoint();
    call(&a.daemon, relays).await.unwrap();
    assert!(
        direct.is_closed(),
        "a policy change discards the previous transport and its caches"
    );
    assert_eq!(a.endpoint_id(), a_id, "rebinding keeps the identity");
    let conn = tokio::time::timeout(
        Duration::from_secs(10),
        a.daemon.endpoint().connect(addr.clone(), ALPN_TCP),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(a.daemon.fleet.register(&conn));

    call(&a.daemon, json!({"v":1,"op":"set_relays","relays":[]}))
        .await
        .unwrap();
    assert_eq!(a.endpoint_id(), a_id);
    assert!(
        conn.close_reason().is_some(),
        "removing relays must close the old connection too"
    );
    assert!(!matches!(
        tokio::time::timeout(
            Duration::from_secs(2),
            a.daemon.endpoint().connect(addr, ALPN_TCP)
        )
        .await,
        Ok(Ok(_))
    ));
    a.shutdown().await;
    b.shutdown().await;
}

/// The relay map a `set_relays` request line produces, through the same parser the socket uses.
fn relays_from(request: Value) -> Result<BTreeMap<RelayUrl, Arc<RelayConfig>>, ApiError> {
    match api::parse_request(&request.to_string()).1? {
        Request::SetRelays {
            relays,
            auth_token,
            n0_fallback,
        } => relay_configs(&RelaysSpec {
            relays,
            auth_token,
            n0_fallback,
        }),
        other => panic!("parsed as {other:?}"),
    }
}

fn qad_port(map: &BTreeMap<RelayUrl, Arc<RelayConfig>>, url: &str) -> Option<u16> {
    let url: RelayUrl = url.parse().unwrap();
    map[&url].quic.as_ref().map(|q| q.port)
}

// Oracle Cloud's default security list blocks udp/7842, iroh's QAD port, and allows udp/443. A
// relay entry may name the port; a plain URL keeps meaning 7842.
#[test]
fn a_relay_entry_is_a_url_or_an_object_with_a_quic_port() {
    let map = relays_from(json!({"v":1,"op":"set_relays","relays":[
        "https://plain.example.com",
        {"url":"https://udp443.example.com","quic_port":443},
        {"url":"https://noqad.example.com","quic":false},
        {"url":"https://explicit.example.com","quic":true},
    ]}))
    .unwrap();
    assert_eq!(qad_port(&map, "https://plain.example.com"), Some(7842));
    assert_eq!(qad_port(&map, "https://udp443.example.com"), Some(443));
    assert_eq!(qad_port(&map, "https://noqad.example.com"), None);
    assert_eq!(qad_port(&map, "https://explicit.example.com"), Some(7842));
    assert_eq!(iroh::defaults::DEFAULT_RELAY_QUIC_PORT, 7842);

    // The token and the scheme rules apply to the object form as to a string.
    let map = relays_from(json!({"v":1,"op":"set_relays","auth_token":"t",
        "relays":[{"url":"https://udp443.example.com","quic_port":443}]}))
    .unwrap();
    assert_eq!(
        map.values().next().unwrap().auth_token.as_deref(),
        Some("t")
    );
    let err = relays_from(json!({"v":1,"op":"set_relays","auth_token":"t",
        "relays":[{"url":"http://udp443.example.com","quic_port":443}]}))
    .unwrap_err();
    assert!(err.message.contains("plain http"), "{}", err.message);

    // An entry listed twice still collapses into one relay when both agree.
    let map = relays_from(json!({"v":1,"op":"set_relays","relays":[
        {"url":"https://udp443.example.com","quic_port":443},
        {"url":"https://udp443.example.com","quic_port":443},
    ]}))
    .unwrap();
    assert_eq!(map.len(), 1);
}

#[test]
fn a_bad_relay_entry_is_refused_with_the_reason() {
    let url = "https://r.example.com";
    for (entry, want) in [
        (
            json!({"url":url,"quic_port":0}),
            "\"quic_port\" must be a port number from 1 to 65535, not 0",
        ),
        (
            json!({"url":url,"quic_port":65536}),
            "from 1 to 65535, not 65536",
        ),
        (
            json!({"url":url,"quic_port":"443"}),
            "from 1 to 65535, not \"443\"",
        ),
        (json!({"url":url,"quic_port":-1}), "from 1 to 65535, not -1"),
        (
            json!({"url":url,"quic_port":443.5}),
            "from 1 to 65535, not 443.5",
        ),
        (
            json!({"url":url,"quic":false,"quic_port":443}),
            "turns QUIC address discovery off, so drop \"quic_port\"",
        ),
        (
            json!({"url":url,"quic":"no"}),
            "\"quic\" must be true or false",
        ),
        (
            json!({"url":url,"qad_port":443}),
            "relay field \"qad_port\" is unknown",
        ),
        (json!({"quic_port":443}), "a relay object needs \"url\""),
        (json!({"url":7}), "a relay object needs \"url\""),
        (json!(443), "a relay is a URL string or an object"),
        (json!(null), "a relay is a URL string or an object"),
        (
            json!({"url":"ftp://r.example.com","quic_port":443}),
            "use https",
        ),
    ] {
        let err = relays_from(json!({"v":1,"op":"set_relays","relays":[entry]})).unwrap_err();
        assert_eq!(err.code, "bad_request", "{entry}");
        assert!(err.message.contains(want), "{entry}: {}", err.message);
    }
    let err = relays_from(json!({"v":1,"op":"set_relays","relays":[
        url,
        {"url":url,"quic_port":443},
    ]}))
    .unwrap_err();
    assert!(
        err.message
            .contains("listed twice with different QUIC address discovery settings"),
        "{}",
        err.message
    );
}

// state.json is read back by this daemon after a restart, and by an older one after a rollback.
#[test]
fn saved_relays_round_trip_and_older_state_still_loads() {
    let older = json!({"fleet":[],"relays":{"relays":["https://relay.example.com"],"n0_fallback":true},
        "exposures":{},"links":{}});
    let desired: Desired = serde_json::from_value(older.clone()).unwrap();
    assert_eq!(
        serde_json::to_value(&desired).unwrap(),
        older,
        "a plain URL stays a string"
    );
    let map = relay_configs(&desired.relays).unwrap();
    assert_eq!(qad_port(&map, "https://relay.example.com"), Some(7842));

    let newer = json!({"fleet":[],"relays":{"relays":[
        "https://a.example.com",
        {"url":"https://b.example.com","quic_port":443},
        {"url":"https://c.example.com","quic":false},
    ],"n0_fallback":false},"exposures":{},"links":{}});
    let desired: Desired = serde_json::from_value(newer.clone()).unwrap();
    assert_eq!(serde_json::to_value(&desired).unwrap(), newer);
    let map = relay_configs(&desired.relays).unwrap();
    assert_eq!(qad_port(&map, "https://a.example.com"), Some(7842));
    assert_eq!(qad_port(&map, "https://b.example.com"), Some(443));
    assert_eq!(qad_port(&map, "https://c.example.com"), None);
}

async fn start_with_state(dir: &std::path::Path, name: &str) -> Running {
    let key_path = dir.join(format!("{name}.key"));
    if !key_path.exists() {
        key::init(&key_path).unwrap();
    }
    let mut cfg = Config::new(key_path, dir.join(format!("{name}.sock")));
    cfg.loopback_only = true;
    cfg.insecure_relay_tls = true;
    cfg.portmapper = false;
    cfg.state_dir = Some(dir.join(format!("{name}.state")));
    Daemon::start(cfg).await.unwrap()
}

async fn wait_for_qad(d: &Daemon, what: &str) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        let report = d.endpoint().net_report().get();
        if report.as_ref().is_some_and(|r| r.udp_v4) {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for {what}: {report:?}"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

// End to end on loopback: the test relay serves QAD on a random UDP port, never 7842, so a QAD
// round trip completes only when the configured port reaches iroh. The setting survives a restart.
#[tokio::test]
async fn quic_address_discovery_uses_the_port_the_relay_entry_names() {
    let (_map, relay_url, server) = iroh::test_utils::run_relay_server_with(true).await.unwrap();
    let port = server.quic_addr().expect("QAD enabled").port();
    assert_ne!(port, 7842);
    let entry = json!({"url": relay_url.to_string(), "quic_port": port});

    let dir = tempfile::tempdir().unwrap();
    let a = start_with_state(dir.path(), "a").await;
    call(
        &a.daemon,
        json!({"v":1,"op":"set_relays","relays":[entry.clone()]}),
    )
    .await
    .unwrap();
    wait_for_qad(&a.daemon, "a QAD round trip on the configured port").await;
    let status = call(&a.daemon, json!({"v":1,"op":"status"})).await.unwrap();
    assert_eq!(status["relay"]["configured"], json!([entry]));
    a.shutdown().await;

    let a = start_with_state(dir.path(), "a").await;
    let status = call(&a.daemon, json!({"v":1,"op":"status"})).await.unwrap();
    assert_eq!(
        status["relay"]["configured"],
        json!([entry]),
        "restored from state.json"
    );
    wait_for_qad(&a.daemon, "a QAD round trip after a restart").await;
    a.shutdown().await;
}
