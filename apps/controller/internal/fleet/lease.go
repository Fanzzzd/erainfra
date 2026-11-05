package fleet

import (
	"context"
	"errors"
	"time"
)

// ErrLeaseLost is distinct from an ordinary network failure: the caller must
// stop listening immediately and return to standby, not retry a fenced write.
var ErrLeaseLost = errors.New("controller lease lost")

// LeaseGrant is Convex's answer to acquire or renew. Timing is server-owned;
// clients conservatively count TTL from the start of the request, so network
// latency and clock skew can never extend a grant locally.
type LeaseGrant struct {
	Granted     bool         `json:"granted"`
	Epoch       int64        `json:"epoch"`
	TTLMillis   int64        `json:"ttlMs"`
	RenewMillis int64        `json:"renewIntervalMs"`
	RetryMillis int64        `json:"retryAfterMs"`
	Reason      string       `json:"reason"`
	Holder      string       `json:"holder"`
	NetworkPoor bool         `json:"networkPoor"`
	Profile     *ProfileSpec `json:"profile,omitempty"`
}

// LeaseStore arbitrates a Profile's listener. Instance identifies one process,
// never a host name alone: two processes on one machine are two candidates.
type LeaseStore interface {
	AcquireLease(ctx context.Context, profile, hostname, instance string) (LeaseGrant, error)
	RenewLease(ctx context.Context, profile, hostname, instance string, epoch int64) (LeaseGrant, error)
	ReleaseLease(ctx context.Context, profile, hostname, instance string, epoch int64) error
}

func (g LeaseGrant) TTL() time.Duration { return time.Duration(g.TTLMillis) * time.Millisecond }
func (g LeaseGrant) RenewInterval() time.Duration {
	return time.Duration(g.RenewMillis) * time.Millisecond
}
func (g LeaseGrant) RetryAfter() time.Duration {
	return time.Duration(g.RetryMillis) * time.Millisecond
}
