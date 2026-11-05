//! The daemon: one iroh endpoint, the fleet allowlist, exposures, links and the control API.

use std::collections::{BTreeMap, HashMap};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use anyhow::{Context, Result};
use iroh::endpoint::{
    Connection, PortmapperConfig, QuicTransportConfig, RecvStream, SendStream, VarInt, presets,
};
use iroh::{Endpoint, EndpointAddr, EndpointId, RelayConfig, RelayMode, RelayUrl, Watcher};
use serde_json::{Value, json};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Semaphore, watch};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

use crate::api::{self, ApiError, PeerSpec, Request};
use crate::fleet::{Fleet, FleetHooks};
use crate::proxy::{self, ActiveGuard, Counters, StatusGate};
use crate::state::{Desired, ExposeSpec, LinkSpec, RelaysSpec, Store};
use crate::{ALPN_TCP, key};

/// Default for how long a forwarded TCP connection may carry no bytes in either direction.
///
/// An hour, not minutes: database clients keep pooled connections idle for long stretches, and a
/// proxy that cuts them causes errors the application then has to retry.
pub const DEFAULT_IDLE_TIMEOUT: Duration = Duration::from_secs(3600);

const DIAL_TIMEOUT: Duration = Duration::from_secs(15);
const TARGET_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Concurrent streams a peer may open on one connection. Links and exposures enforce their own
/// limits; this is the ceiling across all of them for one peer.
const MAX_STREAMS_PER_CONNECTION: u32 = 1024;

#[derive(Debug, Clone)]
pub struct Config {
    pub key_path: PathBuf,
    pub socket_path: PathBuf,
    pub state_dir: Option<PathBuf>,
    /// Test harnesses restrict endpoints to loopback. The daemon uses iroh's default
    /// interface binding and an ephemeral UDP port.
    #[doc(hidden)]
    pub loopback_only: bool,
    pub idle_timeout: Duration,
    /// Ask the local router for a port mapping (UPnP, PCP, NAT-PMP), which lets two NAT'd Nodes
    /// connect directly more often. On by default; off where SSDP multicast is unwelcome.
    pub portmapper: bool,
    /// Accept self-signed relay certificates. Exists only in unit-test builds, which run a relay
    /// on loopback; there is no way to turn it on in a shipped binary.
    #[cfg(test)]
    pub(crate) insecure_relay_tls: bool,
}

impl Config {
    pub fn new(key_path: PathBuf, socket_path: PathBuf) -> Self {
        Self {
            key_path,
            socket_path,
            state_dir: None,
            loopback_only: false,
            idle_timeout: DEFAULT_IDLE_TIMEOUT,
            portmapper: true,
            #[cfg(test)]
            insecure_relay_tls: false,
        }
    }
}

struct Exposure {
    target: SocketAddr,
    max_connections: u32,
    // Each authorization has its own cancellation generation. Streams clone the token under
    // this lock, so replacing the list cannot miss a stream admitted concurrently. Retained
    // peers keep their token; removed peers' tokens are cancelled before the update returns.
    allowed_peers: RwLock<BTreeMap<EndpointId, CancellationToken>>,
    counters: Arc<Counters>,
    slots: Arc<Semaphore>,
    cancel: CancellationToken,
}

impl Exposure {
    fn set_allowed_peers(&self, peers: BTreeMap<EndpointId, CancellationToken>) {
        let mut current = self.allowed_peers.write().expect("exposure access lock");
        let next = peers
            .into_iter()
            .map(|(id, token)| (id, current.remove(&id).unwrap_or(token)))
            .collect();
        for revoked in current.values() {
            revoked.cancel();
        }
        *current = next;
    }
}

struct LinkRuntime {
    spec: LinkSpec,
    peer: EndpointId,
    bound: SocketAddr,
    counters: Arc<Counters>,
    cancel: CancellationToken,
    task: JoinHandle<()>,
}

struct Inner {
    desired: Desired,
    links: HashMap<String, LinkRuntime>,
    /// What is in the endpoint's relay map because of `set_relays`.
    applied_relays: BTreeMap<RelayUrl, Arc<RelayConfig>>,
}

/// Outgoing connections, one per peer, reused by every link to that peer.
#[derive(Default)]
struct Pool {
    peers: Mutex<HashMap<EndpointId, Arc<tokio::sync::Mutex<Option<Connection>>>>>,
}

impl Pool {
    async fn get(
        &self,
        endpoint: &Endpoint,
        fleet: &Fleet,
        peer: EndpointId,
    ) -> Result<Connection> {
        let slot = self
            .peers
            .lock()
            .expect("pool lock")
            .entry(peer)
            .or_default()
            .clone();
        let mut slot = slot.lock().await;
        if let Some(conn) = slot.as_ref()
            && conn.close_reason().is_none()
        {
            return Ok(conn.clone());
        }
        // Dial only at the addresses the fleet list gives: no discovery service is configured, so
        // a peer outside the list has no address and the hook would refuse it anyway.
        let addr = fleet
            .addr(&peer)
            .with_context(|| format!("peer {} is not in the fleet", peer.fmt_short()))?;
        let conn = tokio::time::timeout(DIAL_TIMEOUT, endpoint.connect(addr, ALPN_TCP))
            .await
            .with_context(|| format!("timed out dialing {}", peer.fmt_short()))?
            .with_context(|| format!("cannot connect to {}", peer.fmt_short()))?;
        if !fleet.register(&conn) {
            anyhow::bail!("peer {} left the fleet while connecting", peer.fmt_short());
        }
        *slot = Some(conn.clone());
        Ok(conn)
    }

    fn forget(&self, peer: &EndpointId) {
        self.peers.lock().expect("pool lock").remove(peer);
    }
}

pub struct Daemon {
    endpoint: Arc<watch::Sender<Endpoint>>,
    fleet: Arc<Fleet>,
    pool: Arc<Pool>,
    exposures: Arc<RwLock<HashMap<String, Arc<Exposure>>>>,
    store: Option<Store>,
    idle: Duration,
    config: Config,
    inner: tokio::sync::Mutex<Inner>,
    shutdown: CancellationToken,
}

/// A started daemon. Dropping it does not stop it; call [`Running::shutdown`].
pub struct Running {
    pub daemon: Arc<Daemon>,
    control: JoinHandle<Result<()>>,
    accept: JoinHandle<()>,
}

impl Running {
    pub fn endpoint_id(&self) -> EndpointId {
        self.daemon.endpoint().id()
    }

    /// Resolves when the control server stops on its own (an error), so `main` can exit.
    pub async fn wait_control(&mut self) -> Result<()> {
        match (&mut self.control).await {
            Ok(r) => r,
            Err(e) => Err(anyhow::anyhow!("control server task failed: {e}")),
        }
    }

    /// Stops accepting control requests and new connections, closes every link and exposure, and
    /// closes the endpoint so peers see a clean close rather than a timeout.
    pub async fn shutdown(self) {
        self.daemon.shutdown.cancel();
        if !self.control.is_finished() {
            let _ = self.control.await;
        }
        {
            let mut inner = self.daemon.inner.lock().await;
            for (_, link) in inner.links.drain() {
                link.cancel.cancel();
                let _ = link.task.await;
            }
        }
        for exposure in self
            .daemon
            .exposures
            .write()
            .expect("exposures lock")
            .drain()
        {
            exposure.1.cancel.cancel();
        }
        self.daemon.endpoint().close().await;
        let _ = self.accept.await;
    }
}

impl Daemon {
    /// Loads the key, binds the endpoint, restores saved state and starts serving.
    pub async fn start(cfg: Config) -> Result<Running> {
        let secret = key::load(&cfg.key_path)?;
        let store = cfg.state_dir.as_deref().map(Store::new).transpose()?;
        let fleet = Arc::new(Fleet::default());

        let endpoint = bind_endpoint(&cfg, secret, fleet.clone(), RelayMode::Disabled).await?;
        info!(endpoint_id = %endpoint.id(), "endpoint bound");

        let daemon = Arc::new(Daemon {
            endpoint: Arc::new(watch::channel(endpoint).0),
            fleet,
            pool: Arc::new(Pool::default()),
            exposures: Default::default(),
            store,
            idle: cfg.idle_timeout,
            config: cfg.clone(),
            inner: tokio::sync::Mutex::new(Inner {
                desired: Desired::default(),
                links: HashMap::new(),
                applied_relays: BTreeMap::new(),
            }),
            shutdown: CancellationToken::new(),
        });

        daemon.restore().await;

        // Bind before returning so a caller (or a test) can connect as soon as start() is done.
        #[cfg(unix)]
        let control = {
            let listener = crate::control::bind_unix(&cfg.socket_path)?;
            let d = daemon.clone();
            let path = cfg.socket_path.clone();
            let token = daemon.shutdown.clone();
            tokio::spawn(async move { serve_unix(listener, path, d, token).await })
        };
        #[cfg(windows)]
        let control = {
            let d = daemon.clone();
            let path = cfg.socket_path.clone();
            let token = daemon.shutdown.clone();
            tokio::spawn(async move { crate::control::run_pipe(&path, d, token).await })
        };
        let accept = tokio::spawn(accept_loop(daemon.clone()));
        info!(socket = %cfg.socket_path.display(), "control API listening");
        Ok(Running {
            daemon,
            control,
            accept,
        })
    }

    pub fn endpoint(&self) -> Endpoint {
        self.endpoint.borrow().clone()
    }

    /// Re-applies the saved configuration. A saved entry that no longer applies (a port now taken,
    /// say) is logged and dropped rather than keeping the daemon from starting.
    async fn restore(&self) {
        let Some(store) = &self.store else { return };
        let saved = store.load();
        if saved == Desired::default() {
            return;
        }
        info!(
            peers = saved.fleet.len(),
            exposures = saved.exposures.len(),
            links = saved.links.len(),
            "restoring saved configuration"
        );
        let steps = std::iter::once(Request::SetRelays {
            relays: saved.relays.relays.clone(),
            auth_token: saved.relays.auth_token.clone(),
            n0_fallback: saved.relays.n0_fallback,
        })
        .chain(std::iter::once(Request::SetFleet {
            peers: saved.fleet.clone(),
        }))
        .chain(saved.exposures.iter().map(|(name, e)| Request::Expose {
            name: name.clone(),
            target: e.target.clone(),
            allowed_peers: e.allowed_peers.clone(),
            max_connections: Some(e.max_connections),
        }))
        .chain(saved.links.iter().map(|(name, l)| Request::Link {
            name: name.clone(),
            peer: l.peer.clone(),
            service: l.service.clone(),
            listen: l.listen.clone(),
            max_connections: Some(l.max_connections),
        }));
        for step in steps {
            if let Err(e) = self.handle(step).await {
                warn!(error = %e, "dropping a saved entry that no longer applies");
            }
        }
    }

    /// Applies one control request. Requests are serialized: each sees the result of the last.
    pub async fn handle(&self, req: Request) -> Result<Value, ApiError> {
        if self.shutdown.is_cancelled() {
            return Err(ApiError::new(
                "shutting_down",
                "the daemon is shutting down",
            ));
        }
        let mut inner = self.inner.lock().await;
        let before = inner.desired.clone();
        let result = match req {
            Request::Status => return Ok(self.status(&inner).await),
            Request::SetFleet { peers } => self.set_fleet(&mut inner, peers),
            Request::SetRelays {
                relays,
                auth_token,
                n0_fallback,
            } => {
                self.set_relays(
                    &mut inner,
                    RelaysSpec {
                        relays,
                        auth_token,
                        n0_fallback,
                    },
                )
                .await
            }
            Request::Expose {
                name,
                target,
                allowed_peers,
                max_connections,
            } => self.expose(&mut inner, name, target, allowed_peers, max_connections),
            Request::Unexpose { name } => self.unexpose(&mut inner, &name),
            Request::Link {
                name,
                peer,
                service,
                listen,
                max_connections,
            } => {
                self.link(&mut inner, name, peer, service, listen, max_connections)
                    .await
            }
            Request::Unlink { name } => self.unlink(&mut inner, &name).await,
        };
        if inner.desired != before
            && let Some(store) = &self.store
            && let Err(e) = store.save(&inner.desired)
        {
            warn!(error = %e, "cannot save state; the change is live but will not survive a restart");
        }
        result
    }

    fn set_fleet(&self, inner: &mut Inner, peers: Vec<PeerSpec>) -> Result<Value, ApiError> {
        let me = self.endpoint().id();
        let mut map = BTreeMap::new();
        let mut normalized = Vec::new();
        for spec in &peers {
            let addr = api::peer_addr(spec)?;
            if addr.id == me {
                // Convex lists every Node, this one included; it is not a peer of itself.
                continue;
            }
            if map.insert(addr.id, addr.clone()).is_some() {
                return Err(ApiError::bad_request(format!(
                    "peer {} is listed twice",
                    addr.id
                )));
            }
            normalized.push(api::addr_json(&addr));
        }
        normalized.sort_by(|a, b| a.id.cmp(&b.id));
        if normalized == inner.desired.fleet {
            return Ok(json!({ "changed": false, "peers": normalized.len() }));
        }
        let removed = self.fleet.replace(map);
        for id in &removed {
            self.pool.forget(id);
            info!(peer = %id, "peer removed from the fleet; its connections were closed");
        }
        let count = normalized.len();
        inner.desired.fleet = normalized;
        Ok(json!({
            "changed": true,
            "peers": count,
            "removed": removed.iter().map(|id| id.to_string()).collect::<Vec<_>>(),
        }))
    }

    async fn set_relays(&self, inner: &mut Inner, spec: RelaysSpec) -> Result<Value, ApiError> {
        let want = relay_configs(&spec)?;
        if spec == inner.desired.relays && want == inner.applied_relays {
            return Ok(json!({ "changed": false, "mode": relay_mode_name(&want) }));
        }
        // An empty RelayMap is not RelayMode::Disabled: iroh's relay actor will dial a
        // URL supplied by a peer even when it is not in its own map. Removing a relay also
        // leaves existing relay connections alive. Rebind for an effective configuration
        // change so disabling relays really removes the transport and no old token/relay
        // connection survives. The identity is unchanged; streams close and peers must
        // refresh our EndpointAddr after a rebind (as after a daemon restart).
        let old = self.endpoint();
        let secret = old.secret_key().clone();
        old.close().await;
        let mode = if want.is_empty() {
            RelayMode::Disabled
        } else {
            RelayMode::Custom(want.values().map(|c| c.as_ref().clone()).collect())
        };
        let endpoint = bind_endpoint(&self.config, secret, self.fleet.clone(), mode)
            .await
            .map_err(|e| {
                ApiError::new("endpoint_failed", format!("cannot rebind endpoint: {e:#}"))
            })?;
        self.endpoint.send_replace(endpoint);
        let mode = relay_mode_name(&want);
        info!(
            relays = ?spec.relays,
            auth_token = spec.auth_token.is_some(),
            n0_fallback = spec.n0_fallback,
            mode,
            "relays updated"
        );
        inner.applied_relays = want;
        inner.desired.relays = spec;
        Ok(json!({ "changed": true, "mode": mode }))
    }

    fn expose(
        &self,
        inner: &mut Inner,
        name: String,
        target: String,
        allowed_peers: Vec<String>,
        max_connections: Option<u32>,
    ) -> Result<Value, ApiError> {
        api::validate_name("service", &name)?;
        let target = api::parse_target(&target)?;
        let max = api::max_connections(max_connections)?;
        // Validate the whole set before changing anything. These are explicit grants, not
        // inferred from current fleet membership or from links configured on this Node.
        let peers = allowed_peers
            .iter()
            .map(|id| api::parse_endpoint_id(id).map(|id| (id, CancellationToken::new())))
            .collect::<Result<BTreeMap<_, _>, _>>()?;
        let spec = ExposeSpec {
            target: target.to_string(),
            max_connections: max,
            allowed_peers: peers.keys().map(ToString::to_string).collect(),
        };
        if inner.desired.exposures.get(&name) == Some(&spec) {
            return Ok(json!({ "changed": false }));
        }
        let existing = self
            .exposures
            .read()
            .expect("exposures lock")
            .get(&name)
            .cloned();
        if let Some(existing) = existing
            && existing.target == target
            && existing.max_connections == max
        {
            // Authorization-only updates revoke removed peers' streams while retaining the
            // other peers' streams and the exposure's counters.
            existing.set_allowed_peers(peers);
        } else {
            let exposure = Arc::new(Exposure {
                target,
                max_connections: max,
                allowed_peers: RwLock::new(peers),
                counters: Arc::new(Counters::default()),
                slots: Arc::new(Semaphore::new(max as usize)),
                cancel: CancellationToken::new(),
            });
            let old = self
                .exposures
                .write()
                .expect("exposures lock")
                .insert(name.clone(), exposure);
            if let Some(old) = old {
                old.cancel.cancel();
            }
        }
        info!(service = %name, %target, max_connections = max, allowed_peers = spec.allowed_peers.len(), "exposed");
        inner.desired.exposures.insert(name, spec);
        Ok(json!({ "changed": true }))
    }

    fn unexpose(&self, inner: &mut Inner, name: &str) -> Result<Value, ApiError> {
        let old = self.exposures.write().expect("exposures lock").remove(name);
        inner.desired.exposures.remove(name);
        match old {
            Some(old) => {
                old.cancel.cancel();
                info!(service = %name, "unexposed");
                Ok(json!({ "changed": true }))
            }
            None => Ok(json!({ "changed": false })),
        }
    }

    async fn link(
        &self,
        inner: &mut Inner,
        name: String,
        peer: String,
        service: String,
        listen: String,
        max_connections: Option<u32>,
    ) -> Result<Value, ApiError> {
        api::validate_name("link", &name)?;
        api::validate_name("service", &service)?;
        let peer_id = api::parse_endpoint_id(&peer)?;
        if peer_id == self.endpoint().id() {
            return Err(ApiError::bad_request(
                "a link cannot point at this Node itself",
            ));
        }
        let listen_addr = api::parse_listen(&listen)?;
        let max = api::max_connections(max_connections)?;
        let spec = LinkSpec {
            peer: peer_id.to_string(),
            service,
            listen: listen_addr.to_string(),
            max_connections: max,
        };
        if let Some(existing) = inner.links.get(&name)
            && existing.spec == spec
        {
            return Ok(json!({ "changed": false, "listen": existing.bound.to_string() }));
        }
        // Rebinding the same port needs the old listener gone first; a different port is bound
        // first so a failure leaves the old link serving.
        let same_addr = listen_addr.port() != 0
            && inner
                .links
                .get(&name)
                .is_some_and(|l| l.bound.port() == listen_addr.port());
        if same_addr && let Some(old) = inner.links.remove(&name) {
            old.cancel.cancel();
            let _ = old.task.await;
        }
        let listener = match TcpListener::bind(listen_addr).await {
            Ok(l) => l,
            Err(e) => {
                if same_addr {
                    inner.desired.links.remove(&name);
                }
                return Err(ApiError::new(
                    "listen_failed",
                    format!("cannot listen on {listen_addr}: {e}"),
                ));
            }
        };
        if let Some(old) = inner.links.remove(&name) {
            old.cancel.cancel();
            let _ = old.task.await;
        }
        let bound = listener
            .local_addr()
            .map_err(|e| ApiError::new("listen_failed", e.to_string()))?;
        let counters = Arc::new(Counters::default());
        let cancel = CancellationToken::new();
        let task = tokio::spawn(link_loop(LinkCtx {
            name: name.clone(),
            peer: peer_id,
            service: spec.service.clone(),
            listener,
            slots: Arc::new(Semaphore::new(max as usize)),
            counters: counters.clone(),
            cancel: cancel.clone(),
            endpoint: self.endpoint.clone(),
            fleet: self.fleet.clone(),
            pool: self.pool.clone(),
            idle: self.idle,
        }));
        info!(link = %name, peer = %peer_id.fmt_short(), service = %spec.service, listen = %bound, "linked");
        inner.links.insert(
            name.clone(),
            LinkRuntime {
                spec: spec.clone(),
                peer: peer_id,
                bound,
                counters,
                cancel,
                task,
            },
        );
        inner.desired.links.insert(name, spec);
        Ok(json!({ "changed": true, "listen": bound.to_string() }))
    }

    async fn unlink(&self, inner: &mut Inner, name: &str) -> Result<Value, ApiError> {
        inner.desired.links.remove(name);
        match inner.links.remove(name) {
            Some(old) => {
                old.cancel.cancel();
                let _ = old.task.await;
                info!(link = %name, "unlinked");
                Ok(json!({ "changed": true }))
            }
            None => Ok(json!({ "changed": false })),
        }
    }

    async fn status(&self, inner: &Inner) -> Value {
        let addr: EndpointAddr = self.endpoint().addr();
        let home: Vec<Value> = self
            .endpoint()
            .home_relay_status()
            .get()
            .into_iter()
            .map(|s| {
                json!({
                    "url": s.url().to_string(),
                    "connected": s.is_connected(),
                    "auth_denied": s.auth_denied_reason(),
                    "last_error": s.last_error().map(|e| e.to_string()),
                })
            })
            .collect();
        let conns = self.fleet.connection_counts();
        let fleet: Vec<Value> = self
            .fleet
            .snapshot()
            .keys()
            .map(|id| json!({ "id": id.to_string(), "connections": conns.get(id).copied().unwrap_or(0) }))
            .collect();
        let exposures: Vec<Value> = {
            let map = self.exposures.read().expect("exposures lock");
            let mut names: Vec<_> = map.keys().cloned().collect();
            names.sort();
            names
                .iter()
                .map(|name| {
                    let e = &map[name];
                    let allowed_peers = e
                        .allowed_peers
                        .read()
                        .expect("exposure access lock")
                        .keys()
                        .map(ToString::to_string)
                        .collect::<Vec<_>>();
                    let mut v = json!({
                        "name": name,
                        "target": e.target.to_string(),
                        "max_connections": e.max_connections,
                        "allowed_peers": allowed_peers,
                    });
                    merge(&mut v, e.counters.json());
                    v
                })
                .collect()
        };
        let mut names: Vec<_> = inner.links.keys().cloned().collect();
        names.sort();
        let links: Vec<Value> = names
            .iter()
            .map(|name| {
                let l = &inner.links[name];
                let mut v = json!({
                    "name": name,
                    "peer": l.spec.peer,
                    "peer_in_fleet": self.fleet.contains(&l.peer),
                    "service": l.spec.service,
                    "listen": l.spec.listen,
                    "bound": l.bound.to_string(),
                    "max_connections": l.spec.max_connections,
                });
                merge(&mut v, l.counters.json());
                v
            })
            .collect();
        json!({
            "version": env!("CARGO_PKG_VERSION"),
            "endpoint_id": self.endpoint().id().to_string(),
            "addr": api::addr_json(&addr),
            "relay": {
                "mode": relay_mode_name(&inner.applied_relays),
                "configured": inner.desired.relays.relays,
                "auth_token_set": inner.desired.relays.auth_token.is_some(),
                "n0_fallback": inner.desired.relays.n0_fallback,
                "home": home,
            },
            "fleet": fleet,
            "fleet_rejections": self.fleet.rejected(),
            "exposures": exposures,
            "links": links,
        })
    }
}

/// Minimal has no discovery or relay preset. Disabled must remove the relay transport, not
/// merely give it an empty map: the latter still dials peer-provided relay URLs in iroh 1.4.
async fn bind_endpoint(
    cfg: &Config,
    secret: iroh::SecretKey,
    fleet: Arc<Fleet>,
    relays: RelayMode,
) -> Result<Endpoint> {
    let transport = QuicTransportConfig::builder()
        .max_concurrent_bidi_streams(VarInt::from_u32(MAX_STREAMS_PER_CONNECTION))
        .max_concurrent_uni_streams(VarInt::from_u32(0))
        .build();
    let mut builder = Endpoint::builder(presets::Minimal)
        .secret_key(secret)
        .alpns(vec![ALPN_TCP.to_vec()])
        .relay_mode(relays)
        .transport_config(transport)
        .hooks(FleetHooks(fleet));
    if !cfg.portmapper {
        builder = builder.portmapper_config(PortmapperConfig::Disabled);
    }
    if cfg.loopback_only {
        builder = builder.clear_ip_transports().bind_addr("127.0.0.1:0")?;
    }
    #[cfg(test)]
    if cfg.insecure_relay_tls {
        builder = builder.ca_tls_config(iroh::tls::CaTlsConfig::insecure_skip_verify());
    }
    builder
        .bind()
        .await
        .context("cannot bind the iroh endpoint")
}

/// The relay map a `set_relays` request asks for.
///
/// iroh keeps relays in a map and picks the home relay by measured latency, so the order of the
/// list is kept for `status` but does not rank relays. The auth token goes to the configured
/// relays only. n0's public relays are added only when `n0_fallback` is set, and never receive the
/// token: it authorizes the fleet's relays, not theirs.
pub(crate) fn relay_configs(
    spec: &RelaysSpec,
) -> Result<BTreeMap<RelayUrl, Arc<RelayConfig>>, ApiError> {
    if spec.auth_token.as_deref() == Some("") {
        return Err(ApiError::bad_request(
            "auth_token must not be empty; omit it instead",
        ));
    }
    let mut want = BTreeMap::new();
    for raw in &spec.relays {
        let url: RelayUrl = raw
            .parse()
            .map_err(|e| ApiError::bad_request(format!("relay URL {raw:?}: {e}")))?;
        match url.scheme() {
            "https" => {}
            "http" if spec.auth_token.is_none() => {}
            "http" => {
                return Err(ApiError::bad_request(format!(
                    "relay {raw} is plain http; refusing to send the relay auth token over it"
                )));
            }
            other => {
                return Err(ApiError::bad_request(format!(
                    "relay {raw} has scheme {other:?}; use https"
                )));
            }
        }
        let mut config = RelayConfig::from(url.clone());
        if let Some(token) = &spec.auth_token {
            config = config.with_auth_token(token.clone());
        }
        want.insert(url, Arc::new(config));
    }
    if spec.n0_fallback {
        for config in iroh::defaults::prod::default_relay_map().relays::<Vec<_>>() {
            want.entry(config.url.clone()).or_insert(config);
        }
    }
    Ok(want)
}

fn relay_mode_name(relays: &BTreeMap<RelayUrl, Arc<RelayConfig>>) -> &'static str {
    if relays.is_empty() {
        "direct_only"
    } else {
        "relays"
    }
}

fn merge(into: &mut Value, from: Value) {
    if let (Some(a), Value::Object(b)) = (into.as_object_mut(), from) {
        a.extend(b);
    }
}

#[cfg(unix)]
async fn serve_unix(
    listener: tokio::net::UnixListener,
    path: PathBuf,
    daemon: Arc<Daemon>,
    shutdown: CancellationToken,
) -> Result<()> {
    loop {
        tokio::select! {
            _ = shutdown.cancelled() => break,
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => { tokio::spawn(crate::control::serve_client(stream, daemon.clone())); }
                Err(e) => {
                    warn!(error = %e, "control socket accept failed");
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            },
        }
    }
    let _ = std::fs::remove_file(&path);
    Ok(())
}

async fn accept_loop(daemon: Arc<Daemon>) {
    let mut endpoints = daemon.endpoint.subscribe();
    loop {
        let endpoint = endpoints.borrow_and_update().clone();
        let incoming = tokio::select! {
            _ = daemon.shutdown.cancelled() => break,
            changed = endpoints.changed() => {
                if changed.is_err() { break; }
                continue;
            }
            incoming = endpoint.accept() => incoming,
        };
        let Some(incoming) = incoming else {
            // The endpoint closes before the replacement binds. Wait for its generation,
            // without spinning on the closed endpoint or preventing shutdown.
            tokio::select! {
                _ = daemon.shutdown.cancelled() => break,
                changed = endpoints.changed() => if changed.is_err() { break; },
            }
            continue;
        };
        let daemon = daemon.clone();
        tokio::spawn(async move {
            // The fleet hook has already run by the time this resolves; a peer outside the fleet
            // surfaces here as a handshake error.
            let conn = match incoming.await {
                Ok(c) => c,
                Err(e) => {
                    debug!(error = %e, "incoming connection failed");
                    return;
                }
            };
            if conn.alpn() != ALPN_TCP || !daemon.fleet.register(&conn) {
                conn.close(
                    VarInt::from_u32(crate::fleet::CLOSE_NOT_IN_FLEET),
                    b"refused",
                );
                return;
            }
            let peer = conn.remote_id();
            debug!(peer = %peer.fmt_short(), "peer connected");
            loop {
                match conn.accept_bi().await {
                    Ok((send, recv)) => {
                        let exposures = daemon.exposures.clone();
                        let fleet = daemon.fleet.clone();
                        let idle = daemon.idle;
                        tokio::spawn(serve_stream(peer, send, recv, exposures, fleet, idle));
                    }
                    Err(e) => {
                        debug!(peer = %peer.fmt_short(), error = %e, "peer connection ended");
                        return;
                    }
                }
            }
        });
    }
}

/// Serves one inbound stream: reads the header, checks the service, connects the target.
async fn serve_stream(
    peer: EndpointId,
    mut send: SendStream,
    mut recv: RecvStream,
    exposures: Arc<RwLock<HashMap<String, Arc<Exposure>>>>,
    fleet: Arc<Fleet>,
    idle: Duration,
) {
    let service =
        match tokio::time::timeout(proxy::HEADER_TIMEOUT, proxy::read_header(&mut recv)).await {
            Ok(Ok(s)) => s,
            _ => {
                let _ = send.reset(VarInt::from_u32(1));
                return;
            }
        };
    let exposure = exposures
        .read()
        .expect("exposures lock")
        .get(&service)
        .cloned();
    let Some(exposure) = exposure else {
        warn!(peer = %peer.fmt_short(), %service, "peer asked for a service this Node does not expose");
        refuse(&mut send, &mut recv, proxy::STATUS_UNKNOWN_SERVICE).await;
        return;
    };
    let grant = exposure
        .allowed_peers
        .read()
        .expect("exposure access lock")
        .get(&peer)
        .cloned();
    let Some(grant) = grant.filter(|_| fleet.contains(&peer)) else {
        exposure
            .counters
            .connections_refused
            .fetch_add(1, Ordering::Relaxed);
        warn!(peer = %peer.fmt_short(), %service, "peer is not authorized for this exposure");
        refuse(&mut send, &mut recv, proxy::STATUS_FORBIDDEN).await;
        return;
    };
    // The grant covers the entire lifetime, including target connection and the status byte.
    // Checking before connecting prevents an unauthorized fleet peer from touching the target.
    tokio::select! {
        biased;
        _ = grant.cancelled() => {}
        _ = exposure.cancel.cancelled() => {}
        _ = serve_authorized_stream(peer, &service, send, recv, &exposure, idle) => {}
    }
}

async fn serve_authorized_stream(
    peer: EndpointId,
    service: &str,
    mut send: SendStream,
    mut recv: RecvStream,
    exposure: &Exposure,
    idle: Duration,
) {
    let Ok(_permit) = exposure.slots.clone().try_acquire_owned() else {
        exposure
            .counters
            .connections_refused
            .fetch_add(1, Ordering::Relaxed);
        warn!(peer = %peer.fmt_short(), %service, "exposure at its connection limit");
        refuse(&mut send, &mut recv, proxy::STATUS_BUSY).await;
        return;
    };
    let tcp = match tokio::time::timeout(
        TARGET_CONNECT_TIMEOUT,
        TcpStream::connect(exposure.target),
    )
    .await
    {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => {
            exposure
                .counters
                .connections_refused
                .fetch_add(1, Ordering::Relaxed);
            warn!(%service, target = %exposure.target, error = %e, "cannot reach the exposed target");
            refuse(&mut send, &mut recv, proxy::STATUS_TARGET_UNREACHABLE).await;
            return;
        }
        Err(_) => {
            exposure
                .counters
                .connections_refused
                .fetch_add(1, Ordering::Relaxed);
            warn!(%service, target = %exposure.target, "timed out reaching the exposed target");
            refuse(&mut send, &mut recv, proxy::STATUS_TARGET_UNREACHABLE).await;
            return;
        }
    };
    let _ = tcp.set_nodelay(true);
    if send.write_all(&[proxy::STATUS_OK]).await.is_err() {
        return;
    }
    let _active = ActiveGuard::new(exposure.counters.clone());
    let (tr, tw) = tcp.into_split();
    if let Err(e) = proxy::splice(tr, tw, recv, send, &exposure.counters, idle).await {
        debug!(peer = %peer.fmt_short(), %service, error = %e, "stream ended");
    }
}

async fn refuse(send: &mut SendStream, recv: &mut RecvStream, status: u8) {
    let _ = send.write_all(&[status]).await;
    let _ = send.finish();
    let _ = recv.stop(VarInt::from_u32(u32::from(status)));
    // Let the status byte reach the peer before the stream is dropped.
    let _ = tokio::time::timeout(Duration::from_secs(5), send.stopped()).await;
}

struct LinkCtx {
    name: String,
    peer: EndpointId,
    service: String,
    listener: TcpListener,
    slots: Arc<Semaphore>,
    counters: Arc<Counters>,
    cancel: CancellationToken,
    endpoint: Arc<watch::Sender<Endpoint>>,
    fleet: Arc<Fleet>,
    pool: Arc<Pool>,
    idle: Duration,
}

async fn link_loop(ctx: LinkCtx) {
    let ctx = Arc::new(ctx);
    let mut tasks = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            _ = ctx.cancel.cancelled() => break,
            Some(_) = tasks.join_next(), if !tasks.is_empty() => {}
            accepted = ctx.listener.accept() => {
                let (tcp, from) = match accepted {
                    Ok(a) => a,
                    Err(e) => {
                        warn!(link = %ctx.name, error = %e, "accept failed");
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        continue;
                    }
                };
                let Ok(permit) = ctx.slots.clone().try_acquire_owned() else {
                    ctx.counters.connections_refused.fetch_add(1, Ordering::Relaxed);
                    warn!(link = %ctx.name, %from, "link at its connection limit; refusing a connection");
                    drop(tcp);
                    continue;
                };
                let ctx = ctx.clone();
                tasks.spawn(async move {
                    let _permit = permit;
                    forward(&ctx, tcp).await;
                });
            }
        }
    }
    // Dropping the JoinSet aborts every forwarded connection of this link.
    tasks.shutdown().await;
}

async fn forward(ctx: &LinkCtx, tcp: TcpStream) {
    let _ = tcp.set_nodelay(true);
    let _active = ActiveGuard::new(ctx.counters.clone());
    let endpoint = ctx.endpoint.borrow().clone();
    let conn = match ctx.pool.get(&endpoint, &ctx.fleet, ctx.peer).await {
        Ok(c) => c,
        Err(e) => {
            ctx.counters
                .connections_refused
                .fetch_add(1, Ordering::Relaxed);
            warn!(link = %ctx.name, error = %format!("{e:#}"), "cannot reach the peer");
            return;
        }
    };
    let (mut send, recv) = match conn.open_bi().await {
        Ok(s) => s,
        Err(e) => {
            ctx.counters
                .connections_refused
                .fetch_add(1, Ordering::Relaxed);
            warn!(link = %ctx.name, error = %e, "cannot open a stream to the peer");
            return;
        }
    };
    if let Err(e) = proxy::write_header(&mut send, &ctx.service).await {
        ctx.counters
            .connections_refused
            .fetch_add(1, Ordering::Relaxed);
        warn!(link = %ctx.name, error = %e, "cannot open a stream to the peer");
        return;
    }
    let (tr, tw) = tcp.into_split();
    let gate = StatusGate::new(recv);
    let answer = gate.answer();
    let result = proxy::splice(tr, tw, gate, send, &ctx.counters, ctx.idle).await;
    match (answer.get().copied(), result) {
        (Some(proxy::STATUS_OK), Ok(())) => {}
        (Some(proxy::STATUS_OK), Err(e)) => {
            debug!(link = %ctx.name, error = %e, "forwarded connection ended");
        }
        (Some(status), _) => {
            ctx.counters
                .connections_refused
                .fetch_add(1, Ordering::Relaxed);
            warn!(link = %ctx.name, service = %ctx.service, reason = proxy::status_text(status), "peer refused the stream");
        }
        (None, result) => {
            // The peer never accepted the stream. When it is not in the peer's fleet, this is
            // where that shows: the peer closes the connection right after the handshake.
            ctx.counters
                .connections_refused
                .fetch_add(1, Ordering::Relaxed);
            let error = result.err().map(|e| e.to_string()).unwrap_or_default();
            warn!(link = %ctx.name, service = %ctx.service, %error, "peer closed the stream without accepting it");
        }
    }
}

#[cfg(test)]
mod tests;
