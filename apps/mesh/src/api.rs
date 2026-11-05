//! The control API: newline-delimited JSON over the local control socket.
//!
//! One request per line, one response per line, in order. Every request names the API version and
//! an operation: `{"v":1,"op":"status"}`. An optional `id` of any JSON type is echoed back so a
//! client can pipeline. Unknown fields are refused rather than ignored, so a misspelt optional
//! field fails loudly instead of silently taking its default.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};

use iroh::{EndpointAddr, EndpointId, RelayUrl, TransportAddr};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::API_VERSION;

/// Longest request line accepted, in bytes. A fleet list of a few thousand peers fits.
pub const MAX_REQUEST_BYTES: usize = 4 * 1024 * 1024;

/// Upper bound for a per-link or per-exposure connection limit.
pub const MAX_CONNECTIONS_LIMIT: u32 = 65_536;

/// Concurrent TCP connections a link or exposure carries when the request names no limit.
pub const DEFAULT_MAX_CONNECTIONS: u32 = 256;

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    Status,
    SetFleet {
        peers: Vec<PeerSpec>,
    },
    SetRelays {
        #[serde(default)]
        relays: Vec<String>,
        #[serde(default)]
        auth_token: Option<String>,
        #[serde(default)]
        n0_fallback: bool,
    },
    Expose {
        name: String,
        target: String,
        #[serde(default)]
        max_connections: Option<u32>,
    },
    Unexpose {
        name: String,
    },
    Link {
        name: String,
        peer: String,
        service: String,
        listen: String,
        #[serde(default)]
        max_connections: Option<u32>,
    },
    Unlink {
        name: String,
    },
}

/// A fleet member as the agent supplies it: its EndpointId and the addresses to dial it on.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PeerSpec {
    pub id: String,
    #[serde(default)]
    pub relay_urls: Vec<String>,
    #[serde(default)]
    pub direct_addrs: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct Response {
    pub v: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<Value>,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ApiError>,
}

impl Response {
    pub fn ok(id: Option<Value>, result: Value) -> Self {
        Self {
            v: API_VERSION,
            id,
            ok: true,
            result: Some(result),
            error: None,
        }
    }

    pub fn err(id: Option<Value>, error: ApiError) -> Self {
        Self {
            v: API_VERSION,
            id,
            ok: false,
            result: None,
            error: Some(error),
        }
    }
}

/// A failed request. `code` is stable and meant for programs; `message` is for people.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ApiError {
    pub code: &'static str,
    pub message: String,
}

impl ApiError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new("bad_request", message)
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

/// Splits a request line into its echo id and the operation, checking the version first.
///
/// The id is recovered even when the rest of the request is bad, so the error still reaches the
/// caller that sent it.
pub fn parse_request(line: &str) -> (Option<Value>, Result<Request, ApiError>) {
    let mut value: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => return (None, Err(ApiError::bad_request(format!("not JSON: {e}")))),
    };
    let Some(obj) = value.as_object_mut() else {
        return (
            None,
            Err(ApiError::bad_request("a request is a JSON object")),
        );
    };
    let id = obj.remove("id");
    match obj.remove("v") {
        Some(Value::Number(n)) if n.as_u64() == Some(u64::from(API_VERSION)) => {}
        Some(other) => {
            return (
                id,
                Err(ApiError::new(
                    "unsupported_version",
                    format!("this daemon speaks control API v{API_VERSION}, request has v={other}"),
                )),
            );
        }
        None => {
            return (
                id,
                Err(ApiError::bad_request(format!(
                    "missing \"v\"; send {{\"v\":{API_VERSION},\"op\":...}}"
                ))),
            );
        }
    }
    let req =
        serde_json::from_value::<Request>(value).map_err(|e| ApiError::bad_request(e.to_string()));
    (id, req)
}

/// Service, link and exposure names: 1 to 64 of `A-Z a-z 0-9 . _ -`.
///
/// Names cross the wire in the stream handshake and appear in logs, so they are kept to a set that
/// needs no escaping anywhere.
pub fn validate_name(kind: &str, name: &str) -> Result<(), ApiError> {
    let ok = !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'));
    if ok {
        Ok(())
    } else {
        Err(ApiError::bad_request(format!(
            "{kind} name {name:?} must be 1 to 64 characters of A-Z a-z 0-9 . _ -"
        )))
    }
}

/// Parses an exposure target. Only a literal loopback address with a non-zero port is accepted.
///
/// An exposure hands any fleet peer a TCP connection to its target, so a non-loopback target would
/// turn the Node into a relay into whatever network it sits on. Host names are refused too: what
/// `localhost` resolves to is configuration, not a guarantee.
pub fn parse_target(target: &str) -> Result<SocketAddr, ApiError> {
    let addr: SocketAddr = target.parse().map_err(|_| {
        ApiError::new(
            "invalid_target",
            format!("target {target:?} must be a literal loopback address and port, such as 127.0.0.1:5432"),
        )
    })?;
    if !addr.ip().is_loopback() {
        return Err(ApiError::new(
            "invalid_target",
            format!(
                "target {addr} is not a loopback address; only 127.0.0.0/8 and ::1 may be exposed"
            ),
        ));
    }
    if addr.port() == 0 {
        return Err(ApiError::new("invalid_target", "target port must not be 0"));
    }
    Ok(addr)
}

/// Parses a link's listen address: `PORT`, `:PORT`, or `IP:PORT`.
///
/// The address defaults to 127.0.0.1. Any other address, including 0.0.0.0, has to be written out,
/// which is how a caller opts in to letting containers on the Docker bridge reach the link.
pub fn parse_listen(listen: &str) -> Result<SocketAddr, ApiError> {
    let bad = || {
        ApiError::bad_request(format!(
            "listen {listen:?} must be PORT, :PORT or IP:PORT (for example 127.0.0.1:15432 or 0.0.0.0:15432)"
        ))
    };
    let port_only = listen.strip_prefix(':').unwrap_or(listen);
    if !port_only.is_empty() && port_only.bytes().all(|b| b.is_ascii_digit()) {
        let port: u16 = port_only.parse().map_err(|_| bad())?;
        return Ok(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port));
    }
    listen.parse().map_err(|_| bad())
}

/// Parses an EndpointId in iroh's hex (or base32) form.
pub fn parse_endpoint_id(s: &str) -> Result<EndpointId, ApiError> {
    s.parse()
        .map_err(|e| ApiError::bad_request(format!("{s:?} is not an EndpointId: {e}")))
}

/// Turns a fleet entry into the address iroh dials.
pub fn peer_addr(spec: &PeerSpec) -> Result<EndpointAddr, ApiError> {
    let id = parse_endpoint_id(&spec.id)?;
    let mut addrs = Vec::new();
    for url in &spec.relay_urls {
        let url: RelayUrl = url.parse().map_err(|e| {
            ApiError::bad_request(format!("peer {}: relay URL {url:?}: {e}", spec.id))
        })?;
        addrs.push(TransportAddr::Relay(url));
    }
    for addr in &spec.direct_addrs {
        let addr: SocketAddr = addr.parse().map_err(|_| {
            ApiError::bad_request(format!(
                "peer {}: direct address {addr:?} must be IP:PORT",
                spec.id
            ))
        })?;
        addrs.push(TransportAddr::Ip(addr));
    }
    Ok(EndpointAddr::from_parts(id, addrs))
}

/// The JSON shape of an EndpointAddr, the same one `set_fleet` accepts, so the agent can publish a
/// Node's `status.addr` to Convex and hand it to peers verbatim.
pub fn addr_json(addr: &EndpointAddr) -> PeerSpec {
    PeerSpec {
        id: addr.id.to_string(),
        relay_urls: addr.relay_urls().map(|u| u.to_string()).collect(),
        direct_addrs: addr.ip_addrs().map(|a| a.to_string()).collect(),
    }
}

/// Normalises a connection limit, applying the default and the ceiling.
pub fn max_connections(requested: Option<u32>) -> Result<u32, ApiError> {
    match requested {
        None => Ok(DEFAULT_MAX_CONNECTIONS),
        Some(0) => Err(ApiError::bad_request("max_connections must be at least 1")),
        Some(n) if n > MAX_CONNECTIONS_LIMIT => Err(ApiError::bad_request(format!(
            "max_connections must be at most {MAX_CONNECTIONS_LIMIT}"
        ))),
        Some(n) => Ok(n),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn targets_must_be_loopback_literals() {
        assert!(parse_target("127.0.0.1:5432").is_ok());
        assert!(parse_target("127.1.2.3:80").is_ok());
        assert!(parse_target("[::1]:80").is_ok());
        for bad in [
            "10.0.0.5:5432",
            "0.0.0.0:80",
            "localhost:80",
            "[::]:80",
            "127.0.0.1:0",
            "1.1.1.1:53",
        ] {
            let err = parse_target(bad).unwrap_err();
            assert_eq!(err.code, "invalid_target", "{bad}");
        }
    }

    #[test]
    fn listen_defaults_to_loopback() {
        assert_eq!(
            parse_listen("15432").unwrap(),
            "127.0.0.1:15432".parse().unwrap()
        );
        assert_eq!(
            parse_listen(":15432").unwrap(),
            "127.0.0.1:15432".parse().unwrap()
        );
        assert_eq!(
            parse_listen("0.0.0.0:80").unwrap(),
            "0.0.0.0:80".parse().unwrap()
        );
        assert!(parse_listen("nope").is_err());
        assert!(parse_listen("99999").is_err());
    }

    #[test]
    fn names_are_restricted() {
        assert!(validate_name("service", "pg-main_1.x").is_ok());
        assert!(validate_name("service", "").is_err());
        assert!(validate_name("service", "a b").is_err());
        assert!(validate_name("service", &"a".repeat(65)).is_err());
    }

    #[test]
    fn version_and_fields_are_checked() {
        let (id, r) = parse_request(r#"{"v":2,"op":"status","id":7}"#);
        assert_eq!(id, Some(Value::from(7)));
        assert_eq!(r.unwrap_err().code, "unsupported_version");
        assert_eq!(
            parse_request(r#"{"op":"status"}"#).1.unwrap_err().code,
            "bad_request"
        );
        assert!(parse_request(r#"{"v":1,"op":"status"}"#).1.is_ok());
        let typo = parse_request(
            r#"{"v":1,"op":"expose","name":"a","target":"127.0.0.1:1","max_conections":3}"#,
        );
        assert_eq!(typo.1.unwrap_err().code, "bad_request");
        assert!(parse_request(r#"{"v":1,"op":"launch"}"#).1.is_err());
        assert!(parse_request("[1]").1.is_err());
    }
}
