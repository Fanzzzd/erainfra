package controller

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/Fanzzzd/erainfra/apps/controller/internal/fleet"
)

// LeaseSupervisor runs exactly one holder at a time, and nothing that talks to
// GitHub until Convex grants the lease. All lease timings come from Convex.
// RunHolder must return after ctx is canceled, closing its GitHub session before
// it returns. It receives cancel so a stale-epoch refusal on any write can stop
// it immediately, without waiting for the next renewal.
type LeaseSupervisor struct {
	Store                       fleet.LeaseStore
	Profile, Hostname, Instance string
	RunHolder                   func(ctx context.Context, grant fleet.LeaseGrant, cancel context.CancelFunc) error
	Standby                     func(ctx context.Context, grant fleet.LeaseGrant)
	Logger                      *slog.Logger
	// RetryDelay is only for failures where no server response supplies a delay.
	RetryDelay time.Duration
}

func (s *LeaseSupervisor) Run(ctx context.Context) error {
	if s.Store == nil || s.RunHolder == nil || s.Instance == "" {
		return errors.New("lease supervisor requires Store, RunHolder and Instance")
	}
	retry := s.RetryDelay
	if retry <= 0 {
		retry = 5 * time.Second
	}
	for ctx.Err() == nil {
		began := time.Now()
		grant, err := s.Store.AcquireLease(ctx, s.Profile, s.Hostname, s.Instance)
		if ctx.Err() != nil {
			return nil
		}
		if err != nil {
			if s.Logger != nil {
				s.Logger.Warn("could not acquire controller lease", "error", err)
			}
			if s.Standby != nil {
				s.Standby(ctx, fleet.LeaseGrant{Reason: "unreachable"})
			}
			if err := sleepContext(ctx, retry); err != nil {
				return nil
			}
			continue
		}
		if !grant.Granted {
			if s.Standby != nil {
				s.Standby(ctx, grant)
			}
			delay := grant.RetryAfter()
			if delay <= 0 {
				delay = retry
			}
			if err := sleepContext(ctx, delay); err != nil {
				return nil
			}
			continue
		}
		if grant.Epoch <= 0 || grant.TTL() <= 0 || grant.RenewInterval() <= 0 || grant.RenewInterval() >= grant.TTL() {
			return errors.New("control plane returned an invalid lease grant")
		}
		if !time.Now().Before(began.Add(grant.TTL())) {
			// A response delayed beyond its own grant conveys no usable authority.
			continue
		}
		if s.Logger != nil {
			s.Logger.Info("acquired controller lease", "epoch", grant.Epoch, "networkPoor", grant.NetworkPoor)
		}
		holderCtx, cancel := context.WithCancel(ctx)
		renewed := make(chan struct{})
		go func() {
			defer close(renewed)
			s.keepLease(holderCtx, cancel, grant, began)
		}()
		err = s.RunHolder(holderCtx, grant, cancel)
		wasCanceled := holderCtx.Err() != nil
		cancel()
		<-renewed
		// Close the GitHub session before releasing the lease; never grant a new
		// holder while this one's listener is still unwinding.
		releaseCtx, stop := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		releaseErr := s.Store.ReleaseLease(releaseCtx, s.Profile, s.Hostname, s.Instance, grant.Epoch)
		stop()
		if releaseErr != nil && s.Logger != nil {
			s.Logger.Warn("could not release controller lease", "error", releaseErr)
		}
		if ctx.Err() != nil {
			return nil
		}
		if err != nil && !wasCanceled && !errors.Is(err, fleet.ErrLeaseLost) {
			return fmt.Errorf("serve Profile under lease: %w", err)
		}
		if s.Standby != nil {
			s.Standby(ctx, fleet.LeaseGrant{Reason: "lease-lost"})
		}
	}
	return nil
}

// keepLease has a deadline independent of the in-flight HTTP request. A hung
// renewal cannot let a partitioned holder keep listening past its last grant.
// Count TTL from request start, not reply receipt, using the local monotonic
// clock, so server clock skew and request latency only shorten our authority.
func (s *LeaseSupervisor) keepLease(ctx context.Context, cancel context.CancelFunc, grant fleet.LeaseGrant, began time.Time) {
	defer cancel()
	expiry := began.Add(grant.TTL())
	next := time.NewTimer(min(grant.RenewInterval(), time.Until(expiry)))
	defer next.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-next.C:
		}
		if !time.Now().Before(expiry) {
			return
		}
		started := time.Now()
		requestCtx, stop := context.WithDeadline(ctx, expiry)
		reply, err := s.Store.RenewLease(requestCtx, s.Profile, s.Hostname, s.Instance, grant.Epoch)
		stop()
		if ctx.Err() != nil || errors.Is(err, fleet.ErrLeaseLost) {
			return
		}
		if err == nil {
			if reply.Epoch != grant.Epoch || reply.TTL() <= 0 || reply.RenewInterval() <= 0 || reply.RenewInterval() >= reply.TTL() {
				return
			}
			grant = reply
			expiry = started.Add(reply.TTL())
		} else if s.Logger != nil {
			s.Logger.Warn("could not renew controller lease; will stop at expiry", "error", err)
		}
		if !time.Now().Before(expiry) {
			return
		}
		next.Reset(min(grant.RenewInterval(), time.Until(expiry)))
	}
}
