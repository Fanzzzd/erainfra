package guestcache

import (
	"context"
	"errors"
	"net"
	"sync"
	"testing"
)

const testCacheHost = "results-receiver.actions.githubusercontent.com"

// resolverLog answers lookups from a table and records every name asked, so a
// test can prove the pinned name is never resolved again after discovery.
type resolverLog struct {
	mu    sync.Mutex
	asked []string
	ips   map[string][]net.IP
	cname map[string]string
}

func (r *resolverLog) lookupIP(_ context.Context, name string) ([]net.IP, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.asked = append(r.asked, name)
	if ips, ok := r.ips[name]; ok {
		return ips, nil
	}
	return nil, errors.New("no such host")
}

func (r *resolverLog) lookupCNAME(_ context.Context, name string) (string, error) {
	if cname, ok := r.cname[name]; ok {
		return cname, nil
	}
	return name + ".", nil
}

func listen(t *testing.T) (net.Listener, string) {
	t.Helper()
	listener, err := (&net.ListenConfig{}).Listen(t.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			_ = conn.Close()
		}
	}()
	_, port, _ := net.SplitHostPort(listener.Addr().String())
	return listener, port
}

// After discovery the hosts file pins the cache host to the interceptor. The
// upstream must follow the CNAME target instead, which nothing pins.
func TestUpstreamResolvesTheCanonicalNameNotThePinnedOne(t *testing.T) {
	_, port := listen(t)
	r := &resolverLog{
		ips: map[string][]net.IP{
			testCacheHost:                   {net.ParseIP("192.0.2.1")}, // what discovery saw
			"glb-db52c2cf8be544.github.com": {net.ParseIP("127.0.0.1")}, // where the balancer points now
		},
		cname: map[string]string{testCacheHost: "glb-db52c2cf8be544.github.com."},
	}
	u, err := discoverUpstream(t.Context(), testCacheHost, r.lookupCNAME, r.lookupIP)
	if err != nil {
		t.Fatal(err)
	}
	r.asked = nil

	conn, err := u.DialContext(t.Context(), "tcp", net.JoinHostPort(testCacheHost, port))
	if err != nil {
		t.Fatalf("dial through the canonical name: %v", err)
	}
	_ = conn.Close()
	for _, name := range r.asked {
		if name == testCacheHost {
			t.Fatal("the pinned name was resolved after discovery; that answer is the interceptor itself")
		}
	}
}

func TestUpstreamFallsBackToTheAddressesDiscoverySaw(t *testing.T) {
	_, port := listen(t)
	r := &resolverLog{
		ips:   map[string][]net.IP{testCacheHost: {net.ParseIP("127.0.0.1")}},
		cname: map[string]string{testCacheHost: "glb.example."}, // which then fails to resolve
	}
	u, err := discoverUpstream(t.Context(), testCacheHost, r.lookupCNAME, r.lookupIP)
	if err != nil {
		t.Fatal(err)
	}
	conn, err := u.DialContext(t.Context(), "tcp", net.JoinHostPort(testCacheHost, port))
	if err != nil {
		t.Fatalf("dial through the recorded address: %v", err)
	}
	_ = conn.Close()
}

// No CNAME means nothing unpinned to follow: only the recorded addresses are
// used, and the pinned name is never looked up again.
func TestUpstreamWithoutACNAMEUsesOnlyRecordedAddresses(t *testing.T) {
	_, port := listen(t)
	r := &resolverLog{ips: map[string][]net.IP{testCacheHost: {net.ParseIP("127.0.0.1")}}}
	u, err := discoverUpstream(t.Context(), testCacheHost, r.lookupCNAME, r.lookupIP)
	if err != nil {
		t.Fatal(err)
	}
	r.asked = nil
	conn, err := u.DialContext(t.Context(), "tcp", net.JoinHostPort(testCacheHost, port))
	if err != nil {
		t.Fatal(err)
	}
	_ = conn.Close()
	if len(r.asked) != 0 {
		t.Fatalf("looked up %v with no CNAME to follow", r.asked)
	}
}

func TestUpstreamRefusesAnyOtherHost(t *testing.T) {
	r := &resolverLog{ips: map[string][]net.IP{testCacheHost: {net.ParseIP("127.0.0.1")}}}
	u, err := discoverUpstream(t.Context(), testCacheHost, r.lookupCNAME, r.lookupIP)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := u.DialContext(t.Context(), "tcp", "github.com:443"); err == nil {
		t.Fatal("the upstream dialed a host it does not serve")
	}
}

func TestDiscoverUpstreamNeedsAnAddress(t *testing.T) {
	r := &resolverLog{ips: map[string][]net.IP{testCacheHost: {}}}
	if _, err := discoverUpstream(t.Context(), testCacheHost, r.lookupCNAME, r.lookupIP); err == nil {
		t.Fatal("discovered an upstream with no address")
	}
	if _, err := discoverUpstream(t.Context(), "unresolvable.invalid", r.lookupCNAME, r.lookupIP); err == nil {
		t.Fatal("discovered an upstream for a name that does not resolve")
	}
}
