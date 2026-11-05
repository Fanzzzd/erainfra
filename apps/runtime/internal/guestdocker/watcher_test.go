package guestdocker

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

	"github.com/Fanzzzd/erainfra/apps/runtime/internal/hostspin"
)

const cacheHost = "results-receiver.actions.githubusercontent.com"

var pinAddr = net.ParseIP("100.64.0.1")

// fakeEngine is a daemon in memory. Starting a container after Subscribe
// pushes its ID down the stream, the way dockerd would.
type fakeEngine struct {
	mu         sync.Mutex
	containers map[string]Container
	running    []string
	events     chan string
	streamErr  chan error
	inspectErr map[string]error
	subErr     error
}

func newFakeEngine() *fakeEngine {
	return &fakeEngine{
		containers: map[string]Container{},
		events:     make(chan string, 16),
		streamErr:  make(chan error, 1),
		inspectErr: map[string]error{},
	}
}

func (f *fakeEngine) Subscribe(context.Context) (EventStream, error) {
	if f.subErr != nil {
		return nil, f.subErr
	}
	return &fakeStream{engine: f, closed: make(chan struct{})}, nil
}

func (f *fakeEngine) Running(context.Context) ([]string, error) { return f.running, nil }

func (f *fakeEngine) Inspect(_ context.Context, id string) (Container, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.inspectErr[id]; err != nil {
		return Container{}, err
	}
	c, ok := f.containers[id]
	if !ok {
		return Container{}, ErrNotFound
	}
	return c, nil
}

func (f *fakeEngine) add(c Container) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.containers[c.ID] = c
}

type fakeStream struct {
	engine    *fakeEngine
	closed    chan struct{}
	closeOnce sync.Once
}

func (s *fakeStream) Next() (string, error) {
	select {
	case id := <-s.engine.events:
		return id, nil
	case err := <-s.engine.streamErr:
		return "", err
	case <-s.closed:
		return "", errors.New("closed")
	}
}

func (s *fakeStream) Close() error {
	s.closeOnce.Do(func() { close(s.closed) })
	return nil
}

// fixture holds one guest: a CA, the files inside each container keyed by
// pid, and a hosts file per container on disk.
type fixture struct {
	t      *testing.T
	ca     []byte
	engine *fakeEngine
	dir    string
	files  map[int]files
}

func newFixture(t *testing.T) *fixture {
	return &fixture{t: t, ca: mintCA(t), engine: newFakeEngine(), dir: t.TempDir(), files: map[int]files{}}
}

func (f *fixture) hostsFile(id, content string) string {
	path := filepath.Join(f.dir, id+"-hosts")
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		f.t.Fatal(err)
	}
	return path
}

func (f *fixture) read(pid int, path string) ([]byte, error) { return f.files[pid].read(path) }

func (f *fixture) config() WatcherConfig {
	return WatcherConfig{Engine: f.engine, CAPEM: f.ca, Addr: pinAddr, Host: cacheHost, ReadFile: f.read, Logf: f.t.Logf}
}

// trustingBuilder is a buildx builder created under the default
// buildkitd.toml and opted in with SSL_CERT_DIR.
func (f *fixture) trustingBuilder(id string, pid int) Container {
	f.files[pid] = files{builderCADir + "/" + CAFileName: f.ca}
	return Container{
		ID: id, Running: true, Pid: pid,
		Env:       []string{"SSL_CERT_DIR=/etc/ssl/certs:" + builderCADir},
		HostsPath: f.hostsFile(id, "127.0.0.1\tlocalhost\n172.17.0.2\t"+id+"\n"),
	}
}

func pinned(t *testing.T, path string) bool {
	t.Helper()
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return hostspin.Pinned(content)
}

func eventually(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("condition never held")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestWatcherPinsAContainerThatTrustsTheCAAndUnpinsOnClose(t *testing.T) {
	f := newFixture(t)
	builder := f.trustingBuilder("builder", 100)
	f.engine.add(builder)

	w, err := StartWatcher(t.Context(), f.config())
	if err != nil {
		t.Fatal(err)
	}
	f.engine.events <- "builder"
	eventually(t, func() bool { return pinned(t, builder.HostsPath) })

	w.Close()
	if pinned(t, builder.HostsPath) {
		t.Fatal("Close left the builder pinned to an interceptor that is going away")
	}
	if err := w.Wait(); err != nil {
		t.Fatalf("Wait after Close = %v, want nil", err)
	}
}

// A host-network container gets a copy of the guest's hosts file, pin and
// all. If its image does not trust the CA the pin must come out, or it fails
// TLS instead of reaching GitHub.
func TestWatcherStripsTheGuestPinFromAnUntrustingHostNetworkContainer(t *testing.T) {
	f := newFixture(t)
	guestCopy := "127.0.0.1\tlocalhost\n" + hostspin.Line(pinAddr, cacheHost) + "\n"
	hostNet := Container{ID: "hostnet", Running: true, Pid: 200, Env: []string{"PATH=/bin"}, HostsPath: f.hostsFile("hostnet", guestCopy)}
	f.engine.add(hostNet)

	w, err := StartWatcher(t.Context(), f.config())
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	f.engine.events <- "hostnet"
	eventually(t, func() bool { return !pinned(t, hostNet.HostsPath) })
}

// An ordinary bridge container that never opted in is left exactly as Docker
// wrote it.
func TestWatcherLeavesAnUntrustingBridgeContainerAlone(t *testing.T) {
	f := newFixture(t)
	original := "127.0.0.1\tlocalhost\n172.17.0.3\tsvc\n"
	service := Container{ID: "postgres", Running: true, Pid: 300, Env: []string{"POSTGRES_PASSWORD=x"}, HostsPath: f.hostsFile("postgres", original)}
	f.engine.add(service)
	builder := f.trustingBuilder("builder", 301)
	f.engine.add(builder)

	w, err := StartWatcher(t.Context(), f.config())
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	f.engine.events <- "postgres"
	f.engine.events <- "builder"
	// The builder after the service: once it is pinned, the service has
	// certainly been handled.
	eventually(t, func() bool { return pinned(t, builder.HostsPath) })
	content, _ := os.ReadFile(service.HostsPath)
	if string(content) != original {
		t.Fatalf("an untrusting bridge container's hosts file changed:\n%s", content)
	}
}

// Containers already running when the Watcher starts are brought into line
// before StartWatcher returns, so none can carry the pin unseen.
func TestStartWatcherReconcilesWhatIsAlreadyRunning(t *testing.T) {
	f := newFixture(t)
	builder := f.trustingBuilder("builder", 400)
	f.engine.add(builder)
	f.engine.running = []string{"builder", "gone"}

	w, err := StartWatcher(t.Context(), f.config())
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	if !pinned(t, builder.HostsPath) {
		t.Fatal("a running trusting container was not pinned at start")
	}
}

// A container that cannot have its pin removed is a container failing TLS:
// the Watcher stops and says why, so the caller tears the redirect down.
func TestWatcherStopsWhenItCannotUnpinAnUntrustingContainer(t *testing.T) {
	f := newFixture(t)
	hostNet := Container{ID: "hostnet", Running: true, Pid: 500, HostsPath: f.hostsFile("hostnet", hostspin.Line(pinAddr, cacheHost)+"\n")}
	f.engine.add(hostNet)
	cfg := f.config()
	cfg.Unpin = func(string) error { return errors.New("read-only file system") }

	w, err := StartWatcher(t.Context(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	f.engine.events <- "hostnet"
	if err := w.Wait(); err == nil || !strings.Contains(err.Error(), "read-only") {
		t.Fatalf("Wait = %v, want the unpin failure", err)
	}
}

func TestWatcherStopsWhenTheEventStreamBreaks(t *testing.T) {
	f := newFixture(t)
	w, err := StartWatcher(t.Context(), f.config())
	if err != nil {
		t.Fatal(err)
	}
	f.engine.streamErr <- errors.New("docker event stream ended")
	if err := w.Wait(); err == nil {
		t.Fatal("a broken event stream did not stop the Watcher")
	}
	w.Close() // still safe after the loop has gone
}

// An inspect failure for a container that still exists cannot be vouched for;
// one that is already gone took its hosts file with it.
func TestWatcherInspectFailures(t *testing.T) {
	f := newFixture(t)
	f.engine.inspectErr["broken"] = errors.New("500 Internal Server Error")
	w, err := StartWatcher(t.Context(), f.config())
	if err != nil {
		t.Fatal(err)
	}
	f.engine.events <- "removed-already"
	f.engine.events <- "broken"
	if err := w.Wait(); err == nil || !strings.Contains(err.Error(), "500") {
		t.Fatalf("Wait = %v, want the inspect failure", err)
	}
}

// A failure during the initial reconcile leaves nothing pinned behind it.
func TestStartWatcherFailsTransactionally(t *testing.T) {
	f := newFixture(t)
	builder := f.trustingBuilder("builder", 600)
	f.engine.add(builder)
	f.engine.inspectErr["broken"] = errors.New("500 Internal Server Error")
	f.engine.running = []string{"builder", "broken"}

	if _, err := StartWatcher(t.Context(), f.config()); err == nil {
		t.Fatal("StartWatcher succeeded past a failed reconcile")
	}
	if pinned(t, builder.HostsPath) {
		t.Fatal("a failed start left a container pinned")
	}
}

func TestStartWatcherRequiresItsInputs(t *testing.T) {
	f := newFixture(t)
	for name, tweak := range map[string]func(*WatcherConfig){
		"no engine": func(c *WatcherConfig) { c.Engine = nil },
		"no reader": func(c *WatcherConfig) { c.ReadFile = nil },
		"no CA":     func(c *WatcherConfig) { c.CAPEM = nil },
		"no addr":   func(c *WatcherConfig) { c.Addr = nil },
		"no host":   func(c *WatcherConfig) { c.Host = "" },
	} {
		cfg := f.config()
		tweak(&cfg)
		if _, err := StartWatcher(t.Context(), cfg); err == nil {
			t.Errorf("%s: StartWatcher succeeded", name)
		}
	}
	f.engine.subErr = errors.New("dial unix /var/run/docker.sock: connect: no such file")
	if _, err := StartWatcher(t.Context(), f.config()); err == nil {
		t.Error("StartWatcher succeeded without a daemon")
	}
}
