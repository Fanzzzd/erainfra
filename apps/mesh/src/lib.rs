//! `erainfra-mesh`: the Node-to-Node data plane of EraInfra (ADR 0016).
//!
//! One iroh endpoint per Node, with an identity that survives restarts, a fleet allowlist enforced
//! after the TLS handshake and before any application data, and TCP forwarding between a service a
//! Node exposes on loopback and a local listener on another Node. The Infra Agent drives it over a
//! local control socket; nothing here talks to Convex or to n0's discovery service.

pub mod api;
pub mod control;
pub mod daemon;
pub mod fleet;
pub mod key;
pub mod proxy;
pub mod state;

/// ALPN for TCP service links. The trailing number is the stream protocol version in
/// [`proxy`]: a peer speaking a different version fails the handshake instead of misparsing.
pub const ALPN_TCP: &[u8] = b"erainfra/tcp/1";

/// Version of the control API. Every request carries it and every response echoes it.
pub const API_VERSION: u32 = 1;
