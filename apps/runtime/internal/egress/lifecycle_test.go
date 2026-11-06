package egress

import (
	"context"
	"errors"
	"net/netip"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Fanzzzd/erainfra/apps/runtime/internal/netpolicy"
	"github.com/miekg/dns"
)

func npmPolicy(t *testing.T) netpolicy.EffectiveEgress {
	t.Helper()
	effective, err := netpolicy.Effective(netpolicy.DefaultPolicy("runner-center"), netpolicy.ProfileEgress{
		Mode: netpolicy.EgressAllowlist, Domains: []string{"registry.npmjs.org"},
	})
	if err != nil {
		t.Fatal(err)
	}
	return effective
}

func TestAddressReusePurgesPreviousDNS(t *testing.T) {
	old := githubAllowlist
	old.CIDRs = []string{"128.0.0.0/1"}
	guard, kernel, _ := setup(t, old)
	if response := ask(guard, guestAddress, "github.com."); len(response.Answer) != 1 {
		t.Fatal("fixture DNS failed")
	}
	kernel.reset()
	if err := guard.Register(context.Background(), guestAddress, guestLink, "vm-2", npmPolicy(t)); err != nil {
		t.Fatal(err)
	}
	batches := kernel.all()
	for _, removal := range []string{
		"delete element inet runner-center rc_allow_dns { 10.241.0.7 . 140.82.112.3 }",
		"delete element inet runner-center rc_allow_cidr { 10.241.0.7 . 128.0.0.0/1 }",
	} {
		if index := strings.Index(batches, removal); index < 0 || index > strings.LastIndex(batches, "add element inet runner-center rc_restricted") {
			t.Fatalf("previous permission must be purged before replacement registration: %s\n%s", removal, batches)
		}
	}
	if response := ask(guard, guestAddress, "github.com."); response.Rcode != dns.RcodeNameError {
		t.Fatal("replacement must reject the old Profile's domain")
	}
	if response := ask(guard, guestAddress, "registry.npmjs.org."); len(response.Answer) != 1 {
		t.Fatal("replacement must admit its own domain")
	}
	kernel.reset()
	if _, err := guard.Unregister(context.Background(), guestAddress, "vm-1"); err != nil {
		t.Fatal(err)
	}
	if kernel.all() != "" {
		t.Fatal("late old-owner teardown must leave the replacement untouched")
	}
}

type blockingListKernel struct {
	*fakeKernel
	entered chan struct{}
	release chan struct{}
	once    sync.Once
}

func (k *blockingListKernel) ListSet(ctx context.Context, name string) ([]byte, error) {
	k.once.Do(func() { close(k.entered); <-k.release })
	return k.fakeKernel.ListSet(ctx, name)
}

func TestTeardownCannotDeleteReusedAddressMembership(t *testing.T) {
	for _, failure := range []bool{false, true} {
		name := "successful cleanup"
		if failure {
			name = "failed cleanup"
		}
		t.Run(name, func(t *testing.T) {
			guard, kernel, _ := setup(t, githubAllowlist)
			ask(guard, guestAddress, "github.com.")
			blocking := &blockingListKernel{fakeKernel: kernel, entered: make(chan struct{}), release: make(chan struct{})}
			guard.applier = blocking
			var release sync.Once
			unblock := func() { release.Do(func() { close(blocking.release) }) }
			defer unblock()
			done := make(chan error, 1)
			go func() { _, err := guard.Unregister(context.Background(), guestAddress, "vm-1"); done <- err }()
			<-blocking.entered
			effective := npmPolicy(t)
			replacement := make(chan error, 1)
			go func() { replacement <- guard.Register(context.Background(), guestAddress, guestLink, "vm-2", effective) }()
			select {
			case err := <-replacement:
				unblock()
				cleanupErr := <-done
				t.Fatalf("replacement registered before old kernel cleanup completed: %v (old cleanup: %v)", err, cleanupErr)
			case <-time.After(2 * time.Second):
			}
			// Another address must not wait behind external calls for this address.
			unrelated := make(chan error, 1)
			go func() {
				unrelated <- guard.Register(context.Background(), netip.MustParseAddr("10.241.0.8"), "veth00000008", "other", effective)
			}()
			select {
			case err := <-unrelated:
				if err != nil {
					t.Fatal(err)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("cleanup holds a global registration lock")
			}
			kernel.reset()
			if failure {
				kernel.mu.Lock()
				kernel.failNext = errors.New("cleanup transaction failed")
				kernel.mu.Unlock()
			}
			unblock()
			if err := <-done; (err != nil) != failure {
				t.Fatalf("cleanup error = %v, failure = %v", err, failure)
			}
			if err := <-replacement; err != nil {
				t.Fatal(err)
			}
			batches := kernel.all()
			removal := strings.LastIndex(batches, "delete element inet runner-center rc_restricted { 10.241.0.7 }")
			install := strings.LastIndex(batches, "add element inet runner-center rc_restricted { 10.241.0.7 }")
			if removal < 0 || install < removal {
				t.Fatalf("old teardown removes replacement restrictions:\n%s", batches)
			}
			kernel.reset()
			if _, err := guard.Unregister(context.Background(), guestAddress, "vm-1"); err != nil {
				t.Fatal(err)
			}
			if kernel.all() != "" {
				t.Fatal("out-of-order teardown changed replacement permissions")
			}
		})
	}
}

func TestFailedReplacementPurgeBlocksEveryProfileUntilRetrySucceeds(t *testing.T) {
	guard, kernel, _ := setup(t, githubAllowlist)
	ask(guard, guestAddress, "github.com.")
	kernel.failNext = errors.New("purge failed")
	if err := guard.Register(context.Background(), guestAddress, guestLink, "vm-2", npmPolicy(t)); err == nil {
		t.Fatal("failed purge must refuse replacement")
	}
	if response := ask(guard, guestAddress, "github.com."); response.Rcode != dns.RcodeRefused {
		t.Fatal("failed replacement must leave no DNS view")
	}
	public, err := netpolicy.Effective(netpolicy.DefaultPolicy("runner-center"), netpolicy.ProfileEgress{})
	if err != nil {
		t.Fatal(err)
	}
	kernel.failNext = errors.New("purge still failing")
	if err := guard.Register(context.Background(), guestAddress, guestLink, "public", public); err == nil {
		t.Fatal("public replacement must also be fenced by stale permissions")
	}
	kernel.reset()
	if err := guard.Register(context.Background(), guestAddress, guestLink, "vm-3", npmPolicy(t)); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(kernel.all(), "delete element inet runner-center rc_allow_dns { 10.241.0.7 . 140.82.112.3 }") {
		t.Fatal("retry lost the old DNS permission snapshot")
	}
}

func TestDNSReplyRacingAddressReplacementCannotAdmitOldPermission(t *testing.T) {
	guard, kernel, _ := setup(t, githubAllowlist)
	entered, release := make(chan struct{}), make(chan struct{})
	original := guard.resolver.exchange
	guard.resolver.exchange = func(ctx context.Context, query *dns.Msg, network, server string) (*dns.Msg, error) {
		close(entered)
		<-release
		return original(ctx, query, network, server)
	}
	done := make(chan *dns.Msg, 1)
	go func() { done <- ask(guard, guestAddress, "github.com.") }()
	<-entered
	if err := guard.Register(context.Background(), guestAddress, guestLink, "vm-2", npmPolicy(t)); err != nil {
		close(release)
		t.Fatal(err)
	}
	kernel.reset()
	close(release)
	if response := <-done; response.Rcode != dns.RcodeServerFailure {
		t.Fatal("old reply must fail after replacement")
	}
	if kernel.all() != "" {
		t.Fatalf("old reply inserted permission for replacement: %s", kernel.all())
	}
}

type admissionKernel struct {
	*fakeKernel
	entered   chan struct{}
	release   chan struct{}
	once      sync.Once
	uncertain bool
}

func (k *admissionKernel) Apply(ctx context.Context, batch string) error {
	admission := strings.Contains(batch, "rc_allow_dns") && strings.Contains(batch, "timeout")
	if admission && k.entered != nil {
		k.once.Do(func() { close(k.entered); <-k.release })
	}
	if err := k.fakeKernel.Apply(ctx, batch); err != nil {
		return err
	}
	if admission && k.uncertain {
		return context.DeadlineExceeded
	}
	return nil
}

func TestReplacementDrainsInFlightDNSInsertion(t *testing.T) {
	guard, kernel, _ := setup(t, githubAllowlist)
	blocking := &admissionKernel{fakeKernel: kernel, entered: make(chan struct{}), release: make(chan struct{})}
	guard.applier = blocking
	var release sync.Once
	unblock := func() { release.Do(func() { close(blocking.release) }) }
	defer unblock()
	answer := make(chan *dns.Msg, 1)
	go func() { answer <- ask(guard, guestAddress, "github.com.") }()
	<-blocking.entered
	effective := npmPolicy(t)
	replacement := make(chan error, 1)
	go func() { replacement <- guard.Register(context.Background(), guestAddress, guestLink, "vm-2", effective) }()
	select {
	case err := <-replacement:
		t.Fatalf("replacement overtook DNS insertion: %v", err)
	case <-time.After(2 * time.Second):
	}
	unblock()
	if response := <-answer; len(response.Answer) != 1 {
		t.Fatal("original admitted query failed")
	}
	if err := <-replacement; err != nil {
		t.Fatal(err)
	}
	batches := kernel.all()
	removal := strings.LastIndex(batches, "delete element inet runner-center rc_allow_dns { 10.241.0.7 . 140.82.112.3 }")
	install := strings.LastIndex(batches, "add element inet runner-center rc_restricted")
	if removal < 0 || install < removal {
		t.Fatalf("in-flight DNS permission survived replacement:\n%s", batches)
	}
}

func TestFailedDNSAcknowledgementIsStillPurged(t *testing.T) {
	guard, kernel, _ := setup(t, githubAllowlist)
	guard.applier = &admissionKernel{fakeKernel: kernel, uncertain: true}
	if response := ask(guard, guestAddress, "github.com."); response.Rcode != dns.RcodeServerFailure {
		t.Fatal("uncertain admission must fail DNS")
	}
	kernel.reset()
	if err := guard.Register(context.Background(), guestAddress, guestLink, "vm-2", npmPolicy(t)); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(kernel.all(), "delete element inet runner-center rc_allow_dns { 10.241.0.7 . 140.82.112.3 }") {
		t.Fatal("failed acknowledgement hid a committed DNS permission from cleanup")
	}
}

func TestFailedRegistrationIsPurgedBeforePublicAddressReuse(t *testing.T) {
	host := netpolicy.DefaultPolicy("runner-center")
	kernel := &fakeKernel{failNext: context.DeadlineExceeded}
	guard := NewGuard(host, kernel)
	old := githubAllowlist
	old.CIDRs = []string{"128.0.0.0/1"}
	effective, err := netpolicy.Effective(host, old)
	if err != nil {
		t.Fatal(err)
	}
	if err := guard.Register(context.Background(), guestAddress, guestLink, "vm-1", effective); err == nil {
		t.Fatal("uncertain registration must fail boot")
	}
	public, err := netpolicy.Effective(host, netpolicy.ProfileEgress{})
	if err != nil {
		t.Fatal(err)
	}
	if err := guard.Register(context.Background(), guestAddress, guestLink, "vm-2", public); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(kernel.all(), "delete element inet runner-center rc_allow_cidr { 10.241.0.7 . 128.0.0.0/1 }") {
		t.Fatal("uncertain registration must be purged before a public guest boots")
	}
}

func TestFailedFlowListingKeepsAddressFencedUntilRetrySucceeds(t *testing.T) {
	guard, kernel, _ := setup(t, githubAllowlist)
	ask(guard, guestAddress, "github.com.")
	kernel.failList = errors.New("flow listing failed")
	record, err := guard.Unregister(context.Background(), guestAddress, "vm-1")
	if err != nil || record == nil || record.Error == "" {
		t.Fatalf("missing incomplete-record evidence: %+v %v", record, err)
	}
	public, err := netpolicy.Effective(netpolicy.DefaultPolicy("runner-center"), netpolicy.ProfileEgress{})
	if err != nil {
		t.Fatal(err)
	}
	if err := guard.Register(context.Background(), guestAddress, guestLink, "vm-2", public); err == nil {
		t.Fatal("unknown leftover flow state must fence address reuse")
	}
	kernel.failList = nil
	if err := guard.Register(context.Background(), guestAddress, guestLink, "vm-3", public); err != nil {
		t.Fatal(err)
	}
}
