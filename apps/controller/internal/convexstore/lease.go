package convexstore

import (
	"context"
	"net/http"
	"time"

	"github.com/Fanzzzd/erainfra/apps/controller/internal/fleet"
)

// WithLease returns a client permanently fenced to this grant. A stale response
// from any route cancels that holder's context, including its GitHub long poll.
func (s *Store) WithLease(epoch int64, lost context.CancelFunc) *Store {
	copy := *s
	copy.epoch = epoch
	copy.onLeaseLost = lost
	return &copy
}

type leaseRequest struct {
	Profile  string `json:"profile"`
	Hostname string `json:"hostname"`
	Instance string `json:"instance"`
	Activate bool   `json:"activate,omitempty"`
	// Omitted when false, which an older backend ignores and this one reads as false.
	CanPublishCacheFacts bool `json:"canPublishCacheFacts,omitempty"`
}

func (s *Store) AcquireLease(ctx context.Context, profile, hostname, instance string) (fleet.LeaseGrant, error) {
	var grant fleet.LeaseGrant
	err := s.doJSON(ctx, http.MethodPost, "/controller/lease/acquire", leaseRequest{Profile: profile, Hostname: hostname, Instance: instance, Activate: s.ActivateProfile, CanPublishCacheFacts: s.CanPublishCacheFacts}, &grant, true)
	if err == nil && grant.Granted {
		s.ActivateProfile = false
	}
	return grant, err
}

func (s *Store) RenewLease(ctx context.Context, profile, hostname, instance string, epoch int64) (fleet.LeaseGrant, error) {
	var grant fleet.LeaseGrant
	err := s.WithLease(epoch, nil).doJSON(ctx, http.MethodPost, "/controller/lease/renew", leaseRequest{Profile: profile, Hostname: hostname, Instance: instance}, &grant, true)
	return grant, err
}

func (s *Store) ReleaseLease(ctx context.Context, profile, hostname, instance string, epoch int64) error {
	return s.WithLease(epoch, nil).doJSON(ctx, http.MethodPost, "/controller/lease/release", leaseRequest{Profile: profile, Hostname: hostname, Instance: instance}, nil, true)
}

// GitHubToken obtains only an installation token; the App key stays in Convex.
func (s *Store) GitHubToken(ctx context.Context, profile string, cacheFacts bool) (string, time.Time, error) {
	var reply struct {
		Token     string `json:"token"`
		ExpiresAt int64  `json:"expiresAt"`
	}
	err := s.doJSON(ctx, http.MethodPost, "/controller/github-token", struct {
		Profile    string `json:"profile"`
		CacheFacts bool   `json:"cacheFacts"`
	}{profile, cacheFacts}, &reply, false)
	return reply.Token, time.UnixMilli(reply.ExpiresAt), err
}

type heartbeatLease struct {
	Role  string `json:"role"`
	Epoch int64  `json:"epoch,omitempty"`
}

func leaseReport(report fleet.ControllerHeartbeat) *heartbeatLease {
	if report.LeaseRole == "" {
		return nil
	}
	return &heartbeatLease{Role: report.LeaseRole, Epoch: report.LeaseEpoch}
}
