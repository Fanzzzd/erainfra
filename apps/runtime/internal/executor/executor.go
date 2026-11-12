// Package executor defines the platform-neutral execution boundary shared by
// CI Jobs and interactive Experiments.
package executor

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/Fanzzzd/erainfra/apps/runtime/internal/aptmirror"
	"github.com/Fanzzzd/erainfra/apps/runtime/internal/jobmetrics"
	"github.com/Fanzzzd/erainfra/apps/runtime/internal/netpolicy"
	"github.com/Fanzzzd/erainfra/apps/runtime/internal/registrymirror"
	"github.com/Fanzzzd/erainfra/apps/runtime/internal/runnerexit"
	"github.com/Fanzzzd/erainfra/apps/runtime/internal/testreport"
)

var (
	safeIdentity = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
	digestImage  = regexp.MustCompile(`@sha256:[a-f0-9]{64}$`)
)

type Spec struct {
	Kind         string
	AttemptID    string
	RunnerName   string
	Profile      string
	ImageRelease string
	VCPUs        int64
	MemoryMiB    int64
	JITConfig    string
	Command      []string
	ResultToken  string
	// The job cache endpoint this Worker offers, or empty. Empty is the
	// default and composes exactly the environment a fleet without a cache
	// composes. The rules mirror provision-docker.sh's, character for
	// character: one seam, two executors, one set of decisions (#81).
	CacheURL       string
	CacheServiceV2 string
	// CacheServiceURL is where the in-guest interceptor forwards CacheService
	// requests — EraInfra's cache service on the Worker's internal network, or
	// empty. It is operator configuration, not a secret, and empty composes
	// exactly the environment a fleet without a cache composes.
	CacheServiceURL string
	// CacheRunnerToken is the runner-auth bearer the host mints at claim, or
	// empty. It names only the runner, not a repository — a warm VM boots before
	// its repository is known — so the cache service scopes it at request time
	// from facts the controller pushed. The host sets it; a caller leaves it
	// empty, and empty composes exactly the environment a fleet without a cache
	// composes. It rides the same MMDS write as the rest of the metadata.
	CacheRunnerToken string
	// RegistryMirrorURL is the Worker's pull-through mirror for Docker Hub, or
	// empty. Like CacheServiceURL it is fleet-wide operator configuration the
	// host fills in at claim, and empty composes exactly the guest a fleet
	// without a mirror boots.
	RegistryMirrorURL string
	// AptMirrorURL is the Worker's apt HTTP proxy, or empty. Fleet-wide
	// operator configuration the host fills in at claim, like
	// RegistryMirrorURL; empty boots the guest a fleet without one boots.
	AptMirrorURL string
	// GitMirror turns on the in-guest git checkout mirror, which keeps its
	// seeds in the cache service at CacheServiceURL. Fleet-wide operator
	// configuration the host fills in at claim; false boots the guest a fleet
	// without it boots.
	GitMirror bool
	// Egress is the Profile's published egress policy. The zero value is
	// public egress, which is what a Profile without one means.
	Egress netpolicy.ProfileEgress
}

// Profile is the runtime-owned capacity contract for one immutable Image
// Release. WarmPool is explicit and defaults to zero.
type Profile struct {
	Name         string `json:"name"`
	ImageRelease string `json:"imageRelease"`
	VCPUs        int64  `json:"vcpus"`
	MemoryMiB    int64  `json:"memoryMiB"`
	WarmPool     int    `json:"warmPool"`
	// Egress is part of the contract a warm guest was booted under: a parked
	// guest is already in its Profile's per-guest sets.
	Egress netpolicy.ProfileEgress `json:"egress"`
}

func (p Profile) Validate() error {
	if err := p.Egress.Validate(); err != nil {
		return fmt.Errorf("egress: %w", err)
	}
	if strings.TrimSpace(p.Name) == "" {
		return errors.New("profile is required")
	}
	if !digestImage.MatchString(p.ImageRelease) {
		return errors.New("image release must be pinned by sha256 digest")
	}
	if p.VCPUs < 1 || p.VCPUs > 64 {
		return errors.New("vCPUs must be between 1 and 64")
	}
	if p.MemoryMiB < 512 || p.MemoryMiB > 262_144 {
		return errors.New("memory must be between 512 and 262144 MiB")
	}
	if p.WarmPool < 0 || p.WarmPool > 16 {
		return errors.New("warm pool must be between 0 and 16")
	}
	return nil
}

// WarmPoolStatus is resident capacity, so Target is always Parked + Claimed
// for a healthy pool.
// ImagePrune is what one Image Release prune kept and deleted, each sorted by name.
type ImagePrune struct {
	Kept    []string `json:"kept"`
	Deleted []string `json:"deleted"`
}

type WarmPoolStatus struct {
	Target  int    `json:"target"`
	Parked  int    `json:"parked"`
	Claimed int    `json:"claimed"`
	Healthy bool   `json:"healthy"`
	Detail  string `json:"detail,omitempty"`
	// RunnerVersion is the actions/runner release the Profile's image carries,
	// read from the image itself, or empty when the image does not say. It
	// never affects readiness: the control plane uses it only to warn before
	// GitHub stops serving that release.
	RunnerVersion string `json:"runnerVersion,omitempty"`
}

func (s Spec) Validate() error {
	if err := s.Egress.Validate(); err != nil {
		return fmt.Errorf("egress: %w", err)
	}
	if !safeIdentity.MatchString(s.AttemptID) {
		return errors.New("attempt ID must be a safe 1-128 character identity")
	}
	if !safeIdentity.MatchString(s.RunnerName) {
		return errors.New("runner name must be a safe 1-128 character identity")
	}
	if strings.TrimSpace(s.Profile) == "" {
		return errors.New("profile is required")
	}
	if !digestImage.MatchString(s.ImageRelease) {
		return errors.New("image release must be pinned by sha256 digest")
	}
	if s.VCPUs < 1 || s.VCPUs > 64 {
		return fmt.Errorf("vCPUs must be between 1 and 64")
	}
	if s.MemoryMiB < 512 || s.MemoryMiB > 262_144 {
		return fmt.Errorf("memory must be between 512 and 262144 MiB")
	}
	switch s.Kind {
	case "", "ci":
		if s.JITConfig == "" {
			return errors.New("JIT configuration is required for CI")
		}
		if len(s.Command) != 0 {
			return errors.New("CI must not carry an Experiment command")
		}
	case "experiment":
		if s.JITConfig != "" {
			return errors.New("an Experiment must not carry JIT configuration")
		}
		if len(s.Command) == 0 || len(s.Command) > 32 {
			return errors.New("an Experiment command requires 1-32 arguments")
		}
		if !safeIdentity.MatchString(s.ResultToken) {
			return errors.New("an Experiment result token must be a safe identity")
		}
	default:
		return errors.New("kind must be ci or experiment")
	}
	if err := validateCacheEndpoint(s.CacheURL, s.CacheServiceV2); err != nil {
		return err
	}
	if s.RegistryMirrorURL != "" {
		if err := registrymirror.Validate(s.RegistryMirrorURL); err != nil {
			return err
		}
	}
	if s.AptMirrorURL != "" {
		if err := aptmirror.Validate(s.AptMirrorURL); err != nil {
			return err
		}
	}
	return nil
}

// validateCacheEndpoint applies provision-docker.sh's rules to the same two
// values -- an absolute http(s) URL with no whitespace or control characters,
// and a flag that is exactly "true" or "false" -- plus one the shell's glob
// cannot express: the URL must name a host. "https://" satisfies a prefix
// check and configures nothing. A value with whitespace in it is not a URL;
// it is the shape that turns one environment entry into two somewhere
// downstream.
func validateCacheEndpoint(cacheURL, serviceV2 string) error {
	if cacheURL != "" {
		if !strings.HasPrefix(cacheURL, "http://") && !strings.HasPrefix(cacheURL, "https://") {
			return errors.New("cache URL must be an absolute http(s) URL")
		}
		_, rest, _ := strings.Cut(cacheURL, "://")
		if host, _, _ := strings.Cut(rest, "/"); host == "" {
			return errors.New("cache URL must name a host")
		}
		for _, r := range cacheURL {
			if r <= ' ' || r == 0x7f {
				return errors.New("cache URL must not contain whitespace or control characters")
			}
		}
	}
	switch serviceV2 {
	case "", "true", "false":
	default:
		return errors.New(`cache service v2 must be exactly "true" or "false"`)
	}
	return nil
}

type Result struct {
	ExitCode int
	// Egress is what the guest talked to, for an audit or allowlist Attempt,
	// and nil for a public one.
	Egress *EgressRecord
	// Tests is the JUnit results the guest reported for a CI Attempt, already
	// validated, or nil when it reported none or the executor collects none.
	Tests *testreport.Report
	// RunnerExit is how the GitHub runner of a CI Attempt ended, as its guest
	// reported it, already validated; nil when the guest reported nothing
	// (one that predates the report) or the executor collects none.
	RunnerExit *runnerexit.Report
}

type Lease interface {
	Wait(ctx context.Context) (Result, error)
	Cancel(ctx context.Context) error
}

// Measurable is a Lease whose boundary the host can measure from outside it.
// A Lease that is not Measurable still runs; its Attempt has no resource
// chart.
type Measurable interface {
	ResourceSource() (jobmetrics.Source, error)
}

type Executor interface {
	// Preflight returns the full readiness Report even when it fails, so the
	// control plane can show which prerequisite is broken rather than only that
	// something is. A non-nil error always accompanies a Report that is not
	// Ready. egress is the Profile's published egress policy; the report's
	// network evidence and egress-policy check are for that Profile.
	Preflight(ctx context.Context, egress netpolicy.ProfileEgress) (Report, error)
	PrepareProfile(ctx context.Context, profile Profile) (WarmPoolStatus, error)
	RemoveProfile(ctx context.Context, profile string) error
	Shutdown(ctx context.Context) error
	Start(ctx context.Context, spec Spec) (Lease, error)
}
