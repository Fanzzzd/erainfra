package guestcache

import (
	"context"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Fanzzzd/erainfra/apps/runtime/internal/cacheca"
	"github.com/Fanzzzd/erainfra/apps/runtime/internal/hostspin"
)

const guestHosts = "127.0.0.1\tlocalhost\n127.0.1.1\trc-a\n"

// fakeWatcher stands in for guestdocker.Watcher.
type fakeWatcher struct {
	caPEM  []byte
	stopc  chan error
	once   sync.Once
	closed chan struct{}
}

func newFakeWatcher(caPEM []byte) *fakeWatcher {
	return &fakeWatcher{caPEM: caPEM, stopc: make(chan error, 1), closed: make(chan struct{})}
}

func (w *fakeWatcher) Wait() error {
	select {
	case err := <-w.stopc:
		return err
	case <-w.closed:
		return nil
	}
}

func (w *fakeWatcher) Close() { w.once.Do(func() { close(w.closed) }) }

func (w *fakeWatcher) isClosed() bool {
	select {
	case <-w.closed:
		return true
	default:
		return false
	}
}

// harness records every side effect StartRedirect has on a guest, so a test
// can check that a failure at any step leaves none behind.
type harness struct {
	t          *testing.T
	hostsFile  string
	mu         sync.Mutex
	addrAdded  bool
	addrErr    error
	anchorErr  error
	watchErr   error
	discErr    error
	watcher    *fakeWatcher
	listenAddr string
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	path := filepath.Join(t.TempDir(), "hosts")
	if err := os.WriteFile(path, []byte(guestHosts), 0o644); err != nil {
		t.Fatal(err)
	}
	// Reserve a free loopback port and give it back, so the interceptor can
	// bind it and the test can then tell whether anything is listening.
	listener, err := (&net.ListenConfig{}).Listen(t.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := listener.Addr().String()
	_ = listener.Close()
	return &harness{t: t, hostsFile: path, listenAddr: addr}
}

func (h *harness) config() RedirectConfig {
	return RedirectConfig{
		CacheServiceURL: "http://cache.internal:8721",
		RunnerToken:     "erainfra-cache-runner-v1.payload.signature",
		ListenAddr:      h.listenAddr,
		HostsFile:       h.hostsFile,
		AddAddress: func(context.Context) error {
			if h.addrErr != nil {
				return h.addrErr
			}
			h.mu.Lock()
			h.addrAdded = true
			h.mu.Unlock()
			return nil
		},
		RemoveAddress: func() {
			h.mu.Lock()
			h.addrAdded = false
			h.mu.Unlock()
		},
		InstallTrustAnchor: func([]byte) error { return h.anchorErr },
		Watch: func(_ context.Context, caPEM []byte) (ContainerWatcher, error) {
			if h.watchErr != nil {
				return nil, h.watchErr
			}
			h.watcher = newFakeWatcher(caPEM)
			return h.watcher, nil
		},
		Discover: func(ctx context.Context, host string) (*Upstream, error) {
			if h.discErr != nil {
				return nil, h.discErr
			}
			return discoverUpstream(ctx, host,
				func(context.Context, string) (string, error) { return host + ".", nil },
				func(context.Context, string) ([]net.IP, error) { return []net.IP{net.ParseIP("192.0.2.1")}, nil })
		},
		Logf: h.t.Logf,
	}
}

func (h *harness) hosts() string {
	content, err := os.ReadFile(h.hostsFile)
	if err != nil {
		h.t.Fatal(err)
	}
	return string(content)
}

func (h *harness) listening() bool {
	conn, err := (&net.Dialer{Timeout: 200 * time.Millisecond}).DialContext(h.t.Context(), "tcp", h.listenAddr)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

func (h *harness) addressHeld() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.addrAdded
}

// assertUntouched is the invariant every failure must keep: the guest exactly
// as a guest without a cache.
func (h *harness) assertUntouched() {
	h.t.Helper()
	if got := h.hosts(); got != guestHosts {
		h.t.Fatalf("hosts file changed:\n%q", got)
	}
	if h.addressHeld() {
		h.t.Fatal("the interceptor address was left on loopback")
	}
	if h.listening() {
		h.t.Fatal("an interceptor was left listening")
	}
	if h.watcher != nil && !h.watcher.isClosed() {
		h.t.Fatal("the container watcher was left running")
	}
}

func eventually(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("condition never held")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestStartRedirectPinsLastAndStopUnwindsEverything(t *testing.T) {
	h := newHarness(t)
	r, err := StartRedirect(t.Context(), h.config())
	if err != nil {
		t.Fatal(err)
	}
	host, _, _ := net.SplitHostPort(h.listenAddr)
	if want := hostspin.Line(net.ParseIP(host), cacheca.CacheHost); !strings.Contains(h.hosts(), want) {
		t.Fatalf("guest hosts file not pinned:\n%s", h.hosts())
	}
	if !h.listening() || !h.addressHeld() {
		t.Fatal("pinned to an interceptor that is not up")
	}
	if len(h.watcher.caPEM) == 0 {
		t.Fatal("the watcher was not handed the CA it must check containers against")
	}

	r.Stop()
	r.Stop() // idempotent
	h.assertUntouched()
}

// Each step's failure leaves the guest untouched. The steps are in the order
// StartRedirect takes them; the last one is the pin itself.
func TestStartRedirectFailsTransactionallyAtEveryStep(t *testing.T) {
	for name, breakIt := range map[string]func(*harness){
		"discovery":    func(h *harness) { h.discErr = errors.New("no such host") },
		"address":      func(h *harness) { h.addrErr = errors.New("RTNETLINK answers: Operation not permitted") },
		"trust anchor": func(h *harness) { h.anchorErr = errors.New("update-ca-certificates: exit status 1") },
		"watcher":      func(h *harness) { h.watchErr = errors.New("dial unix /var/run/docker.sock: no such file") },
		// A job or operator already maps the name: the pin defers, and the
		// whole redirect with it.
		"pin": func(h *harness) {
			if err := os.WriteFile(h.hostsFile, []byte(guestHosts+"140.82.112.21 "+cacheca.CacheHost+"\n"), 0o644); err != nil {
				h.t.Fatal(err)
			}
		},
	} {
		t.Run(name, func(t *testing.T) {
			h := newHarness(t)
			breakIt(h)
			before := h.hosts()
			if _, err := StartRedirect(t.Context(), h.config()); err == nil {
				t.Fatal("StartRedirect succeeded")
			}
			if got := h.hosts(); got != before {
				t.Fatalf("hosts file changed:\n%q", got)
			}
			if h.addressHeld() || h.listening() || (h.watcher != nil && !h.watcher.isClosed()) {
				t.Fatal("a failed StartRedirect left part of the redirect behind")
			}
		})
	}
}

// A pin left by a crashed earlier run is cleared even when this run then
// fails: it points at an interceptor that no longer exists.
func TestStartRedirectClearsAStalePinEvenWhenItFails(t *testing.T) {
	h := newHarness(t)
	stale := guestHosts + hostspin.Line(net.ParseIP("100.64.0.1"), cacheca.CacheHost) + "\n"
	if err := os.WriteFile(h.hostsFile, []byte(stale), 0o644); err != nil {
		t.Fatal(err)
	}
	h.discErr = errors.New("no such host")
	if _, err := StartRedirect(t.Context(), h.config()); err == nil {
		t.Fatal("StartRedirect succeeded")
	}
	h.assertUntouched()
}

// The supervisor: a watcher that stops on its own withdraws the redirect.
func TestRedirectComesDownWhenTheWatcherStops(t *testing.T) {
	h := newHarness(t)
	if _, err := StartRedirect(t.Context(), h.config()); err != nil {
		t.Fatal(err)
	}
	h.watcher.stopc <- errors.New("docker event stream ended")
	eventually(t, func() bool { return h.hosts() == guestHosts && !h.listening() && !h.addressHeld() })
}

// The supervisor: an interceptor that stops withdraws the redirect, so the
// pin never outlives what it points at.
func TestRedirectComesDownWhenTheInterceptorStops(t *testing.T) {
	h := newHarness(t)
	r, err := StartRedirect(t.Context(), h.config())
	if err != nil {
		t.Fatal(err)
	}
	_ = r.interceptor.Close(t.Context())
	eventually(t, func() bool { return h.hosts() == guestHosts && h.watcher.isClosed() && !h.addressHeld() })
}

func TestStartRedirectRequiresItsInputs(t *testing.T) {
	h := newHarness(t)
	for name, tweak := range map[string]func(*RedirectConfig){
		"no hosts file":   func(c *RedirectConfig) { c.HostsFile = "" },
		"no watcher":      func(c *RedirectConfig) { c.Watch = nil },
		"no anchor":       func(c *RedirectConfig) { c.InstallTrustAnchor = nil },
		"hostname listen": func(c *RedirectConfig) { c.ListenAddr = "localhost:443" },
		"no port":         func(c *RedirectConfig) { c.ListenAddr = "100.64.0.1" },
		"ipv6 listen":     func(c *RedirectConfig) { c.ListenAddr = "[::1]:443" },
	} {
		cfg := h.config()
		tweak(&cfg)
		if _, err := StartRedirect(t.Context(), cfg); err == nil {
			t.Errorf("%s: StartRedirect succeeded", name)
		}
	}
	h.assertUntouched()
}
