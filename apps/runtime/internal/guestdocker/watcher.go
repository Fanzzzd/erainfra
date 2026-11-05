package guestdocker

import (
	"context"
	"errors"
	"fmt"
	"net"
	"sync"

	"github.com/Fanzzzd/erainfra/apps/runtime/internal/hostspin"
)

// WatcherConfig is what the Watcher needs to decide and act.
type WatcherConfig struct {
	Engine Engine
	// CAPEM is the interceptor's CA, the certificate a container must trust.
	CAPEM []byte
	// Addr and Host are the pin: the interceptor's address and the cache host.
	Addr net.IP
	Host string
	// ReadFile reads a path inside a container, resolved against the root of
	// the process pid. Production uses ReadInContainer.
	ReadFile func(pid int, path string) ([]byte, error)
	// Pin and Unpin edit a hosts file. Nil means hostspin.PinFile and
	// hostspin.UnpinFile; tests substitute failures.
	Pin   func(path string, addr net.IP, host string) error
	Unpin func(path string) error
	// Logf reports a container the Watcher pinned or could not. Nil discards.
	Logf func(format string, args ...any)
}

// Watcher keeps every running container's hosts file in line with whether
// that container trusts the interceptor's CA: pinned to the interceptor if it
// does, carrying no pin of ours if it does not.
//
// The second half matters for host-network containers. Docker gives one a
// copy of the guest's /etc/hosts, pin included, and a container image does not
// trust the per-guest CA, so without the Watcher such a container would fail
// TLS to the cache host instead of reaching GitHub. A bridge-network container
// gets a hosts file Docker generates, which never carries the pin until the
// Watcher writes it.
//
// It stops on the first thing it cannot keep true. If the event stream breaks,
// a host-network container could start unseen with the guest's pin in it, so
// Wait returns and the caller tears the whole redirect down. Close removes
// every pin the Watcher wrote.
type Watcher struct {
	cfg    WatcherConfig
	stream EventStream
	cancel context.CancelFunc
	done   chan struct{}
	err    error

	mu     sync.Mutex
	pinned map[string]string // container ID -> hosts file the Watcher pinned
	closed bool
}

// StartWatcher subscribes to container starts, brings every container already
// running into line, and keeps doing so until Close or a failure.
func StartWatcher(ctx context.Context, cfg WatcherConfig) (*Watcher, error) {
	switch {
	case cfg.Engine == nil:
		return nil, errors.New("guestdocker: an engine is required")
	case cfg.ReadFile == nil:
		return nil, errors.New("guestdocker: a container file reader is required")
	case len(certificatesIn(cfg.CAPEM)) != 1:
		return nil, errors.New("guestdocker: CAPEM must hold exactly one certificate")
	case cfg.Addr.To4() == nil || cfg.Host == "":
		return nil, errors.New("guestdocker: a pin address and host are required")
	}
	if cfg.Pin == nil {
		cfg.Pin = hostspin.PinFile
	}
	if cfg.Unpin == nil {
		cfg.Unpin = hostspin.UnpinFile
	}
	if cfg.Logf == nil {
		cfg.Logf = func(string, ...any) {}
	}
	ctx, cancel := context.WithCancel(ctx)
	stream, err := cfg.Engine.Subscribe(ctx)
	if err != nil {
		cancel()
		return nil, err
	}
	w := &Watcher{cfg: cfg, stream: stream, cancel: cancel, done: make(chan struct{}), pinned: map[string]string{}}

	running, err := cfg.Engine.Running(ctx)
	if err == nil {
		for _, id := range running {
			if err = w.reconcile(ctx, id); err != nil {
				break
			}
		}
	}
	if err != nil {
		cancel()
		_ = stream.Close()
		w.unpinAll()
		return nil, err
	}
	go w.loop(ctx)
	return w, nil
}

func (w *Watcher) loop(ctx context.Context) {
	defer close(w.done)
	for {
		id, err := w.stream.Next()
		if err != nil {
			if ctx.Err() == nil {
				w.err = err
			}
			return
		}
		if err := w.reconcile(ctx, id); err != nil {
			w.err = err
			return
		}
	}
}

// reconcile brings one container's hosts file into line. Only a failure that
// leaves a container pinned without trusting the CA is returned; anything
// else leaves the container reaching GitHub directly, which is safe, and is
// only logged.
func (w *Watcher) reconcile(ctx context.Context, id string) error {
	container, err := w.cfg.Engine.Inspect(ctx, id)
	if errors.Is(err, ErrNotFound) {
		// Removed before it could be read (docker run --rm of a short
		// command): its hosts file went with it.
		return nil
	}
	if err != nil {
		// A container that exists but cannot be read may be a host-network
		// container carrying the guest's pin, and nothing here can vouch for
		// it, so this is not a failure to shrug off.
		return fmt.Errorf("inspect container %s: %w", short(id), err)
	}
	if !container.Running || container.HostsPath == "" {
		return nil
	}
	read := func(path string) ([]byte, error) { return w.cfg.ReadFile(container.Pid, path) }
	if TrustsCA(container.Env, read, w.cfg.CAPEM) {
		w.mu.Lock()
		defer w.mu.Unlock()
		if w.closed {
			return nil
		}
		switch err := w.cfg.Pin(container.HostsPath, w.cfg.Addr, w.cfg.Host); {
		case err == nil:
			w.pinned[container.ID] = container.HostsPath
			w.cfg.Logf("job cache: container %s trusts the interceptor CA; pinned %s", short(container.ID), w.cfg.Host)
		case errors.Is(err, hostspin.ErrClaimedByOther):
			w.cfg.Logf("job cache: container %s maps %s itself; left as is", short(container.ID), w.cfg.Host)
		default:
			w.cfg.Logf("job cache: pin container %s: %v", short(container.ID), err)
		}
		return nil
	}
	if err := w.cfg.Unpin(container.HostsPath); err != nil {
		return fmt.Errorf("remove the cache pin from container %s, which does not trust the interceptor CA: %w", short(container.ID), err)
	}
	return nil
}

// Wait returns when the Watcher stops: nil after Close, the failure otherwise.
func (w *Watcher) Wait() error {
	<-w.done
	return w.err
}

// Close stops the Watcher and removes every pin it wrote. It is safe to call
// more than once.
func (w *Watcher) Close() {
	w.cancel()
	_ = w.stream.Close()
	<-w.done
	w.unpinAll()
}

func (w *Watcher) unpinAll() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.closed = true
	for id, path := range w.pinned {
		if err := w.cfg.Unpin(path); err != nil {
			w.cfg.Logf("job cache: unpin container %s: %v", short(id), err)
		}
		delete(w.pinned, id)
	}
}

func short(id string) string {
	if len(id) > 12 {
		return id[:12]
	}
	return id
}
