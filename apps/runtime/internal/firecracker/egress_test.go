package firecracker

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/Fanzzzd/erainfra/apps/runtime/internal/executor"
	"github.com/Fanzzzd/erainfra/apps/runtime/internal/netpolicy"
)

var githubAllowlist = netpolicy.ProfileEgress{Mode: netpolicy.EgressAllowlist, Presets: []string{"github"}}

func healthy() error { return nil }

func TestEgressReadinessHashChangesWithTheProfilesEgress(t *testing.T) {
	host := netpolicy.DefaultPolicy("runner-center")
	public, publicCheck := egressReadiness(host, netpolicy.ProfileEgress{}, nil, healthy)
	audit, _ := egressReadiness(host, netpolicy.ProfileEgress{Mode: netpolicy.EgressAudit}, nil, healthy)
	allowlist, allowlistCheck := egressReadiness(host, githubAllowlist, nil, healthy)
	if !publicCheck.Passed || !allowlistCheck.Passed {
		t.Fatalf("both must pass on a healthy host: %+v %+v", publicCheck, allowlistCheck)
	}
	if public.PolicyHash == audit.PolicyHash || audit.PolicyHash == allowlist.PolicyHash ||
		public.PolicyHash == allowlist.PolicyHash {
		t.Fatal("each Profile egress must produce its own network policy identity")
	}
	if public.EgressMode != "public" || audit.EgressMode != "audit" || allowlist.EgressMode != "allowlist" {
		t.Fatalf("modes = %s %s %s", public.EgressMode, audit.EgressMode, allowlist.EgressMode)
	}
	if allowlist.Egress == nil || allowlist.Egress.ProfileMode != "allowlist" ||
		strings.Join(allowlist.Egress.Presets, ",") != "github" ||
		allowlist.Egress.AllowedDomainCount != len(netpolicy.GitHubPresetDomains) {
		t.Fatalf("allowlist evidence = %+v", allowlist.Egress)
	}
}

func TestEgressReadinessFailsClosedWithoutTheResolver(t *testing.T) {
	host := netpolicy.DefaultPolicy("runner-center")
	down := func() error { return errors.New("host resolver is not serving") }

	_, check := egressReadiness(host, githubAllowlist, nil, down)
	if check.Passed || check.Name != executor.CheckEgressPolicy || !strings.Contains(check.Detail, "resolver") {
		t.Fatalf("an allowlist Profile without its resolver must fail egress-policy, got %+v", check)
	}
	_, check = egressReadiness(host, netpolicy.ProfileEgress{Mode: netpolicy.EgressAudit}, nil, down)
	if check.Passed {
		t.Fatal("an audit Profile without its resolver records nothing and must not be ready")
	}
	// A public Profile needs neither, so a broken resolver must not take the
	// whole Worker down with it.
	_, check = egressReadiness(host, netpolicy.ProfileEgress{}, nil, down)
	if !check.Passed {
		t.Fatalf("a public Profile must stay ready without the resolver, got %+v", check)
	}
}

func TestEgressReadinessRefusesAPolicyThisHostCannotEnforce(t *testing.T) {
	host := netpolicy.DefaultPolicy("runner-center")
	network, check := egressReadiness(host, netpolicy.ProfileEgress{
		Mode: netpolicy.EgressAllowlist, CIDRs: []string{"10.241.9.0/24"},
	}, nil, healthy)
	if check.Passed {
		t.Fatal("an allowlist overlapping the guest subnet must fail readiness")
	}
	if network.Egress != nil {
		t.Fatal("evidence must not claim an egress policy the Worker cannot enforce")
	}
}

func TestEgressReadinessReportsTheHostOverride(t *testing.T) {
	host := netpolicy.DefaultPolicy("runner-center")
	host.EgressMode = netpolicy.EgressAudit
	network, check := egressReadiness(host, netpolicy.ProfileEgress{}, nil, healthy)
	if !check.Passed || network.EgressMode != "audit" || network.Egress.HostMode != "audit" ||
		network.Egress.ProfileMode != "public" {
		t.Fatalf("a public Profile on an audit host is audited, got %+v %+v", network, check)
	}
}

func TestWarmPoolReplacesParkedGuestsWhenTheProfilesEgressChanges(t *testing.T) {
	var mu sync.Mutex
	var booted []netpolicy.ProfileEgress
	pool := newWarmPoolManager(func(_ context.Context, profile executor.Profile, _ uint64) (warmSlot, error) {
		mu.Lock()
		booted = append(booted, profile.Egress)
		mu.Unlock()
		return newFakeWarmSlot(), nil
	})
	if _, err := pool.Configure(t.Context(), testProfile(1)); err != nil {
		t.Fatal(err)
	}
	locked := testProfile(1)
	locked.Egress = githubAllowlist
	if _, err := pool.Configure(t.Context(), locked); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	if len(booted) != 2 || booted[1].Mode != netpolicy.EgressAllowlist {
		t.Fatalf("a parked guest booted under public egress must be replaced, booted %+v", booted)
	}
	mu.Unlock()

	// An Attempt whose spec carries a different policy than the pool's must
	// not get a guest that sits in another policy's sets.
	if _, err := pool.Claim(t.Context(), testAttempt()); err == nil || errors.Is(err, errWarmPoolMiss) {
		t.Fatalf("claim with public egress from an allowlist pool = %v, want a contract error", err)
	}
	attempt := testAttempt()
	attempt.Egress = netpolicy.ProfileEgress{Mode: netpolicy.EgressAllowlist, Presets: []string{"GitHub"}}
	if _, err := pool.Claim(t.Context(), attempt); err != nil {
		t.Fatalf("an equal policy in another spelling must claim the parked guest: %v", err)
	}
}
