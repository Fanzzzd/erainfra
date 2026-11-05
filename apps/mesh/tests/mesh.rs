//! End-to-end tests: real daemons, driven through their control sockets, forwarding real TCP over
//! iroh on loopback. No relay and no public network.

#![cfg(unix)]

mod common;

use std::time::Duration;

use common::*;
use erainfra_mesh::ALPN_TCP;
use iroh::endpoint::{ConnectionError, PortmapperConfig, presets};
use iroh::{Endpoint, EndpointAddr, RelayMode, SecretKey, TransportAddr};
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// A refused or revoked stream closes without returning any service data.
async fn assert_closed(stream: &mut TcpStream) {
    let mut byte = [0u8; 1];
    match tokio::time::timeout(Duration::from_secs(5), stream.read(&mut byte)).await {
        Ok(Ok(0) | Err(_)) => {}
        Ok(Ok(n)) => panic!("unauthorized stream returned {n} bytes: {byte:?}"),
        Err(_) => {
            panic!("authorization revocation must close the stream without waiting for reconnect")
        }
    }
}

#[tokio::test]
async fn exposure_grants_are_default_deny() {
    let dir = tempfile::tempdir().unwrap();
    let mut a = Node::start(dir.path(), "a").await;
    let mut b = Node::start(dir.path(), "b").await;
    a.set_fleet(&[&b]).await;
    b.set_fleet(&[&a]).await;
    let echo = echo_server().await;
    let listen = a.link("db", &b, "db").await;
    for explicit_empty in [false, true] {
        let mut expose = json!({"v":1,"op":"expose","name":"db","target":echo.to_string()});
        if explicit_empty {
            expose["allowed_peers"] = json!([]);
        }
        b.ok(expose).await;
        let mut client = TcpStream::connect(listen).await.unwrap();
        client.write_all(b"deny by default").await.unwrap();
        assert_closed(&mut client).await;
    }
    let status = b.status().await;
    assert_eq!(status["exposures"][0]["allowed_peers"], json!([]));
    assert_eq!(status["exposures"][0]["connections_total"], 0);
    assert_eq!(status["exposures"][0]["connections_refused"], 2);
    a.stop().await;
    b.stop().await;
}

#[tokio::test]
async fn exposure_authorization_is_scoped_and_revocation_closes_existing_streams() {
    let dir = tempfile::tempdir().unwrap();
    let mut a = Node::start(dir.path(), "a").await;
    let mut b = Node::start(dir.path(), "b").await;
    let mut c = Node::start(dir.path(), "c").await;
    a.set_fleet(&[&b, &c]).await;
    b.set_fleet(&[&a, &c]).await;
    c.set_fleet(&[&a, &b]).await;
    let echo = echo_server().await;
    let expose = |peers: serde_json::Value| json!({"v":1,"op":"expose","name":"db","target":echo.to_string(),"allowed_peers":peers});
    b.ok(expose(json!([a.id()]))).await;
    let a_listen = a.link("db", &b, "db").await;
    let c_listen = c.link("db", &b, "db").await;
    let mut a_live = TcpStream::connect(a_listen).await.unwrap();
    a_live.write_all(b"a").await.unwrap();
    let mut byte = [0u8; 1];
    a_live.read_exact(&mut byte).await.unwrap();
    assert_eq!(byte, *b"a");

    // C is a fleet member with a valid handshake, but has no grant to this exposure.
    let mut c_denied = TcpStream::connect(c_listen).await.unwrap();
    c_denied.write_all(b"c").await.unwrap();
    assert_closed(&mut c_denied).await;
    let status = b.status().await;
    assert_eq!(status["fleet_rejections"], 0, "C passes fleet admission");
    assert_eq!(
        status["exposures"][0]["connections_total"], 1,
        "C never reaches the target"
    );
    assert_eq!(status["exposures"][0]["connections_refused"], 1);

    // Granting C access must not interrupt A's existing stream or reset counters.
    b.ok(expose(json!([a.id(), c.id()]))).await;
    a_live.write_all(b"b").await.unwrap();
    a_live.read_exact(&mut byte).await.unwrap();
    assert_eq!(byte, *b"b");
    let mut c_live = TcpStream::connect(c_listen).await.unwrap();
    c_live.write_all(b"c").await.unwrap();
    c_live.read_exact(&mut byte).await.unwrap();
    assert_eq!(byte, *b"c");

    // Canonical peer sets are idempotent regardless of ordering or duplicate entries.
    assert_eq!(
        b.ok(expose(json!([c.id(), a.id(), c.id()]))).await["changed"],
        false
    );
    let invalid = b.call(expose(json!(["not-an-endpoint-id"]))).await;
    assert_eq!(invalid["ok"], false);
    assert_eq!(invalid["error"]["code"], "bad_request");

    // Revoke only A. Its live stream closes without reconnecting; C's stream keeps serving.
    b.ok(expose(json!([c.id()]))).await;
    assert_closed(&mut a_live).await;
    c_live.write_all(b"d").await.unwrap();
    c_live.read_exact(&mut byte).await.unwrap();
    assert_eq!(byte, *b"d");
    let mut a_denied = TcpStream::connect(a_listen).await.unwrap();
    a_denied.write_all(b"x").await.unwrap();
    assert_closed(&mut a_denied).await;
    let status = b.status().await;
    assert_eq!(status["exposures"][0]["allowed_peers"], json!([c.id()]));
    assert_eq!(status["exposures"][0]["connections_total"], 2);
    assert!(
        status["fleet"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["id"] == a.id()),
        "revoking a service grant does not remove A from the fleet"
    );
    a.stop().await;
    b.stop().await;
    c.stop().await;
}

#[tokio::test]
async fn legacy_saved_exposures_load_without_implicit_access() {
    let dir = tempfile::tempdir().unwrap();
    let mut a = Node::start(dir.path(), "a").await;
    let mut b = Node::start_with(dir.path(), "b", true, None).await;
    a.set_fleet(&[&b]).await;
    b.set_fleet(&[&a]).await;
    let echo = echo_server().await;
    b.ok(
        json!({"v":1,"op":"expose","name":"db","target":echo.to_string(),"allowed_peers":[a.id()]}),
    )
    .await;
    let listen = a.link("db", &b, "db").await;
    assert_eq!(round_trip(listen, b"authorized").await, b"authorized");
    let state_path = b.state.as_ref().unwrap().join("state.json");
    b.stop().await;

    // Earlier, undeployed v1 state had no per-exposure authorization field. Read it, but
    // never infer grants from the saved fleet, links or prior all-fleet behavior.
    let mut state: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&state_path).unwrap()).unwrap();
    state["exposures"]["db"]
        .as_object_mut()
        .unwrap()
        .remove("allowed_peers");
    std::fs::write(&state_path, serde_json::to_vec(&state).unwrap()).unwrap();
    let mut b = Node::start_with(dir.path(), "b", true, None).await;
    a.set_fleet(&[&b]).await;
    b.set_fleet(&[&a]).await;
    assert_eq!(b.status().await["exposures"][0]["allowed_peers"], json!([]));
    let mut denied = TcpStream::connect(listen).await.unwrap();
    denied.write_all(b"no inherited access").await.unwrap();
    assert_closed(&mut denied).await;
    b.ok(
        json!({"v":1,"op":"expose","name":"db","target":echo.to_string(),"allowed_peers":[a.id()]}),
    )
    .await;
    assert_eq!(
        round_trip(listen, b"explicit again").await,
        b"explicit again"
    );
    a.stop().await;
    b.stop().await;
}

#[tokio::test]
async fn expose_and_link_carry_a_tcp_echo() {
    let dir = tempfile::tempdir().unwrap();
    let (mut a, mut b, listen) = linked_pair(dir.path()).await;

    assert_eq!(
        round_trip(listen, b"hello over iroh").await,
        b"hello over iroh"
    );

    // Counters move on both sides.
    let s = a
        .wait_status("link counters", |s| s["links"][0]["bytes_received"] == 15)
        .await;
    assert_eq!(s["links"][0]["bytes_sent"], 15);
    assert_eq!(s["links"][0]["connections_total"], 1);
    assert_eq!(s["links"][0]["peer_in_fleet"], true);
    let s = b.status().await;
    assert_eq!(s["exposures"][0]["name"], "echo");
    assert_eq!(s["exposures"][0]["bytes_received"], 15);
    assert_eq!(s["exposures"][0]["bytes_sent"], 15);
    assert_eq!(s["relay"]["mode"], "direct_only");
    a.stop().await;
    b.stop().await;
}

#[tokio::test]
async fn a_large_payload_arrives_intact() {
    let dir = tempfile::tempdir().unwrap();
    let (mut a, mut b, listen) = linked_pair(dir.path()).await;
    let payload = pattern(32 * 1024 * 1024);
    let back = round_trip(listen, &payload).await;
    assert_eq!(back.len(), payload.len());
    assert!(back == payload, "payload corrupted in transit");
    a.stop().await;
    b.stop().await;
}

#[tokio::test]
async fn many_concurrent_connections_share_one_peer_connection() {
    let dir = tempfile::tempdir().unwrap();
    let (mut a, mut b, listen) = linked_pair(dir.path()).await;
    let mut tasks = Vec::new();
    for i in 0..100u32 {
        tasks.push(tokio::spawn(async move {
            let payload = pattern(64 * 1024 + i as usize);
            let back = round_trip(listen, &payload).await;
            assert!(back == payload, "connection {i} corrupted");
        }));
    }
    for t in tasks {
        t.await.unwrap();
    }
    let s = a
        .wait_status("all connections done", |s| {
            s["links"][0]["connections_active"] == 0
        })
        .await;
    assert_eq!(s["links"][0]["connections_total"], 100);
    assert_eq!(s["links"][0]["connections_refused"], 0);
    // One QUIC connection carried all of them.
    assert_eq!(s["fleet"][0]["connections"], 1);
    a.stop().await;
    b.stop().await;
}

#[tokio::test]
async fn a_link_enforces_its_connection_limit() {
    let dir = tempfile::tempdir().unwrap();
    let (mut a, mut b, _) = linked_pair(dir.path()).await;
    let r = a
        .ok(json!({"v":1,"op":"link","name":"one","peer":b.id(),"service":"echo","listen":"127.0.0.1:0","max_connections":1}))
        .await;
    let listen: std::net::SocketAddr = r["listen"].as_str().unwrap().parse().unwrap();
    // Hold the only slot open with a live echo.
    let mut first = TcpStream::connect(listen).await.unwrap();
    first.write_all(b"x").await.unwrap();
    let mut one = [0u8; 1];
    first.read_exact(&mut one).await.unwrap();
    expect_refused(listen).await;
    a.wait_status("refusal counted", |s| {
        s["links"]
            .as_array()
            .unwrap()
            .iter()
            .any(|l| l["name"] == "one" && l["connections_refused"] == 1)
    })
    .await;
    a.stop().await;
    b.stop().await;
}

#[tokio::test]
async fn a_peer_outside_the_fleet_is_rejected_before_any_data() {
    let dir = tempfile::tempdir().unwrap();
    let a = Node::start(dir.path(), "a").await;
    let mut b = Node::start(dir.path(), "b").await;
    let echo = echo_server().await;
    b.ok(json!({"v":1,"op":"expose","name":"echo","target":echo.to_string(),"allowed_peers":[a.id()]}))
        .await;
    b.set_fleet(&[&a]).await;

    // An endpoint B has never heard of dials B directly with the right ALPN.
    let stranger = Endpoint::builder(presets::Minimal)
        .secret_key(SecretKey::generate())
        .relay_mode(RelayMode::Disabled)
        .portmapper_config(PortmapperConfig::Disabled)
        .clear_ip_transports()
        .bind_addr("127.0.0.1:0")
        .unwrap()
        .bind()
        .await
        .unwrap();
    let entry = b.entry().await;
    let b_addr = EndpointAddr::from_parts(
        b.id().parse().unwrap(),
        entry["direct_addrs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| TransportAddr::Ip(a.as_str().unwrap().parse().unwrap())),
    );
    match stranger.connect(b_addr, ALPN_TCP).await {
        Err(_) => {}
        Ok(conn) => {
            // The handshake may complete from the client's view; B closes it at once with 403,
            // before a single stream is served.
            let reason = tokio::time::timeout(Duration::from_secs(10), conn.closed())
                .await
                .expect("B must close a stranger's connection");
            match reason {
                ConnectionError::ApplicationClosed(close) => {
                    assert_eq!(close.error_code.into_inner(), 403, "{close:?}");
                }
                other => panic!("expected an application close with 403, got {other:?}"),
            }
        }
    }
    stranger.close().await;
    let s = b.status().await;
    // The handshake hook did the rejecting, not a later check.
    assert_eq!(s["fleet_rejections"], 1);
    assert_eq!(s["exposures"][0]["connections_total"], 0);
    assert_eq!(s["exposures"][0]["bytes_received"], 0);
    b.stop().await;
    drop(a);
}

#[tokio::test]
async fn a_member_that_the_peer_does_not_list_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let mut a = Node::start(dir.path(), "a").await;
    let mut b = Node::start(dir.path(), "b").await;
    let echo = echo_server().await;
    b.ok(json!({"v":1,"op":"expose","name":"echo","target":echo.to_string(),"allowed_peers":[a.id()]}))
        .await;
    // A lists B, but B does not list A.
    a.set_fleet(&[&b]).await;
    let listen = a.link("echo", &b, "echo").await;
    expect_refused(listen).await;
    let s = b.status().await;
    assert_eq!(s["exposures"][0]["connections_total"], 0);
    assert!(s["fleet_rejections"].as_u64().unwrap() >= 1, "{s}");
    a.wait_status("refusal counted", |s| {
        s["links"][0]["connections_refused"] == 1
    })
    .await;
    a.stop().await;
    b.stop().await;
}

#[tokio::test]
async fn a_node_refuses_to_dial_outside_its_fleet() {
    let dir = tempfile::tempdir().unwrap();
    let mut a = Node::start(dir.path(), "a").await;
    let mut b = Node::start(dir.path(), "b").await;
    let echo = echo_server().await;
    b.ok(json!({"v":1,"op":"expose","name":"echo","target":echo.to_string(),"allowed_peers":[a.id()]}))
        .await;
    b.set_fleet(&[&a]).await;
    // A links to B without listing it: nothing is dialed, the TCP client is closed.
    let listen = a.link("echo", &b, "echo").await;
    let s = a.status().await;
    assert_eq!(s["links"][0]["peer_in_fleet"], false);
    expect_refused(listen).await;
    assert_eq!(b.status().await["fleet"][0]["connections"], 0);
    a.stop().await;
    b.stop().await;
}

#[tokio::test]
async fn an_unknown_service_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let (mut a, mut b, _) = linked_pair(dir.path()).await;
    let listen = a.link("nope", &b, "not-exposed").await;
    expect_refused(listen).await;
    a.wait_status("refusal counted", |s| {
        s["links"]
            .as_array()
            .unwrap()
            .iter()
            .any(|l| l["name"] == "nope" && l["connections_refused"] == 1)
    })
    .await;
    a.stop().await;
    b.stop().await;
}

#[tokio::test]
async fn removing_a_peer_from_the_fleet_disconnects_it() {
    let dir = tempfile::tempdir().unwrap();
    let (mut a, mut b, listen) = linked_pair(dir.path()).await;

    // A live, idle-but-open connection through the mesh.
    let mut live = TcpStream::connect(listen).await.unwrap();
    live.write_all(b"ping").await.unwrap();
    let mut buf = [0u8; 4];
    live.read_exact(&mut buf).await.unwrap();
    assert_eq!(&buf, b"ping");
    b.wait_status("A connected", |s| s["fleet"][0]["connections"] == 1)
        .await;

    let r = b.ok(json!({"v":1,"op":"set_fleet","peers":[]})).await;
    assert_eq!(r["changed"], true);
    assert_eq!(r["removed"], json!([a.id()]));

    // The established TCP connection is torn down, not left open.
    let mut rest = Vec::new();
    let read = tokio::time::timeout(Duration::from_secs(10), live.read_to_end(&mut rest))
        .await
        .expect("removal must close live connections");
    if let Ok(n) = read {
        assert_eq!(n, 0);
    }
    // And a new one is refused, since B no longer accepts A.
    expect_refused(listen).await;
    assert!(b.status().await["fleet"].as_array().unwrap().is_empty());
    a.stop().await;
    b.stop().await;
}

#[tokio::test]
async fn operations_are_idempotent_by_name() {
    let dir = tempfile::tempdir().unwrap();
    let (mut a, mut b, listen) = linked_pair(dir.path()).await;
    let echo = b.status().await["exposures"][0]["target"].clone();

    let expose = json!({"v":1,"op":"expose","name":"echo","target":echo,"allowed_peers":[a.id()]});
    assert_eq!(b.ok(expose.clone()).await["changed"], false);

    let link = json!({"v":1,"op":"link","name":"echo","peer":b.id(),"service":"echo","listen":"127.0.0.1:0"});
    let again = a.ok(link).await;
    assert_eq!(again["changed"], false);
    assert_eq!(
        again["listen"],
        listen.to_string(),
        "a repeated link keeps its listener"
    );

    let fleet = json!({"v":1,"op":"set_fleet","peers":[b.entry().await]});
    assert_eq!(a.ok(fleet).await["changed"], false);
    let relays = json!({"v":1,"op":"set_relays","relays":[]});
    assert_eq!(a.ok(relays).await["changed"], false);

    // A changed spec under the same name replaces the old one.
    let fixed = json!({"v":1,"op":"link","name":"echo","peer":b.id(),"service":"echo","listen":listen.to_string()});
    let r = a.ok(fixed.clone()).await;
    assert_eq!(r["changed"], true);
    assert_eq!(
        r["listen"],
        listen.to_string(),
        "rebinding the same port works"
    );
    assert_eq!(a.ok(fixed).await["changed"], false);
    assert_eq!(round_trip(listen, b"still works").await, b"still works");
    let bigger = json!({"v":1,"op":"expose","name":"echo","target":echo,"allowed_peers":[a.id()],"max_connections":10});
    assert_eq!(b.ok(bigger).await["changed"], true);
    assert_eq!(b.status().await["exposures"][0]["max_connections"], 10);
    assert_eq!(round_trip(listen, b"and again").await, b"and again");

    // Removing twice is fine; the second does nothing.
    let unlink = json!({"v":1,"op":"unlink","name":"echo"});
    assert_eq!(a.ok(unlink.clone()).await["changed"], true);
    assert_eq!(a.ok(unlink).await["changed"], false);
    assert!(
        TcpStream::connect(listen).await.is_err(),
        "an unlinked listener is closed"
    );
    let unexpose = json!({"v":1,"op":"unexpose","name":"echo"});
    assert_eq!(b.ok(unexpose.clone()).await["changed"], true);
    assert_eq!(b.ok(unexpose).await["changed"], false);
    assert!(b.status().await["exposures"].as_array().unwrap().is_empty());
    a.stop().await;
    b.stop().await;
}

#[tokio::test]
async fn the_endpoint_id_and_configuration_survive_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    let mut a = Node::start_with(dir.path(), "a", true, None).await;
    let mut b = Node::start_with(dir.path(), "b", true, None).await;
    let echo = echo_server().await;
    b.ok(json!({"v":1,"op":"expose","name":"echo","target":echo.to_string(),"allowed_peers":[a.id()]}))
        .await;
    a.set_fleet(&[&b]).await;
    b.set_fleet(&[&a]).await;
    let r = a
        .ok(json!({"v":1,"op":"link","name":"echo","peer":b.id(),"service":"echo","listen":"127.0.0.1:0"}))
        .await;
    let a_id = a.id();
    let b_id = b.id();
    assert!(r["listen"].is_string());

    // The state file is owner-only: it can hold the relay token.
    {
        use std::os::unix::fs::PermissionsExt;
        let meta = std::fs::metadata(a.state.as_ref().unwrap().join("state.json")).unwrap();
        assert_eq!(meta.permissions().mode() & 0o777, 0o600);
    }

    a.stop().await;
    b.stop().await;
    let mut a = Node::start_with(dir.path(), "a", true, None).await;
    let mut b = Node::start_with(dir.path(), "b", true, None).await;
    assert_eq!(a.id(), a_id, "same key, same EndpointId");
    assert_eq!(b.id(), b_id);
    let s = a.status().await;
    assert_eq!(s["fleet"][0]["id"], b_id);
    assert_eq!(s["links"][0]["name"], "echo");
    assert_eq!(b.status().await["exposures"][0]["name"], "echo");

    // The restored link uses a new ephemeral port (it asked for :0); the saved fleet entries carry
    // the old UDP ports, so refresh them as the agent would and check the path end to end.
    a.set_fleet(&[&b]).await;
    b.set_fleet(&[&a]).await;
    let listen: std::net::SocketAddr = a.status().await["links"][0]["bound"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    assert_eq!(round_trip(listen, b"after restart").await, b"after restart");
    a.stop().await;
    b.stop().await;
}

#[tokio::test]
async fn an_idle_connection_is_closed() {
    let dir = tempfile::tempdir().unwrap();
    let mut a = Node::start_with(dir.path(), "a", false, Some(Duration::from_millis(400))).await;
    let mut b = Node::start_with(dir.path(), "b", false, Some(Duration::from_millis(400))).await;
    let echo = echo_server().await;
    b.ok(json!({"v":1,"op":"expose","name":"echo","target":echo.to_string(),"allowed_peers":[a.id()]}))
        .await;
    a.set_fleet(&[&b]).await;
    b.set_fleet(&[&a]).await;
    let listen = a.link("echo", &b, "echo").await;
    let mut s = TcpStream::connect(listen).await.unwrap();
    s.write_all(b"hi").await.unwrap();
    let mut buf = [0u8; 2];
    s.read_exact(&mut buf).await.unwrap();
    let mut rest = Vec::new();
    let started = std::time::Instant::now();
    let r = tokio::time::timeout(Duration::from_secs(10), s.read_to_end(&mut rest))
        .await
        .expect("an idle connection must be closed");
    if let Ok(n) = r {
        assert_eq!(n, 0);
    }
    assert!(started.elapsed() >= Duration::from_millis(300));
    a.stop().await;
    b.stop().await;
}

#[tokio::test]
async fn bad_requests_get_errors_and_the_session_continues() {
    let dir = tempfile::tempdir().unwrap();
    let mut a = Node::start(dir.path(), "a").await;

    let cases = [
        ("not json", "bad_request"),
        (r#"[1,2]"#, "bad_request"),
        (r#"{"op":"status"}"#, "bad_request"),
        (r#"{"v":2,"op":"status"}"#, "unsupported_version"),
        (r#"{"v":1,"op":"launch"}"#, "bad_request"),
        (r#"{"v":1,"op":"expose","name":"x"}"#, "bad_request"),
        (
            r#"{"v":1,"op":"expose","name":"bad name","target":"127.0.0.1:80"}"#,
            "bad_request",
        ),
        (
            r#"{"v":1,"op":"link","name":"l","peer":"zz","service":"s","listen":"1"}"#,
            "bad_request",
        ),
        (
            r#"{"v":1,"op":"set_fleet","peers":[{"id":"nope"}]}"#,
            "bad_request",
        ),
        (
            r#"{"v":1,"op":"set_relays","relays":["not a url"]}"#,
            "bad_request",
        ),
    ];
    for (line, code) in cases {
        let r = a.raw(line).await;
        assert_eq!(r["ok"], false, "{line} -> {r}");
        assert_eq!(r["v"], 1);
        assert_eq!(r["error"]["code"], code, "{line} -> {r}");
        assert!(
            r["error"]["message"]
                .as_str()
                .is_some_and(|m| !m.is_empty())
        );
    }

    // One session: an error does not end it, and ids are echoed.
    use tokio::io::{AsyncBufReadExt, BufReader};
    let s = tokio::net::UnixStream::connect(&a.socket).await.unwrap();
    let (r, mut w) = s.into_split();
    let mut lines = BufReader::new(r).lines();
    w.write_all(b"{\"v\":1,\"op\":\"nope\",\"id\":\"x1\"}\n{\"v\":1,\"op\":\"status\",\"id\":2}\n")
        .await
        .unwrap();
    let first: serde_json::Value =
        serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
    let second: serde_json::Value =
        serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
    assert_eq!(first["id"], "x1");
    assert_eq!(first["ok"], false);
    assert_eq!(second["id"], 2);
    assert_eq!(second["ok"], true);
    assert_eq!(second["result"]["endpoint_id"], a.id());
    a.stop().await;
}

#[tokio::test]
async fn only_loopback_targets_may_be_exposed() {
    let dir = tempfile::tempdir().unwrap();
    let mut a = Node::start(dir.path(), "a").await;
    for target in [
        "10.0.0.1:5432",
        "0.0.0.0:80",
        "192.168.1.10:22",
        "localhost:80",
        "[::]:80",
        "8.8.8.8:53",
    ] {
        let r = a
            .call(json!({"v":1,"op":"expose","name":"x","target":target}))
            .await;
        assert_eq!(r["ok"], false, "{target} must be refused");
        assert_eq!(r["error"]["code"], "invalid_target", "{target}: {r}");
    }
    assert!(a.status().await["exposures"].as_array().unwrap().is_empty());
    a.ok(json!({"v":1,"op":"expose","name":"x","target":"127.0.0.1:5432"}))
        .await;
    a.stop().await;
}

#[tokio::test]
async fn a_link_may_listen_on_all_interfaces_when_asked() {
    let dir = tempfile::tempdir().unwrap();
    let (mut a, mut b, _) = linked_pair(dir.path()).await;
    let r = a
        .ok(json!({"v":1,"op":"link","name":"wide","peer":b.id(),"service":"echo","listen":"0.0.0.0:0"}))
        .await;
    let bound: std::net::SocketAddr = r["listen"].as_str().unwrap().parse().unwrap();
    assert!(bound.ip().is_unspecified());
    let via_loopback: std::net::SocketAddr = format!("127.0.0.1:{}", bound.port()).parse().unwrap();
    assert_eq!(round_trip(via_loopback, b"wide").await, b"wide");
    a.stop().await;
    b.stop().await;
}

#[tokio::test]
async fn the_control_socket_is_owner_and_group_only() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let mut a = Node::start(dir.path(), "a").await;
    let mode = std::fs::metadata(&a.socket).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o660);
    // A second daemon on the same socket refuses to start rather than stealing it.
    let mut cfg = config(dir.path(), "a", false);
    cfg.key_path = a.key.clone();
    let err = erainfra_mesh::daemon::Daemon::start(cfg)
        .await
        .err()
        .expect("must refuse");
    assert!(format!("{err:#}").contains("already serving"), "{err:#}");
    let socket = a.socket.clone();
    a.stop().await;
    assert!(!socket.exists(), "shutdown removes the socket");
}
