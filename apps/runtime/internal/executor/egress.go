package executor

// CheckEgressPolicy proves this Worker can enforce the Profile's egress: the
// policy is valid on this host and, for an audit or allowlist Profile, the host
// resolver is serving. A Worker that cannot install the resolver or the
// per-guest sets for an allowlist Profile fails it and is not ready for that
// Profile.
const CheckEgressPolicy = "egress-policy"

// Egress is the Profile egress half of the network evidence: what the Profile
// published, what the host operator overrides, and what one of its guests gets.
type Egress struct {
	// Mode is the effective mode, the stricter of HostMode and ProfileMode.
	Mode        string `json:"mode"`
	HostMode    string `json:"hostMode"`
	ProfileMode string `json:"profileMode"`
	// Presets, Domains and CIDRs are the Profile's published policy,
	// normalized. The control plane compares them with the Profile to prove
	// the Worker enforces the policy the Profile carries now.
	Presets []string `json:"presets,omitempty"`
	Domains []string `json:"domains,omitempty"`
	CIDRs   []string `json:"cidrs,omitempty"`
	// AllowedDomainCount is how many names the guest may resolve once presets
	// and the cache service are expanded.
	AllowedDomainCount int `json:"allowedDomainCount"`
}

// Verdicts on one DNS name or flow in an EgressRecord.
const (
	// EgressAllowed: the guest reached it, or the resolver answered it.
	EgressAllowed = "allowed"
	// EgressBlocked: an allowlist refused it.
	EgressBlocked = "blocked"
	// EgressUnlisted: an audit Profile reached it although its list does not
	// name it. Under allowlist it would have been blocked.
	EgressUnlisted = "unlisted"
)

// Bounds on one EgressRecord. A job that opens more distinct destinations
// than this is summarized, never allowed to grow the record without limit.
const (
	MaxEgressRecordNames = 256
	MaxEgressRecordFlows = 512
)

// EgressRecord is what one Attempt's guest talked to, measured on the host:
// the resolver saw its DNS and the kernel recorded its new flows. Nothing in it
// comes from inside the guest.
type EgressRecord struct {
	Mode  string           `json:"mode"`
	Names []EgressNameSeen `json:"names,omitempty"`
	Flows []EgressFlowSeen `json:"flows,omitempty"`
	// OmittedNames and OmittedFlows count distinct entries past the bounds.
	OmittedNames int `json:"omittedNames,omitempty"`
	OmittedFlows int `json:"omittedFlows,omitempty"`
	// Error names what could not be collected; the rest of the record is
	// still what was measured.
	Error string `json:"error,omitempty"`
}

// EgressNameSeen is one distinct DNS name a guest queried.
type EgressNameSeen struct {
	Name    string `json:"name"`
	Verdict string `json:"verdict"`
	Queries int    `json:"queries"`
}

// EgressFlowSeen is one distinct new flow a guest opened.
type EgressFlowSeen struct {
	Destination string `json:"destination"`
	Protocol    string `json:"protocol"`
	Port        int    `json:"port"`
	// Name is the DNS name the host resolver last answered with this address
	// for the guest, when there was one.
	Name    string `json:"name,omitempty"`
	Verdict string `json:"verdict"`
}
