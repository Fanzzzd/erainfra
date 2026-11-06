// Package gocacheprog is a GOCACHEPROG program for cmd/go (Go 1.24 and later)
// with two tiers: a directory on local disk, which is always consulted first,
// and EraInfra's cache service behind it, reached through the guest's build
// cache proxy.
//
// The protocol is cmd/go/internal/cacheprog: JSON messages over stdin and
// stdout, one per line. The program announces the commands it knows, then
// answers each "get", "put" and "close" request by ID, in any order. A body
// travels with a "put" as a base64 JSON string on the line after the request.
// Every hit and every put must name a file on local disk that holds the body
// and outlives the go command, which is why the local tier is not optional.
//
// The remote tier fails open. cmd/go treats a GOCACHEPROG that exits or
// answers an error as fatal to the build, so nothing the cache service does
// (being down, slow, refusing, or serving bytes that do not hash to their
// output ID) becomes an error here: a get becomes a miss, an upload is
// skipped, and one line on stderr says why, once.
package gocacheprog

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// OutputIDHeader matches the cache service's server.GoOutputIDHeader.
const OutputIDHeader = "X-Erainfra-Go-Output-Id"

// The commands cmd/go may send.
const (
	cmdGet   = "get"
	cmdPut   = "put"
	cmdClose = "close"
)

// request and response mirror cmd/go/internal/cacheprog.Request and Response,
// which are internal to cmd/go. []byte fields are base64 in JSON, as cmd/go
// encodes them.
type request struct {
	ID       int64
	Command  string
	ActionID []byte `json:",omitempty"`
	OutputID []byte `json:",omitempty"`
	BodySize int64  `json:",omitempty"`
}

type response struct {
	ID            int64
	Err           string     `json:",omitempty"`
	KnownCommands []string   `json:",omitempty"`
	Miss          bool       `json:",omitempty"`
	OutputID      []byte     `json:",omitempty"`
	Size          int64      `json:",omitempty"`
	Time          *time.Time `json:",omitempty"`
	DiskPath      string     `json:",omitempty"`
}

// Config is the helper's configuration, normally read from the environment by
// ConfigFromEnv.
type Config struct {
	// Dir is the local tier. Required.
	Dir string
	// RemoteURL is the build cache proxy's base URL. Empty means local only.
	RemoteURL string
	// Client reaches RemoteURL. Nil builds one with conservative timeouts.
	Client *http.Client
	// Stderr receives the fail-open lines and, when Verbose, a summary.
	Stderr io.Writer
	// Verbose prints one summary line when cmd/go closes the helper.
	Verbose bool
	// Concurrency bounds remote requests in flight, gets and uploads each.
	// Zero means 16.
	Concurrency int
	// FlushTimeout is how long close waits for uploads still in flight. Zero
	// means one minute.
	FlushTimeout time.Duration
}

// ConfigFromEnv reads the configuration the job environment provides.
//
//   - ERAINFRA_BUILD_CACHE_URL: the guest's build cache proxy, set by the
//     guest whenever a cache is configured. Unset means local only.
//   - ERAINFRA_GOCACHEPROG_DIR: the local tier. Defaults to a directory under
//     GOCACHE (which cmd/go sets for the programs it starts), so a workflow
//     that saves GOCACHE with actions/cache saves this tier with it.
//   - ERAINFRA_GOCACHEPROG_VERBOSE=1: a summary line per go command.
func ConfigFromEnv(getenv func(string) string) (Config, error) {
	dir := getenv("ERAINFRA_GOCACHEPROG_DIR")
	if dir == "" {
		base := getenv("GOCACHE")
		if base == "" || base == "off" {
			userCache, err := os.UserCacheDir()
			if err != nil {
				return Config{}, fmt.Errorf("no ERAINFRA_GOCACHEPROG_DIR, GOCACHE or user cache directory: %w", err)
			}
			base = filepath.Join(userCache, "go-build")
		}
		dir = filepath.Join(base, "erainfra-gocacheprog")
	}
	return Config{
		Dir:       dir,
		RemoteURL: strings.TrimSuffix(getenv("ERAINFRA_BUILD_CACHE_URL"), "/"),
		Verbose:   getenv("ERAINFRA_GOCACHEPROG_VERBOSE") == "1",
	}, nil
}

// Run speaks the protocol on stdin and stdout until cmd/go sends "close" or
// closes stdin. It returns an error only for a broken protocol stream, which
// cmd/go would fail on anyway.
func Run(ctx context.Context, cfg Config, stdin io.Reader, stdout io.Writer) error {
	if cfg.Dir == "" {
		return errors.New("gocacheprog: a local cache directory is required")
	}
	dir, err := filepath.Abs(cfg.Dir)
	if err != nil {
		return err
	}
	for _, sub := range []string{"a", "o", "tmp"} {
		if err := os.MkdirAll(filepath.Join(dir, sub), 0o755); err != nil {
			return fmt.Errorf("gocacheprog: create the local cache: %w", err)
		}
	}
	h := newHelper(ctx, cfg, dir)
	out := bufio.NewWriter(stdout)
	encoder := json.NewEncoder(out)
	var writeMu sync.Mutex
	reply := func(res response) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		if err := encoder.Encode(res); err != nil {
			return err
		}
		return out.Flush()
	}
	if err := reply(response{KnownCommands: []string{cmdGet, cmdPut, cmdClose}}); err != nil {
		return err
	}

	decoder := json.NewDecoder(bufio.NewReader(stdin))
	var handlers sync.WaitGroup
	defer handlers.Wait()
	for {
		var req request
		if err := decoder.Decode(&req); err != nil {
			handlers.Wait()
			h.finish()
			if errors.Is(err, io.EOF) {
				return nil
			}
			return fmt.Errorf("gocacheprog: read request: %w", err)
		}
		switch req.Command {
		case cmdPut:
			var body []byte
			if req.BodySize > 0 {
				// The body is the next JSON value, a base64 string, which
				// encoding/json decodes into []byte.
				if err := decoder.Decode(&body); err != nil {
					return fmt.Errorf("gocacheprog: read put body: %w", err)
				}
			}
			handlers.Go(func() { _ = reply(h.put(req, body)) })
		case cmdGet:
			handlers.Go(func() { _ = reply(h.get(req)) })
		case cmdClose:
			handlers.Wait()
			h.finish()
			return reply(response{ID: req.ID})
		default:
			if err := reply(response{ID: req.ID, Err: "unknown command " + strconv.Quote(req.Command)}); err != nil {
				return err
			}
		}
	}
}

type helper struct {
	ctx    context.Context
	dir    string
	remote string
	client *http.Client
	stderr io.Writer
	cfg    Config

	gets    chan struct{}
	uploads chan struct{}
	pending sync.WaitGroup

	remoteOff atomic.Bool
	writesOff atomic.Bool
	logged    sync.Map

	localHits, remoteHits, misses, uploaded atomic.Int64
}

func newHelper(ctx context.Context, cfg Config, dir string) *helper {
	concurrency := cfg.Concurrency
	if concurrency <= 0 {
		concurrency = 16
	}
	client := cfg.Client
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Minute}
	}
	stderr := cfg.Stderr
	if stderr == nil {
		stderr = io.Discard
	}
	return &helper{
		ctx: ctx, dir: dir, remote: cfg.RemoteURL, client: client, stderr: stderr, cfg: cfg,
		gets:    make(chan struct{}, concurrency),
		uploads: make(chan struct{}, concurrency),
	}
}

// say writes one line to stderr, which cmd/go passes through to the job log.
// A write that fails has nowhere better to be reported.
func (h *helper) say(format string, args ...any) {
	_, _ = fmt.Fprintf(h.stderr, "erainfra-gocacheprog: "+format+"\n", args...)
}

// warnOnce writes one line per reason for the life of this go command.
func (h *helper) warnOnce(reason, format string, args ...any) {
	if _, seen := h.logged.LoadOrStore(reason, true); !seen {
		h.say(format, args...)
	}
}

// disableRemote turns the remote tier off for the rest of this go command,
// so a service that is down costs one timeout, not one per package.
func (h *helper) disableRemote(format string, args ...any) {
	if h.remoteOff.CompareAndSwap(false, true) {
		h.say(format+"; building with the local cache only", args...)
	}
}

func (h *helper) remoteOn() bool { return h.remote != "" && !h.remoteOff.Load() }

func (h *helper) actionPath(actionID string) string {
	return filepath.Join(h.dir, "a", actionID[:2], actionID)
}

func (h *helper) outputPath(outputID string) string {
	return filepath.Join(h.dir, "o", outputID[:2], outputID)
}

func (h *helper) get(req request) response {
	if len(req.ActionID) == 0 {
		return response{ID: req.ID, Err: "get without an action ID"}
	}
	actionID := hex.EncodeToString(req.ActionID)
	if res, ok := h.getLocal(req.ID, actionID); ok {
		h.localHits.Add(1)
		return res
	}
	if h.remoteOn() {
		if res, ok := h.getRemote(req.ID, actionID); ok {
			h.remoteHits.Add(1)
			return res
		}
	}
	h.misses.Add(1)
	return response{ID: req.ID, Miss: true}
}

// actionRecord is the local index line for an action: which output it
// produced, how big, and when it was stored.
type actionRecord struct {
	OutputID string `json:"o"`
	Size     int64  `json:"s"`
	Time     int64  `json:"t"`
}

func (h *helper) getLocal(id int64, actionID string) (response, bool) {
	raw, err := os.ReadFile(h.actionPath(actionID))
	if err != nil {
		return response{}, false
	}
	var record actionRecord
	if json.Unmarshal(raw, &record) != nil || len(record.OutputID) != 64 {
		return response{}, false
	}
	path := h.outputPath(record.OutputID)
	info, err := os.Stat(path)
	if err != nil || info.Size() != record.Size {
		return response{}, false
	}
	outputID, err := hex.DecodeString(record.OutputID)
	if err != nil {
		return response{}, false
	}
	stamp := time.Unix(0, record.Time)
	return response{ID: id, OutputID: outputID, Size: record.Size, Time: &stamp, DiskPath: path}, true
}

func (h *helper) getRemote(id int64, actionID string) (response, bool) {
	select {
	case h.gets <- struct{}{}:
		defer func() { <-h.gets }()
	case <-h.ctx.Done():
		return response{}, false
	}
	request, err := http.NewRequestWithContext(h.ctx, http.MethodGet, h.remote+"/go/"+actionID, nil)
	if err != nil {
		return response{}, false
	}
	resp, err := h.client.Do(request)
	if err != nil {
		h.disableRemote("the build cache is unreachable (%v)", err)
		return response{}, false
	}
	defer resp.Body.Close() //nolint:errcheck // read-only body; a close error loses nothing
	switch resp.StatusCode {
	case http.StatusOK:
	case http.StatusNotFound:
		return response{}, false
	case http.StatusUnauthorized:
		// The service has no facts for this runner, which does not change
		// within one go command.
		h.disableRemote("the build cache does not recognise this job yet (401)")
		return response{}, false
	default:
		h.disableRemote("the build cache answered %d", resp.StatusCode)
		return response{}, false
	}
	outputID := strings.ToLower(resp.Header.Get(OutputIDHeader))
	if len(outputID) != 64 {
		h.warnOnce("bad-output-id", "the build cache sent an entry without a valid output ID; treating it as a miss")
		return response{}, false
	}
	size, err := h.storeVerified(resp.Body, outputID, resp.ContentLength)
	if err != nil {
		h.warnOnce("bad-body", "a build cache download was discarded: %v", err)
		return response{}, false
	}
	now := time.Now()
	if err := h.writeAction(actionID, actionRecord{OutputID: outputID, Size: size, Time: now.UnixNano()}); err != nil {
		return response{}, false
	}
	raw, _ := hex.DecodeString(outputID)
	return response{ID: id, OutputID: raw, Size: size, Time: &now, DiskPath: h.outputPath(outputID)}, true
}

// storeVerified writes a downloaded body into the local tier only if it
// hashes to its output ID, which cmd/go defines as the SHA-256 of the body. A
// truncated or corrupted download is therefore a miss, never a bad object
// handed to the compiler.
func (h *helper) storeVerified(body io.Reader, outputID string, declared int64) (int64, error) {
	final := h.outputPath(outputID)
	if info, err := os.Stat(final); err == nil && (declared < 0 || info.Size() == declared) {
		// Already here from an earlier action with the same output. Drain so
		// the connection can be reused.
		_, _ = io.Copy(io.Discard, body)
		return info.Size(), nil
	}
	tmp, err := os.CreateTemp(filepath.Join(h.dir, "tmp"), "get-*")
	if err != nil {
		return 0, err
	}
	defer os.Remove(tmp.Name()) //nolint:errcheck // gone after the rename; this only cleans up a failure
	hash := sha256.New()
	size, err := io.Copy(io.MultiWriter(tmp, hash), body)
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return 0, err
	}
	if declared >= 0 && size != declared {
		return 0, fmt.Errorf("received %d of %d bytes", size, declared)
	}
	if got := hex.EncodeToString(hash.Sum(nil)); got != outputID {
		return 0, fmt.Errorf("the body hashes to %s, not its output ID %s", got[:12], outputID[:12])
	}
	if err := os.MkdirAll(filepath.Dir(final), 0o755); err != nil {
		return 0, err
	}
	return size, os.Rename(tmp.Name(), final)
}

func (h *helper) put(req request, body []byte) response {
	if len(req.ActionID) == 0 || len(req.OutputID) == 0 {
		return response{ID: req.ID, Err: "put without an action or output ID"}
	}
	if int64(len(body)) != req.BodySize {
		return response{ID: req.ID, Err: fmt.Sprintf("put body is %d bytes, BodySize says %d", len(body), req.BodySize)}
	}
	actionID := hex.EncodeToString(req.ActionID)
	outputID := hex.EncodeToString(req.OutputID)
	path := h.outputPath(outputID)
	if err := h.writeOutput(path, body); err != nil {
		return response{ID: req.ID, Err: "write the local cache: " + err.Error()}
	}
	if err := h.writeAction(actionID, actionRecord{OutputID: outputID, Size: int64(len(body)), Time: time.Now().UnixNano()}); err != nil {
		return response{ID: req.ID, Err: "write the local cache: " + err.Error()}
	}
	// The upload runs behind the answer: cmd/go has what it needs once the
	// body is on local disk, and close waits for whatever is still in flight.
	if h.remoteOn() && !h.writesOff.Load() {
		h.pending.Go(func() { h.upload(actionID, outputID, path) })
	}
	return response{ID: req.ID, DiskPath: path}
}

func (h *helper) upload(actionID, outputID, path string) {
	select {
	case h.uploads <- struct{}{}:
		defer func() { <-h.uploads }()
	case <-h.ctx.Done():
		return
	}
	if !h.remoteOn() || h.writesOff.Load() {
		return
	}
	file, err := os.Open(path)
	if err != nil {
		return
	}
	defer file.Close() //nolint:errcheck // read-only file
	info, err := file.Stat()
	if err != nil {
		return
	}
	request, err := http.NewRequestWithContext(h.ctx, http.MethodPut, h.remote+"/go/"+actionID, file)
	if err != nil {
		return
	}
	request.ContentLength = info.Size()
	if info.Size() == 0 {
		request.Body = http.NoBody
	}
	request.Header.Set(OutputIDHeader, outputID)
	request.Header.Set("Content-Type", "application/octet-stream")
	resp, err := h.client.Do(request)
	if err != nil {
		h.disableRemote("the build cache is unreachable (%v)", err)
		return
	}
	defer resp.Body.Close() //nolint:errcheck // read-only body; a close error loses nothing
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
	switch {
	case resp.StatusCode/100 == 2:
		h.uploaded.Add(1)
	case resp.StatusCode == http.StatusForbidden:
		// A fork pull request: it reads the cache and may not write to it.
		// That is policy, not a fault, so reads carry on.
		if h.writesOff.CompareAndSwap(false, true) {
			h.say("this job may read the build cache but not write to it; uploads skipped")
		}
	case resp.StatusCode == http.StatusRequestEntityTooLarge:
		h.warnOnce("too-large", "a build output is larger than the cache accepts; it stays local")
	default:
		h.disableRemote("the build cache answered %d to an upload", resp.StatusCode)
	}
}

// finish waits for uploads, bounded, and prints the summary when asked to.
func (h *helper) finish() {
	timeout := h.cfg.FlushTimeout
	if timeout <= 0 {
		timeout = time.Minute
	}
	done := make(chan struct{})
	go func() {
		h.pending.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(timeout):
		h.warnOnce("flush", "uploads still running after %s were abandoned", timeout)
	}
	if h.cfg.Verbose {
		h.say("%d local hits, %d remote hits, %d misses, %d uploaded",
			h.localHits.Load(), h.remoteHits.Load(), h.misses.Load(), h.uploaded.Load())
	}
}

// writeOutput stores a body under its output ID. Two actions can share an
// output, and an output ID names its bytes, so one already in place is kept.
func (h *helper) writeOutput(path string, body []byte) error {
	if info, err := os.Stat(path); err == nil && info.Size() == int64(len(body)) {
		return nil
	}
	return h.writeAtomic(path, body)
}

func (h *helper) writeAction(actionID string, record actionRecord) error {
	raw, err := json.Marshal(record)
	if err != nil {
		return err
	}
	return h.writeAtomic(h.actionPath(actionID), raw)
}

// writeAtomic writes through a temporary file and a rename, so a concurrent
// reader or a second go command sees the old file or the new one, never half
// of one.
func (h *helper) writeAtomic(path string, body []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Join(h.dir, "tmp"), "put-*")
	if err != nil {
		return err
	}
	if _, err := tmp.Write(body); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmp.Name())
		return err
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmp.Name())
		return err
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		_ = os.Remove(tmp.Name())
		return err
	}
	return nil
}
