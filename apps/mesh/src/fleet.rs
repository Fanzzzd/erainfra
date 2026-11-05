//! The fleet allowlist and its enforcement.
//!
//! [`Fleet`] holds the EndpointIds allowed to connect and the addresses to dial them on. It is
//! enforced at three points, so no single missed check opens the Node:
//!
//! 1. [`FleetHooks::before_connect`] refuses to dial a peer outside the fleet, before any packet.
//! 2. [`FleetHooks::after_handshake`] closes any connection, inbound or outbound, whose
//!    authenticated EndpointId is outside the fleet. That runs after TLS has proven the peer's key
//!    and before either side can open a stream, so no application data is exchanged.
//! 3. [`Fleet::replace`] closes live connections to peers that were just removed. A connection
//!    that passed the hook a moment before the change is caught by the re-check in
//!    [`Fleet::register`].

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use iroh::endpoint::{
    AfterHandshakeOutcome, BeforeConnectOutcome, Connection, EndpointHooks, VarInt,
    WeakConnectionHandle,
};
use iroh::{EndpointAddr, EndpointId};

/// QUIC application close code sent to a peer outside the fleet.
pub const CLOSE_NOT_IN_FLEET: u32 = 403;

#[derive(Debug, Default)]
pub struct Fleet {
    peers: RwLock<BTreeMap<EndpointId, EndpointAddr>>,
    conns: Mutex<HashMap<EndpointId, Vec<WeakConnectionHandle>>>,
    rejected: AtomicU64,
}

impl Fleet {
    /// Handshakes refused because the peer was outside the fleet, since start.
    pub fn rejected(&self) -> u64 {
        self.rejected.load(Ordering::Relaxed)
    }

    pub fn contains(&self, id: &EndpointId) -> bool {
        self.peers.read().expect("fleet lock").contains_key(id)
    }

    pub fn addr(&self, id: &EndpointId) -> Option<EndpointAddr> {
        self.peers.read().expect("fleet lock").get(id).cloned()
    }

    pub fn snapshot(&self) -> BTreeMap<EndpointId, EndpointAddr> {
        self.peers.read().expect("fleet lock").clone()
    }

    /// Replaces the whole allowlist and returns the ids that were removed.
    ///
    /// The new list takes effect for every later handshake before this returns. Connections to the
    /// removed ids are then closed.
    pub fn replace(&self, next: BTreeMap<EndpointId, EndpointAddr>) -> Vec<EndpointId> {
        let removed: Vec<EndpointId> = {
            let mut peers = self.peers.write().expect("fleet lock");
            let removed = peers
                .keys()
                .filter(|id| !next.contains_key(*id))
                .copied()
                .collect();
            *peers = next;
            removed
        };
        for id in &removed {
            self.close_peer(id);
        }
        removed
    }

    /// Tracks a live connection so a later removal can close it.
    ///
    /// Returns false, having closed the connection, if the peer left the fleet between the
    /// handshake hook and this call.
    pub fn register(&self, conn: &Connection) -> bool {
        let id = conn.remote_id();
        {
            let mut conns = self.conns.lock().expect("conn lock");
            let list = conns.entry(id).or_default();
            list.retain(|w| w.upgrade().is_some());
            list.push(conn.weak_handle());
        }
        if !self.contains(&id) {
            conn.close(VarInt::from_u32(CLOSE_NOT_IN_FLEET), b"not in fleet");
            return false;
        }
        true
    }

    fn close_peer(&self, id: &EndpointId) {
        let list = self.conns.lock().expect("conn lock").remove(id);
        for weak in list.into_iter().flatten() {
            if let Some(conn) = weak.upgrade() {
                conn.close(VarInt::from_u32(CLOSE_NOT_IN_FLEET), b"removed from fleet");
            }
        }
    }

    /// Number of live connections per peer, for `status`.
    pub fn connection_counts(&self) -> BTreeMap<EndpointId, usize> {
        let mut conns = self.conns.lock().expect("conn lock");
        let mut out = BTreeMap::new();
        conns.retain(|id, list| {
            list.retain(|w| w.upgrade().is_some_and(|c| c.close_reason().is_none()));
            if !list.is_empty() {
                out.insert(*id, list.len());
            }
            !list.is_empty()
        });
        out
    }
}

/// The endpoint hooks that enforce the allowlist. Holds only the [`Fleet`], never the endpoint,
/// as iroh requires to avoid a reference cycle.
#[derive(Debug, Clone)]
pub struct FleetHooks(pub Arc<Fleet>);

impl EndpointHooks for FleetHooks {
    fn before_connect<'a>(
        &'a self,
        remote_addr: &'a EndpointAddr,
        _alpn: &'a [u8],
    ) -> impl Future<Output = BeforeConnectOutcome> + Send + 'a {
        let allowed = self.0.contains(&remote_addr.id);
        async move {
            if allowed {
                BeforeConnectOutcome::Accept
            } else {
                tracing::warn!(peer = %remote_addr.id.fmt_short(), "refused to dial a peer outside the fleet");
                BeforeConnectOutcome::Reject
            }
        }
    }

    fn after_handshake<'a>(
        &'a self,
        conn: &'a Connection,
    ) -> impl Future<Output = AfterHandshakeOutcome> + Send + 'a {
        let peer = conn.remote_id();
        let allowed = self.0.contains(&peer);
        async move {
            if allowed {
                AfterHandshakeOutcome::Accept
            } else {
                self.0.rejected.fetch_add(1, Ordering::Relaxed);
                tracing::warn!(peer = %peer, "rejected a peer outside the fleet after the handshake");
                AfterHandshakeOutcome::Reject {
                    error_code: VarInt::from_u32(CLOSE_NOT_IN_FLEET),
                    reason: b"not in fleet".to_vec(),
                }
            }
        }
    }
}
