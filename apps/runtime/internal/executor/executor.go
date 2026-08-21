// Package executor defines the platform-neutral execution boundary shared by
// CI Jobs and interactive Experiments.
package executor

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
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
	// JobIdentity is empty unless this Attempt runs with the v2 job cache. The
	// host mints the Attempt's scoped cache bearer from it; empty mints nothing,
	// composing exactly the environment a fleet without a cache composes.
	JobIdentity JobIdentity
}

// JobIdentity carries the GitHub facts the job-cache interceptor mints a scoped
// bearer from (ADR 0009 §5): which repository this Attempt runs for, and enough
// of the event to decide read versus write. It mirrors cachetoken.JobFacts, but
// executor stays dependency-free — the host maps this to cachetoken.JobFacts
// where the bearer is actually minted. Every field is optional; a fleet without
// a cache leaves the whole struct zero.
type JobIdentity struct {
	Repository     string
	HeadRepository string
	Event          string
	Ref            string
	BaseRef        string
	DefaultBranch  string
	Attempt        string
}

// validate rejects values that cannot safely flow into a signed token and the
// guest's MMDS. Empty is always valid; a set field must be valid UTF-8, at most
// 256 runes, and every rune printable — no whitespace (ASCII or Unicode, e.g. a
// no-break space), no control character, nothing non-printable. The bound counts
// runes, not bytes, so a legitimate multibyte value is not rejected for its
// encoding length.
func (j JobIdentity) validate() error {
	for _, f := range []string{
		j.Repository, j.HeadRepository, j.Event,
		j.Ref, j.BaseRef, j.DefaultBranch, j.Attempt,
	} {
		if !utf8.ValidString(f) {
			return errors.New("job identity fields must be valid UTF-8")
		}
		if utf8.RuneCountInString(f) > 256 {
			return errors.New("job identity fields must be at most 256 characters")
		}
		if strings.ContainsFunc(f, func(r rune) bool {
			return unicode.IsSpace(r) || unicode.IsControl(r) || !unicode.IsPrint(r)
		}) {
			return errors.New("job identity fields must not contain whitespace, control, or non-printable characters")
		}
	}
	return nil
}

// Profile is the runtime-owned capacity contract for one immutable Image
// Release. WarmPool is explicit and defaults to zero.
type Profile struct {
	Name         string `json:"name"`
	ImageRelease string `json:"imageRelease"`
	VCPUs        int64  `json:"vcpus"`
	MemoryMiB    int64  `json:"memoryMiB"`
	WarmPool     int    `json:"warmPool"`
}

func (p Profile) Validate() error {
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
type WarmPoolStatus struct {
	Target  int    `json:"target"`
	Parked  int    `json:"parked"`
	Claimed int    `json:"claimed"`
	Healthy bool   `json:"healthy"`
	Detail  string `json:"detail,omitempty"`
}

func (s Spec) Validate() error {
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
	if err := s.JobIdentity.validate(); err != nil {
		return err
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
}

type Lease interface {
	Wait(ctx context.Context) (Result, error)
	Cancel(ctx context.Context) error
}

type Executor interface {
	// Preflight returns the full readiness Report even when it fails, so the
	// control plane can show which prerequisite is broken rather than only that
	// something is. A non-nil error always accompanies a Report that is not
	// Ready.
	Preflight(ctx context.Context) (Report, error)
	PrepareProfile(ctx context.Context, profile Profile) (WarmPoolStatus, error)
	RemoveProfile(ctx context.Context, profile string) error
	Shutdown(ctx context.Context) error
	Start(ctx context.Context, spec Spec) (Lease, error)
}
