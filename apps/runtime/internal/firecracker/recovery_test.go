package firecracker

import "testing"

func TestRecoveryPolicyUsesTheServersLiveSet(t *testing.T) {
	policy := newRecoveryPolicy([]string{"attempt-live", "experiment-live", "attempt-live"})

	for _, attemptID := range []string{"attempt-live", "experiment-live"} {
		if policy.recoverAttempt(attemptID) {
			t.Fatalf("live execution %q was selected for recovery", attemptID)
		}
	}
	for _, attemptID := range []string{"attempt-orphan", ""} {
		if !policy.recoverAttempt(attemptID) {
			t.Fatalf("orphaned execution %q was preserved", attemptID)
		}
	}
}

func TestRecoveryPolicySelectsOnlyEraInfraOrphanLeases(t *testing.T) {
	policy := newRecoveryPolicy([]string{"attempt-live"})
	tests := []struct {
		leaseID string
		recover bool
	}{
		{leaseID: "runner-center/attempts/attempt-live", recover: false},
		{leaseID: "runner-center/attempts/attempt-orphan", recover: true},
		{leaseID: "runner-center/warm/warm-1", recover: false},
		{leaseID: "unrelated/service/lease", recover: false},
	}
	for _, test := range tests {
		if got := policy.recoverLease(test.leaseID); got != test.recover {
			t.Fatalf("recoverLease(%q) = %t, want %t", test.leaseID, got, test.recover)
		}
	}
}

func TestStartupRecoverySelectsWarmCapacity(t *testing.T) {
	policy := newRecoveryPolicy(nil)
	if !policy.recoverLease("runner-center/warm/warm-1") ||
		!policy.recoverAttempt("warm-1") ||
		!policy.recoverWorkDir("warm-1-123456789") {
		t.Fatal("service-start recovery preserved abandoned warm capacity")
	}
}

func TestRecoveryPolicyPreservesOnlyLiveWorkDirectories(t *testing.T) {
	policy := newRecoveryPolicy([]string{"attempt-with-hyphens"})
	if policy.recoverWorkDir("attempt-with-hyphens-123456789") {
		t.Fatal("the live Attempt's work directory was selected for recovery")
	}
	if policy.recoverWorkDir("warm-1-123456789") {
		t.Fatal("Agent orphan recovery selected a runtime-owned parked VM")
	}
	for _, name := range []string{"attempt-orphan-123456789", "partial-start"} {
		if !policy.recoverWorkDir(name) {
			t.Fatalf("orphaned work directory %q was preserved", name)
		}
	}
}
