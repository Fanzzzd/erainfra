package controller

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/Fanzzzd/erainfra/apps/controller/internal/fleet"
	"github.com/actions/scaleset/listener"
)

// A fake Convex arbiter with the same expiry/epoch contract. The partition
// affects renew/release, not the durable row: another candidate can take over.
type leaseArbiter struct {
	mu        sync.Mutex
	holder    string
	epoch     int64
	expiry    time.Time
	partition map[string]bool
}

func (f *leaseArbiter) AcquireLease(_ context.Context, _, _, instance string) (fleet.LeaseGrant, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.partition[instance] {
		return fleet.LeaseGrant{}, errors.New("partition")
	}
	if f.holder != "" && time.Now().Before(f.expiry) {
		return fleet.LeaseGrant{RetryMillis: max(1, time.Until(f.expiry).Milliseconds()), Reason: "held"}, nil
	}
	f.epoch++
	f.holder = instance
	f.expiry = time.Now().Add(30 * time.Second)
	return fakeGrant(f.epoch), nil
}
func fakeGrant(epoch int64) fleet.LeaseGrant {
	return fleet.LeaseGrant{Granted: true, Epoch: epoch, TTLMillis: 30_000, RenewMillis: 10_000}
}
func (f *leaseArbiter) RenewLease(_ context.Context, _, _, instance string, epoch int64) (fleet.LeaseGrant, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.partition[instance] {
		return fleet.LeaseGrant{}, errors.New("partition")
	}
	if f.holder != instance || f.epoch != epoch || !time.Now().Before(f.expiry) {
		return fleet.LeaseGrant{}, fleet.ErrLeaseLost
	}
	f.expiry = time.Now().Add(30 * time.Second)
	return fakeGrant(epoch), nil
}
func (f *leaseArbiter) ReleaseLease(_ context.Context, _, _, instance string, epoch int64) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.partition[instance] {
		return errors.New("partition")
	}
	if f.holder == instance && f.epoch == epoch {
		f.holder = ""
		f.expiry = time.Now()
	}
	return nil
}
func (f *leaseArbiter) write(instance string, epoch int64) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.holder != instance || f.epoch != epoch || !time.Now().Before(f.expiry) {
		return fleet.ErrLeaseLost
	}
	return nil
}

func TestLeaseStandbysTakeOverAfterPartitionAndLingeringSession(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		arbiter := &leaseArbiter{partition: map[string]bool{}}
		var mu sync.Mutex
		listeners, maxListeners := 0, 0
		sessionUntil := time.Time{}
		opened := make(chan string, 10)
		makeController := func(instance string) *LeaseSupervisor {
			return &LeaseSupervisor{Store: arbiter, Profile: "p", Hostname: instance, Instance: instance,
				RunHolder: func(ctx context.Context, _ fleet.LeaseGrant, _ context.CancelFunc) error {
					s := SessionSupervisor{
						Open: func(context.Context) (MessageSession, error) {
							mu.Lock()
							defer mu.Unlock()
							if time.Now().Before(sessionUntil) {
								return nil, fmt.Errorf(`status="409 Conflict"`)
							}
							return &fakeSession{}, nil
						},
						Listen: func(ctx context.Context, _ listener.Client) error {
							mu.Lock()
							listeners++
							maxListeners = max(maxListeners, listeners)
							mu.Unlock()
							opened <- instance
							<-ctx.Done()
							mu.Lock()
							listeners--
							mu.Unlock()
							return nil
						}, Jitter: func(d time.Duration) time.Duration { return d },
					}
					return s.Run(ctx)
				},
			}
		}
		firstCtx, stopFirst := context.WithCancel(t.Context())
		secondCtx, stopSecond := context.WithCancel(t.Context())
		defer stopFirst()
		defer stopSecond()
		firstDone, secondDone := make(chan error, 1), make(chan error, 1)
		go func() { firstDone <- makeController("first").Run(firstCtx) }()
		if got := <-opened; got != "first" {
			t.Fatal(got)
		}
		synctest.Wait()
		go func() { secondDone <- makeController("second").Run(secondCtx) }()
		synctest.Wait()
		select {
		case got := <-opened:
			t.Fatalf("standby listened: %s", got)
		default:
		}

		// The old holder cannot reach Convex. GitHub still retains its session for
		// ten seconds after the grant expires, exactly the lingering-session seam.
		arbiter.mu.Lock()
		arbiter.partition["first"] = true
		arbiter.mu.Unlock()
		mu.Lock()
		sessionUntil = time.Now().Add(40 * time.Second)
		mu.Unlock()
		began := time.Now()
		time.Sleep(30 * time.Second)
		synctest.Wait()
		// At expiry the old listener is gone. The successor has the lease but sees
		// 409 and reuses #178's ten-second initial session backoff.
		mu.Lock()
		count := listeners
		mu.Unlock()
		if count != 0 {
			t.Fatalf("old holder still listening past expiry: %d", count)
		}
		if err := arbiter.write("first", 1); !errors.Is(err, fleet.ErrLeaseLost) {
			t.Fatalf("partitioned write = %v", err)
		}
		stopFirst()
		time.Sleep(10 * time.Second)
		synctest.Wait()
		if got := <-opened; got != "second" {
			t.Fatal(got)
		}
		if time.Since(began) > 40*time.Second {
			t.Fatal("takeover exceeded expiry plus backoff")
		}
		mu.Lock()
		maximum := maxListeners
		mu.Unlock()
		if maximum != 1 {
			t.Fatalf("max concurrent listeners = %d", maximum)
		}
		stopSecond()
		if err := <-firstDone; err != nil {
			t.Fatal(err)
		}
		if err := <-secondDone; err != nil {
			t.Fatal(err)
		}
	})
}

// A definitive refusal (from any fenced route) stops before the next ten-second
// renewal. Cancellation is the same callback convexstore installs on every 412.
func TestStaleWriteClosesSessionImmediatelyBeforeReturningToStandby(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ctx, stop := context.WithCancel(t.Context())
		defer stop()
		arbiter := &leaseArbiter{partition: map[string]bool{}}
		session := &fakeSession{}
		began := time.Now()
		entered := false
		supervisor := LeaseSupervisor{Store: arbiter, Profile: "p", Hostname: "one", Instance: "one",
			RunHolder: func(ctx context.Context, _ fleet.LeaseGrant, lost context.CancelFunc) error {
				entered = true
				s := SessionSupervisor{Open: func(context.Context) (MessageSession, error) { return session, nil }, Listen: func(ctx context.Context, _ listener.Client) error {
					time.Sleep(time.Second)
					lost() // a create/heartbeat/job write returned 412
					<-ctx.Done()
					return fleet.ErrLeaseLost
				}}
				return s.Run(ctx)
			},
			Standby: func(context.Context, fleet.LeaseGrant) { stop() },
		}
		if err := supervisor.Run(ctx); err != nil {
			t.Fatal(err)
		}
		if !entered || session.closed.Load() != 1 {
			t.Fatalf("session was not closed: %d", session.closed.Load())
		}
		if time.Since(began) != time.Second {
			t.Fatalf("stale refusal waited for renewal: %v", time.Since(began))
		}
	})
}

type hungRenewal struct{ leaseArbiter }

func (f *hungRenewal) RenewLease(ctx context.Context, _, _, _ string, _ int64) (fleet.LeaseGrant, error) {
	<-ctx.Done()
	return fleet.LeaseGrant{}, ctx.Err()
}
func TestHungRenewalCannotExtendLeasePastExpiry(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ctx, stop := context.WithCancel(t.Context())
		defer stop()
		began := time.Now()
		s := LeaseSupervisor{Store: &hungRenewal{}, Profile: "p", Hostname: "h", Instance: "i", RunHolder: func(ctx context.Context, _ fleet.LeaseGrant, _ context.CancelFunc) error { <-ctx.Done(); return nil }, Standby: func(context.Context, fleet.LeaseGrant) { stop() }}
		if err := s.Run(ctx); err != nil {
			t.Fatal(err)
		}
		if time.Since(began) != 30*time.Second {
			t.Fatalf("authority extended to %v", time.Since(began))
		}
	})
}
