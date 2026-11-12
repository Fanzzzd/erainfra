package convexnode

// DesiredMesh is a complete replacement snapshot, not an imperative command queue. Version 2 adds
// one listener form, `bridge:<port>`, bound on this Node's Docker bridge gateway (bridge.go);
// every other listener is a literal loopback address. RunMesh
// converts it into meshclient.Desired (decodeSnapshot) and hands it to meshclient's Reconciler,
// which removes names absent from the new snapshot. Relays is replaced by the Node's
// own relay policy before applying (MeshOptions.Relays).
type DesiredMesh struct {
	V         int            `json:"v"`
	Fleet     []MeshPeer     `json:"fleet"`
	Relays    MeshRelays     `json:"relays"`
	Exposures []MeshExposure `json:"exposures"`
	Links     []MeshLink     `json:"links"`
	// Ingress is present only when Convex marks this Node a gateway (ADR 0016 phase 3b). Its
	// routes travel under the same revision as the links that carry them.
	Ingress *MeshIngress `json:"ingress,omitempty"`
}

// MeshIngress is a gateway Node's route table.
type MeshIngress struct {
	Routes []IngressRoute `json:"routes"`
	// Overflow counts routes that did not fit this gateway's mesh link budget. They are in Routes
	// with no upstream (503), and the agent logs an error for every revision that has any.
	Overflow int `json:"overflow,omitempty"`
}

// IngressRoute maps a first-level label to the loopback address of this Node's ingress link (or
// of the App itself, when it runs on this Node). A nil Upstream is an App whose Node cannot be
// reached over the mesh right now.
type IngressRoute struct {
	Host     string  `json:"host"`
	Upstream *string `json:"upstream"`
}
type MeshPeer struct {
	ID          string   `json:"id"`
	RelayURLs   []string `json:"relay_urls"`
	DirectAddrs []string `json:"direct_addrs"`
}
type MeshRelays struct {
	Relays     []string `json:"relays"`
	N0Fallback bool     `json:"n0_fallback"`
}
type MeshExposure struct {
	Name         string   `json:"name"`
	Target       string   `json:"target"`
	AllowedPeers []string `json:"allowed_peers"` // nil and empty both mean deny all, never all fleet.
	// Set on ingress exposures; absent means the sidecar default.
	MaxConnections *uint32 `json:"max_connections,omitempty"`
}
type MeshLink struct {
	Name    string `json:"name"`
	Peer    string `json:"peer"`
	Service string `json:"service"`
	Listen  string `json:"listen"`
	// Set on ingress links; absent means the sidecar default.
	MaxConnections *uint32 `json:"max_connections,omitempty"`
}
