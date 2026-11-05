package convexnode

// DesiredMesh is a complete replacement snapshot, not an imperative command queue. Version 2 adds
// one listener form, `bridge:<port>`, bound on this Node's Docker bridge gateway (bridge.go);
// every other listener is a literal loopback address. RunMesh
// converts it into meshclient.Desired (decodeSnapshot) and hands it to the same Reconciler Hub
// mode uses, which removes names absent from the new snapshot. Relays is replaced by the Node's
// own relay policy before applying (MeshOptions.Relays).
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
