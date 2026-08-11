package executor

import (
	"fmt"
	"slices"
	"strings"
)

// Isolation names the technology that separates one job from the next. It is
// reported verbatim to the control plane and the dashboard so an operator can
// see the real boundary instead of inferring it from a Profile name.
const (
	IsolationFirecracker = "firecracker-microvm"
	IsolationDocker      = "docker-container"
)

// Boundary is the security claim behind an isolation technology. Only a
// GuestKernel boundary is safe for untrusted code; SharedKernel means the host
// kernel is the only thing between two jobs.
const (
	BoundaryGuestKernel  = "guest-kernel"
	BoundarySharedKernel = "shared-kernel"
)

// Check names. They are stable identifiers: the dashboard groups by them and an
// operator runbook refers to them, so renaming one is a product change.
const (
	CheckBinary      = "firecracker-binary"
	CheckKernelImage = "guest-kernel-image"
	CheckKernelArgs  = "guest-kernel-arguments"
	CheckKVM         = "kvm-device"
	CheckCNIPlugins  = "cni-plugins"
	CheckCNIConfig   = "cni-network-configuration"
	CheckNetPolicy   = "job-network-policy"
	CheckSnapshotter = "containerd-snapshotter"
	CheckStorage     = "snapshot-storage-headroom"
	CheckCache       = "cache-isolation"
	// CheckCNIReservations detects leaked guest addresses: every host-local
	// reservation must belong to a live Attempt lease, or the network state is
	// drifting and a restart (which runs Recover) is needed.
	CheckCNIReservations = "cni-address-reservations"
)

// Check is one named, independently reportable readiness condition.
type Check struct {
	Name   string `json:"name"`
	Passed bool   `json:"passed"`
	Detail string `json:"detail,omitempty"`
}

// Hardware is what the Worker can actually offer, measured rather than
// declared.
type Hardware struct {
	Arch      string `json:"arch"`
	CPUs      int    `json:"cpus"`
	MemoryMiB int64  `json:"memoryMiB"`
	CPUModel  string `json:"cpuModel,omitempty"`
	// Virtualization is the CPU extension backing KVM: vmx on Intel, svm on AMD.
	Virtualization string `json:"virtualization,omitempty"`
	KVM            bool   `json:"kvm"`
}

// Storage describes where per-Attempt copy-on-write roots come from. Free space
// is a first-class admission input: a full thin-pool fails jobs at boot.
type Storage struct {
	Snapshotter  string `json:"snapshotter"`
	PoolTotalMiB int64  `json:"poolTotalMiB"`
	PoolFreeMiB  int64  `json:"poolFreeMiB"`
}

// Network is the job network contract the Worker is enforcing right now.
type Network struct {
	PolicyName          string   `json:"policyName"`
	Subnet              string   `json:"subnet"`
	EgressMode          string   `json:"egressMode"`
	AllowedDestinations []string `json:"allowedDestinations,omitempty"`
}

// Cache describes what survives between jobs on this Worker. Anything writable
// and shared is a cross-job path, so the scope is reported, not assumed.
type Cache struct {
	// Scope is the sharing domain of any state a job can carry over, such as
	// "immutable-image" when nothing writable is shared at all.
	Scope string `json:"scope"`
	// SharedWritable is true when two jobs can write to the same storage. A
	// Profile that promises isolation must report false.
	SharedWritable bool   `json:"sharedWritable"`
	Detail         string `json:"detail,omitempty"`
}

// Report is the complete readiness answer for one Worker's executor.
type Report struct {
	Isolation string   `json:"isolation"`
	Boundary  string   `json:"boundary"`
	Checks    []Check  `json:"checks"`
	Hardware  Hardware `json:"hardware"`
	Storage   Storage  `json:"storage"`
	Network   Network  `json:"network"`
	Cache     Cache    `json:"cache"`
}

// Ready is true only when every check passed. There is no partial readiness:
// a Worker that advertises capacity it cannot isolate is worse than one that
// advertises none.
func (r Report) Ready() bool {
	return len(r.Checks) > 0 && !slices.ContainsFunc(r.Checks, func(check Check) bool {
		return !check.Passed
	})
}

// FailureSummary describes every failed check in one line, for an operator who
// sees only the error and not the structured report.
func (r Report) FailureSummary() string {
	var failures []string
	for _, check := range r.Checks {
		if check.Passed {
			continue
		}
		if check.Detail == "" {
			failures = append(failures, check.Name)
			continue
		}
		failures = append(failures, fmt.Sprintf("%s: %s", check.Name, check.Detail))
	}
	if len(failures) == 0 {
		return ""
	}
	return strings.Join(failures, "; ")
}

// Pass records a check that succeeded.
func (r *Report) Pass(name string, detail string) {
	r.Checks = append(r.Checks, Check{Name: name, Passed: true, Detail: detail})
}

// Fail records a check that did not succeed. Preflight keeps going after a
// failure so an operator sees every broken prerequisite at once instead of
// fixing them one round trip at a time.
func (r *Report) Fail(name string, err error) {
	detail := "failed"
	if err != nil {
		detail = err.Error()
	}
	r.Checks = append(r.Checks, Check{Name: name, Passed: false, Detail: detail})
}
