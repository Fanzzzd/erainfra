package firecracker

import (
	"strconv"
	"strings"
)

const attemptLeasePrefix = "runner-center/attempts/"
const warmLeasePrefix = "runner-center/warm/"

// recoveryPolicy is the server's authoritative view of which Attempts still
// belong on this Worker. Anything owned locally but absent from this set is an
// orphan and must be torn down before the Worker accepts replacement work.
type recoveryPolicy struct {
	live        map[string]struct{}
	fullRestart bool
}

func newRecoveryPolicy(liveAttemptIDs []string) recoveryPolicy {
	live := make(map[string]struct{}, len(liveAttemptIDs))
	for _, attemptID := range liveAttemptIDs {
		if attemptID != "" {
			live[attemptID] = struct{}{}
		}
	}
	return recoveryPolicy{live: live, fullRestart: liveAttemptIDs == nil}
}

func (p recoveryPolicy) recoverAttempt(attemptID string) bool {
	if isWarmVMID(attemptID) {
		return p.fullRestart
	}
	if attemptID == "" {
		return true
	}
	_, live := p.live[attemptID]
	return !live
}

func (p recoveryPolicy) recoverLease(leaseID string) bool {
	attemptID, found := strings.CutPrefix(leaseID, attemptLeasePrefix)
	if found {
		return p.recoverAttempt(attemptID)
	}
	_, warm := strings.CutPrefix(leaseID, warmLeasePrefix)
	return warm && p.fullRestart
}

// Work directories have the form <Attempt ID>-<random suffix>. A live ID is
// enough to preserve its directory; all other entries under the dedicated
// Attempts root are abandoned state.
func (p recoveryPolicy) recoverWorkDir(name string) bool {
	if rest, found := strings.CutPrefix(name, "warm-"); found {
		id, _, hasSuffix := strings.Cut(rest, "-")
		if hasSuffix {
			if _, err := strconv.ParseUint(id, 10, 64); err == nil {
				return p.fullRestart
			}
		}
	}
	for attemptID := range p.live {
		if strings.HasPrefix(name, attemptID+"-") {
			return false
		}
	}
	return true
}

func isWarmVMID(value string) bool {
	id, found := strings.CutPrefix(value, "warm-")
	if !found {
		return false
	}
	_, err := strconv.ParseUint(id, 10, 64)
	return err == nil
}
