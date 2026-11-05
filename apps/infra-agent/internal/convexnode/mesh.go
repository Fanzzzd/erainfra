package convexnode

// DesiredMesh is a complete replacement snapshot, not an imperative command queue. The phase-1b
// meshclient adapter can map Fleet/Relays to set_fleet/set_relays and each exposure/link to the
// identically named NDJSON v1 operation, removing names absent from the new snapshot. The
// connect-convex transport only persists this snapshot in phase 2b; it does not drive a sidecar.
type DesiredMesh struct {
	V         int            `json:"v"`
	Fleet     []MeshPeer     `json:"fleet"`
	Relays    MeshRelays     `json:"relays"`
	Exposures []MeshExposure `json:"exposures"`
	Links     []MeshLink     `json:"links"`
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
}
type MeshLink struct {
	Name    string `json:"name"`
	Peer    string `json:"peer"`
	Service string `json:"service"`
	Listen  string `json:"listen"`
}
