package firecracker

import "strings"

const attemptLeasePrefix = "runner-center/attempts/"

// recoveryPolicy is the server's authoritative view of which Attempts still
// belong on this Worker. Anything owned locally but absent from this set is an
// orphan and must be torn down before the Worker accepts replacement work.
type recoveryPolicy struct {
	live map[string]struct{}
}

func newRecoveryPolicy(liveAttemptIDs []string) recoveryPolicy {
	live := make(map[string]struct{}, len(liveAttemptIDs))
	for _, attemptID := range liveAttemptIDs {
		if attemptID != "" {
			live[attemptID] = struct{}{}
		}
	}
	return recoveryPolicy{live: live}
}

func (p recoveryPolicy) recoverAttempt(attemptID string) bool {
	if attemptID == "" {
		return true
	}
	_, live := p.live[attemptID]
	return !live
}

func (p recoveryPolicy) recoverLease(leaseID string) bool {
	attemptID, found := strings.CutPrefix(leaseID, attemptLeasePrefix)
	return found && p.recoverAttempt(attemptID)
}

// Work directories have the form <Attempt ID>-<random suffix>. A live ID is
// enough to preserve its directory; all other entries under the dedicated
// Attempts root are abandoned state.
func (p recoveryPolicy) recoverWorkDir(name string) bool {
	for attemptID := range p.live {
		if strings.HasPrefix(name, attemptID+"-") {
			return false
		}
	}
	return true
}
