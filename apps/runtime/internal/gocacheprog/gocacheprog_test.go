package gocacheprog

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

// session drives Run the way cmd/go does: requests on stdin, a body as a
// base64 JSON string on the line after a put, responses read back by ID.
type session struct {
	t       *testing.T
	stdin   *io.PipeWriter
	replies *json.Decoder
	done    chan error
	stderr  *syncBuffer
	nextID  int64
}

type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func start(t *testing.T, cfg Config) *session {
	t.Helper()
	stdinR, stdinW := io.Pipe()
	stdoutR, stdoutW := io.Pipe()
	stderr := &syncBuffer{}
	cfg.Stderr = stderr
	if cfg.Dir == "" {
		cfg.Dir = t.TempDir()
	}
	s := &session{t: t, stdin: stdinW, replies: json.NewDecoder(bufio.NewReader(stdoutR)), done: make(chan error, 1), stderr: stderr}
	go func() {
		err := Run(t.Context(), cfg, stdinR, stdoutW)
		_ = stdoutW.Close()
		s.done <- err
	}()
	var hello response
	if err := s.replies.Decode(&hello); err != nil {
		t.Fatal(err)
	}
	if hello.ID != 0 || strings.Join(hello.KnownCommands, ",") != "get,put,close" {
		t.Fatalf("first message = %+v, want ID 0 announcing get, put and close", hello)
	}
	t.Cleanup(func() { _ = stdinW.Close() })
	return s
}

func (s *session) send(req request, body []byte) response {
	s.t.Helper()
	s.nextID++
	req.ID = s.nextID
	line, err := json.Marshal(req)
	if err != nil {
		s.t.Fatal(err)
	}
	if _, err := s.stdin.Write(append(line, '\n')); err != nil {
		s.t.Fatal(err)
	}
	if req.BodySize > 0 {
		encoded, _ := json.Marshal(base64.StdEncoding.EncodeToString(body))
		if _, err := s.stdin.Write(append(encoded, '\n')); err != nil {
			s.t.Fatal(err)
		}
	}
	var res response
	if err := s.replies.Decode(&res); err != nil {
		s.t.Fatal(err)
	}
	if res.ID != req.ID {
		s.t.Fatalf("response ID %d to request %d", res.ID, req.ID)
	}
	return res
}

func (s *session) get(action []byte) response {
	return s.send(request{Command: cmdGet, ActionID: action}, nil)
}

func (s *session) put(action, body []byte) response {
	output := sha256.Sum256(body)
	return s.send(request{Command: cmdPut, ActionID: action, OutputID: output[:], BodySize: int64(len(body))}, body)
}

func (s *session) close() {
	s.t.Helper()
	s.send(request{Command: cmdClose}, nil)
	if err := <-s.done; err != nil {
		s.t.Fatalf("Run returned %v after close", err)
	}
}

func id(label string) []byte {
	sum := sha256.Sum256([]byte(label))
	return sum[:]
}

func TestLocalTierAnswersWithAFileOnDisk(t *testing.T) {
	s := start(t, Config{})
	if res := s.get(id("compile fmt")); !res.Miss {
		t.Fatalf("get on an empty cache = %+v, want a miss", res)
	}
	body := []byte("object code")
	put := s.put(id("compile fmt"), body)
	if put.Err != "" || put.DiskPath == "" {
		t.Fatalf("put = %+v", put)
	}
	got := s.get(id("compile fmt"))
	if got.Miss || got.Size != int64(len(body)) || got.DiskPath != put.DiskPath || got.Time == nil {
		t.Fatalf("get after put = %+v", got)
	}
	want := sha256.Sum256(body)
	if !bytes.Equal(got.OutputID, want[:]) {
		t.Fatal("the output ID is not the one stored")
	}
	onDisk, err := os.ReadFile(got.DiskPath)
	if err != nil || !bytes.Equal(onDisk, body) {
		t.Fatalf("DiskPath holds %q, %v", onDisk, err)
	}
	// An empty output is a real case (a package with nothing to export).
	if res := s.put(id("empty"), nil); res.Err != "" {
		t.Fatalf("empty put = %+v", res)
	}
	if res := s.get(id("empty")); res.Miss || res.Size != 0 {
		t.Fatalf("empty get = %+v", res)
	}
	s.close()
}

// fakeRemote is the build cache proxy's /go/ surface, recording what reached
// it.
type fakeRemote struct {
	mu      sync.Mutex
	entries map[string][]byte
	outputs map[string]string
	puts    int
	gets    int
	putCode int
	lie     bool
}

func newFakeRemote(t *testing.T) (*fakeRemote, string) {
	t.Helper()
	remote := &fakeRemote{entries: map[string][]byte{}, outputs: map[string]string{}}
	server := httptest.NewServer(remote)
	t.Cleanup(server.Close)
	return remote, server.URL
}

func (f *fakeRemote) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	action := strings.TrimPrefix(r.URL.Path, "/go/")
	switch r.Method {
	case http.MethodGet:
		f.gets++
		body, ok := f.entries[action]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		output := f.outputs[action]
		if f.lie {
			body = append([]byte("tampered "), body...)
		}
		w.Header().Set(OutputIDHeader, output)
		w.Header().Set("Content-Length", fmt.Sprint(len(body)))
		_, _ = w.Write(body)
	case http.MethodPut:
		f.puts++
		if f.putCode != 0 {
			w.WriteHeader(f.putCode)
			return
		}
		body, _ := io.ReadAll(r.Body)
		f.entries[action] = body
		f.outputs[action] = r.Header.Get(OutputIDHeader)
		w.WriteHeader(http.StatusNoContent)
	}
}

func (f *fakeRemote) seed(action, body []byte) {
	f.mu.Lock()
	defer f.mu.Unlock()
	sum := sha256.Sum256(body)
	f.entries[hex.EncodeToString(action)] = body
	f.outputs[hex.EncodeToString(action)] = hex.EncodeToString(sum[:])
}

// A put lands locally at once and reaches the remote tier before close
// returns; a later go command with an empty local tier then gets it from the
// remote tier into a verified file on its own disk.
func TestUploadsReachTheRemoteTierAndComeBack(t *testing.T) {
	remote, url := newFakeRemote(t)
	first := start(t, Config{RemoteURL: url, Verbose: true})
	first.put(id("compile net/http"), []byte("big object"))
	first.close()
	remote.mu.Lock()
	uploaded := len(remote.entries)
	remote.mu.Unlock()
	if uploaded != 1 {
		t.Fatalf("%d entries reached the remote tier by close, want 1", uploaded)
	}
	if !strings.Contains(first.stderr.String(), "0 local hits, 0 remote hits, 0 misses, 1 uploaded") {
		t.Fatalf("summary = %q", first.stderr.String())
	}

	second := start(t, Config{RemoteURL: url})
	got := second.get(id("compile net/http"))
	if got.Miss {
		t.Fatal("a later job with an empty local tier missed the remote entry")
	}
	onDisk, err := os.ReadFile(got.DiskPath)
	if err != nil || string(onDisk) != "big object" {
		t.Fatalf("remote hit on disk = %q, %v", onDisk, err)
	}
	// The second get is answered from the local tier, without the network.
	remote.mu.Lock()
	gets := remote.gets
	remote.mu.Unlock()
	second.get(id("compile net/http"))
	remote.mu.Lock()
	defer remote.mu.Unlock()
	if remote.gets != gets {
		t.Fatal("a local hit went to the remote tier")
	}
	second.close()
}

// Bytes that do not hash to their output ID never reach cmd/go: the get is a
// miss and stderr says so once.
func TestARemoteEntryThatDoesNotMatchItsOutputIDIsAMiss(t *testing.T) {
	remote, url := newFakeRemote(t)
	remote.seed(id("a"), []byte("first"))
	remote.seed(id("b"), []byte("second"))
	remote.lie = true
	s := start(t, Config{RemoteURL: url})
	for _, action := range [][]byte{id("a"), id("b")} {
		if res := s.get(action); !res.Miss {
			t.Fatalf("a tampered entry was served: %+v", res)
		}
	}
	s.close()
	if got := strings.Count(s.stderr.String(), "\n"); got != 1 || !strings.Contains(s.stderr.String(), "discarded") {
		t.Fatalf("stderr = %q, want one line", s.stderr.String())
	}
}

// An unreachable cache costs one failed request and one line; every later get
// is a local miss and every put still succeeds locally.
func TestAnUnreachableRemoteFailsOpenWithOneLine(t *testing.T) {
	listener, err := (&net.ListenConfig{}).Listen(t.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	dead := "http://" + listener.Addr().String()
	_ = listener.Close()
	s := start(t, Config{RemoteURL: dead, Client: &http.Client{Timeout: 5 * time.Second}})
	for i := range 20 {
		if res := s.get(id(fmt.Sprint("get", i))); !res.Miss || res.Err != "" {
			t.Fatalf("get %d = %+v, want a plain miss", i, res)
		}
		if res := s.put(id(fmt.Sprint("put", i)), []byte("x")); res.Err != "" || res.DiskPath == "" {
			t.Fatalf("put %d = %+v, want a local success", i, res)
		}
	}
	s.close()
	stderr := s.stderr.String()
	if strings.Count(stderr, "\n") != 1 || !strings.Contains(stderr, "unreachable") || !strings.Contains(stderr, "local cache only") {
		t.Fatalf("stderr = %q, want exactly one line", stderr)
	}
}

// A read-only job (a fork pull request) keeps reading after its first upload
// is refused, and stops uploading.
func TestARefusedUploadStopsUploadsButNotReads(t *testing.T) {
	remote, url := newFakeRemote(t)
	remote.putCode = http.StatusForbidden
	remote.seed(id("base branch output"), []byte("from main"))
	s := start(t, Config{RemoteURL: url, Concurrency: 1})
	s.put(id("fork output 1"), []byte("x"))
	s.close()

	s = start(t, Config{RemoteURL: url, Concurrency: 1})
	s.put(id("fork output 2"), []byte("y"))
	// Let the first refused upload land before the rest are queued.
	deadline := time.Now().Add(5 * time.Second)
	for {
		remote.mu.Lock()
		puts := remote.puts
		remote.mu.Unlock()
		if puts >= 2 || time.Now().After(deadline) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	for i := range 5 {
		s.put(id(fmt.Sprint("more fork output", i)), []byte("z"))
	}
	if res := s.get(id("base branch output")); res.Miss {
		t.Fatal("a read-only job stopped reading after its upload was refused")
	}
	s.close()
	remote.mu.Lock()
	defer remote.mu.Unlock()
	if remote.puts != 2 {
		t.Fatalf("%d uploads were attempted across the two commands, want one each", remote.puts)
	}
	if !strings.Contains(s.stderr.String(), "may read the build cache but not write") {
		t.Fatalf("stderr = %q", s.stderr.String())
	}
}

func TestConfigFromEnv(t *testing.T) {
	env := map[string]string{"GOCACHE": "/home/runner/.cache/go-build", "ERAINFRA_BUILD_CACHE_URL": "http://127.0.0.1:7457/"}
	cfg, err := ConfigFromEnv(func(name string) string { return env[name] })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Dir != "/home/runner/.cache/go-build/erainfra-gocacheprog" || cfg.RemoteURL != "http://127.0.0.1:7457" || cfg.Verbose {
		t.Fatalf("config = %+v", cfg)
	}
	env["ERAINFRA_GOCACHEPROG_DIR"] = "/tmp/elsewhere"
	env["ERAINFRA_GOCACHEPROG_VERBOSE"] = "1"
	cfg, _ = ConfigFromEnv(func(name string) string { return env[name] })
	if cfg.Dir != "/tmp/elsewhere" || !cfg.Verbose {
		t.Fatalf("config = %+v", cfg)
	}
}

// cmd/go may close stdin without sending close (it does when it has no
// close capability to use); that is a clean exit, after the uploads.
func TestStdinClosedWithoutCloseIsACleanExit(t *testing.T) {
	remote, url := newFakeRemote(t)
	s := start(t, Config{RemoteURL: url})
	s.put(id("last"), []byte("bytes"))
	_ = s.stdin.Close()
	if err := <-s.done; err != nil {
		t.Fatalf("Run = %v after EOF", err)
	}
	remote.mu.Lock()
	defer remote.mu.Unlock()
	if len(remote.entries) != 1 {
		t.Fatal("the upload in flight at EOF was lost")
	}
}
