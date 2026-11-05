package convexnode

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/Fanzzzd/erainfra/apps/infra-agent/internal/agent"
)

const maxWireBytes = 256 * 1024

var appNamePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)
var imagePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,511}$`)
var envNamePattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
var credentialPattern = regexp.MustCompile(`^erainfra_node_[0-9a-f]{64}$`)

// Config does not read Hub environment variables. Main validates both modes before starting
// either transport, so an existing Hub connection can never silently turn into a Convex one.
type Config struct {
	URL, Credential, StateDir, Version string
	AllowHTTPForTests                  bool
}

func ValidateMode(mode, hub, convexURL, credential string) error {
	if mode == "connect" && (convexURL != "" || credential != "") {
		return errors.New("hub and Convex modes are mutually exclusive")
	}
	if mode == "connect-convex" && hub != "" {
		return errors.New("unset Hub configuration before using Convex mode")
	}
	return nil
}

// Payload is a claimed command's work, built by Convex from its own rows. Spec and build payloads
// come from the deploy pipeline (packages/backend/convex/infra/pipeline.ts): a source to fetch, a
// build context inside it and the image to push. None of them carries argv.
type Payload struct {
	Kind      string             `json:"kind"`
	Operation agent.Operation    `json:"operation"`
	App       string             `json:"app"`
	Services  []agent.Service    `json:"services"`
	Service   string             `json:"service"`
	Source    agent.ConvexSource `json:"source"`
	Dir       string             `json:"dir"`
	Image     string             `json:"image"`
}
type Executor interface {
	Execute(context.Context, Payload) string
}

// SpecReader is the spec step. It is separate from Execute because it is the one step that
// returns data, and because it has no effect on the Node, a re-delivered spec command is read
// again rather than replayed from the journal.
type SpecReader interface {
	ReadSpec(context.Context, Payload) (string, error)
}

// LocalExecutor reuses the existing Go allowlist and deployment implementation. Outputs are
// deliberately discarded: logs/child errors may contain secrets and are not command results.
type LocalExecutor struct {
	Runner  agent.ShellRunner
	Builder agent.ConvexBuilder
}

var buildDirPattern = regexp.MustCompile(`^[A-Za-z0-9._/-]{0,255}$`)

func validSource(s agent.ConvexSource) bool {
	return (s.Kind == "upload" && s.URL != "") || (s.Kind == "git" && s.Repo != "" && s.Ref != "")
}

func (e LocalExecutor) ReadSpec(ctx context.Context, p Payload) (string, error) {
	if p.Kind != "spec" || !validSource(p.Source) {
		return "", errors.New("invalid spec payload")
	}
	e.Runner.OutputLimit = 16 * 1024
	spec, err := e.Builder.ReadConvexSpec(ctx, e.Runner, p.Source)
	if err != nil {
		// The error names the step, never the source URL or token.
		fmt.Fprintf(os.Stderr, "[erainfra] reading the spec failed: %v\n", err)
	}
	return spec, err
}

func (e LocalExecutor) Execute(ctx context.Context, p Payload) string {
	e.Runner.OutputLimit = 16 * 1024
	var err error
	switch p.Kind {
	case "build":
		if !appNamePattern.MatchString(p.App) || !appNamePattern.MatchString(p.Service) || !validSource(p.Source) ||
			!buildDirPattern.MatchString(p.Dir) || strings.HasPrefix(p.Dir, "/") || strings.Contains(p.Dir, "..") ||
			agent.ValidateImageRef(p.Image) != nil {
			return "failure"
		}
		var out string
		out, err = e.Builder.BuildConvexImage(ctx, e.Runner, p.Source, p.Dir, p.Image)
		if err != nil {
			// Build output is the repository's own; it stays in this Node's log and is never
			// uploaded. Bounded by OutputLimit.
			fmt.Fprintf(os.Stderr, "[erainfra] build %s/%s failed: %v\n%s\n", p.App, p.Service, err, out)
		}
	case "operate":
		var cmd agent.Command
		cmd, err = agent.Resolve(p.Operation)
		if err == nil {
			_, err = e.Runner.Execute(ctx, cmd)
		}
	case "deploy":
		if !appNamePattern.MatchString(p.App) || len(p.Services) == 0 || len(p.Services) > 32 {
			return "failure"
		}
		for _, s := range p.Services {
			if !appNamePattern.MatchString(s.Name) || !imagePattern.MatchString(s.Image) {
				return "failure"
			}
			for key, value := range s.Env {
				if !envNamePattern.MatchString(key) || len(value) > 65536 || strings.ContainsAny(value, "\r\n\x00") {
					return "failure"
				}
			}
		}
		_, err = e.Runner.DeployApp(ctx, p.App, p.Services)
	default:
		return "failure"
	}
	if ctx.Err() != nil {
		return "unknown"
	}
	if err != nil {
		return "failure"
	}
	return "success"
}

type Client struct {
	cfg            Config
	http           *http.Client
	journal        *Journal
	exec           Executor
	owner          string
	cursor, nodeID string
	lastHeartbeat  time.Time
	// RenewInterval is shorter in in-memory server tests. Production uses 10 seconds.
	RenewInterval time.Duration
	// Mesh, when set before Run, publishes this Node's endpoint and applies Convex's mesh snapshot
	// to the local sidecar in a loop of its own, so a mesh failure never delays a command.
	Mesh *MeshOptions

	now        func() time.Time // the mesh loop and heartbeat bookkeeping share one clock
	regMu      sync.Mutex
	registered registration
}

// registration is the Node's EndpointId as the last heartbeat reported it.
type registration struct {
	known bool
	id    string    // "" when no key is registered
	at    time.Time // when the heartbeat was sent, so it reflects every write that finished before
}

func (c *Client) setRegistered(id string, sent time.Time) {
	c.regMu.Lock()
	defer c.regMu.Unlock()
	c.registered = registration{known: true, id: id, at: sent}
}
func (c *Client) registration() registration {
	c.regMu.Lock()
	defer c.regMu.Unlock()
	return c.registered
}

func New(cfg Config, executor Executor) (*Client, error) {
	u, err := url.Parse(cfg.URL)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return nil, errors.New("convex URL must be a site origin")
	}
	allowPlaintext := cfg.AllowHTTPForTests && u.Scheme == "http" && (u.Hostname() == "127.0.0.1" || u.Hostname() == "localhost")
	if u.Scheme != "https" && !allowPlaintext {
		return nil, errors.New("convex transport requires HTTPS")
	}
	if !credentialPattern.MatchString(cfg.Credential) {
		return nil, errors.New("a scoped Node credential is required")
	}
	if cfg.StateDir == "" || !filepath.IsAbs(cfg.StateDir) {
		return nil, errors.New("an absolute persistent state directory is required")
	}
	j, err := OpenJournal(cfg.StateDir)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, 16)
	if _, err = rand.Read(nonce); err != nil {
		_ = j.Close()
		return nil, err
	}
	cfg.URL = u.Scheme + "://" + u.Host
	return &Client{cfg: cfg, http: &http.Client{Timeout: 15 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}, journal: j, exec: executor, owner: hex.EncodeToString(nonce), RenewInterval: 10 * time.Second, now: time.Now}, nil
}
func (c *Client) Close() error { return c.journal.Close() }
func (c *Client) request(ctx context.Context, method, path string, input, output any) error {
	var body io.Reader
	if input != nil {
		b, err := json.Marshal(input)
		if err != nil {
			return err
		}
		if len(b) > maxWireBytes {
			return errors.New("request limit exceeded")
		}
		body = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.cfg.URL+"/api/v1/nodes/"+path, body)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.cfg.Credential)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return errors.New("node API unavailable")
	}
	defer func() { _ = resp.Body.Close() }()
	b, err := io.ReadAll(io.LimitReader(resp.Body, maxWireBytes+1))
	if err != nil {
		return errors.New("node API read failed")
	}
	if len(b) > maxWireBytes {
		return errors.New("node API response limit exceeded")
	}
	if resp.StatusCode != http.StatusOK {
		// Only a short fixed code is kept from an error body, never free text.
		var refusal struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(b, &refusal) != nil || !errorCodePattern.MatchString(refusal.Error) {
			refusal.Error = ""
		}
		return apiStatusError{status: resp.StatusCode, code: refusal.Error}
	}
	if output == nil {
		return nil
	}
	if err = json.Unmarshal(b, output); err != nil {
		return errors.New("invalid Node API response")
	}
	return nil
}

var errorCodePattern = regexp.MustCompile(`^[a-z_]{1,40}$`)

type apiStatusError struct {
	status int
	code   string
}

func (e apiStatusError) Error() string {
	if e.code != "" {
		return fmt.Sprintf("node API status %d (%s)", e.status, e.code)
	}
	return fmt.Sprintf("node API status %d", e.status)
}

type pendingCommand struct {
	ID   string `json:"id"`
	Key  string `json:"idempotencyKey"`
	Kind string `json:"kind"`
}
type commandClaim struct {
	CommandID string `json:"commandId"`
	Owner     string `json:"owner"`
	Epoch     int    `json:"epoch"`
}

// Step makes bounded requests, executes at most 25 commands sequentially, and never sleeps in a
// Convex function. The cursor is opaque and Node-scoped server-side; it is periodically reset by
// end-of-page so a request queued behind the current cursor is eventually observed.
func (c *Client) Step(ctx context.Context) (bool, error) {
	if c.nodeID == "" || time.Since(c.lastHeartbeat) >= 15*time.Second {
		var hb struct {
			NodeID     string  `json:"nodeId"`
			EndpointID *string `json:"endpointId"`
		}
		sent := c.now()
		if err := c.request(ctx, "POST", "heartbeat", map[string]string{"version": c.cfg.Version}, &hb); err != nil {
			return false, err
		}
		if hb.NodeID == "" {
			return false, errors.New("missing Node identity")
		}
		binding := c.cfg.URL + "|" + hb.NodeID
		if _, exists, err := c.journal.lookup("binding", binding); err != nil {
			return false, err
		} else if !exists {
			if err = c.journal.append("binding", binding, "success"); err != nil {
				return false, err
			}
		}
		c.nodeID = hb.NodeID
		c.lastHeartbeat = time.Now()
		registered := ""
		if hb.EndpointID != nil {
			registered = *hb.EndpointID
		}
		c.setRegistered(registered, sent)
	}
	// The mesh snapshot is not fetched here: a bad link or an unavailable mesh state must not
	// stop this Node from running its commands (see RunMesh).
	var page struct {
		Cursor   *string          `json:"cursor"`
		Commands []pendingCommand `json:"commands"`
	}
	if err := c.request(ctx, "GET", "commands?cursor="+url.QueryEscape(c.cursor), nil, &page); err != nil {
		return false, err
	}
	if len(page.Commands) > 25 {
		return false, errors.New("command page limit exceeded")
	}
	c.cursor = ""
	if page.Cursor != nil {
		c.cursor = *page.Cursor
	}
	progressed := false
	for _, cmd := range page.Commands {
		if err := c.execute(ctx, cmd); err != nil {
			var status apiStatusError
			// A stale App lease, competing claim or cancellation must not starve the other Apps
			// on this Node. Keep these queued for operator/coordinator disposition; do not spin.
			if errors.As(err, &status) && status.status == http.StatusConflict {
				continue
			}
			return false, err
		}
		progressed = true
	}
	return progressed || c.cursor != "", nil
}
func (c *Client) execute(ctx context.Context, cmd pendingCommand) error {
	var lease struct {
		Epoch      int   `json:"epoch"`
		LeaseUntil int64 `json:"leaseUntil"`
	}
	if err := c.request(ctx, "POST", "commands/claim", map[string]string{"commandId": cmd.ID, "owner": c.owner}, &lease); err != nil {
		return err
	}
	claim := commandClaim{CommandID: cmd.ID, Owner: c.owner, Epoch: lease.Epoch}
	if cmd.Kind == "spec" {
		return c.executeSpec(ctx, cmd, claim)
	}
	// The journal is what makes a Node-side effect happen at most once per idempotency key. Convex
	// leases fence only Convex writes; a command can be re-delivered after a lost result or a
	// restart, and its deterministic key (deployment, step, Node for pipeline steps) finds the
	// outcome recorded here, which is reported again instead of building or deploying twice.
	key := c.nodeID + ":" + cmd.Key
	outcome, exists, err := c.journal.lookup(key, cmd.ID)
	if err != nil {
		return err
	}
	if !exists {
		var payload Payload
		if err = c.request(ctx, "POST", "commands/payload", claim, &payload); err != nil {
			return err
		}
		if payload.Kind != cmd.Kind {
			return errors.New("command kind mismatch")
		}
		if err = c.journal.append(key, cmd.ID, "accepted"); err != nil {
			return err
		}
		outcome = c.withClaim(ctx, claim, executionLimit(cmd.Kind), func(execution context.Context) string {
			return c.exec.Execute(execution, payload)
		})
		if err = c.journal.append(key, cmd.ID, outcome); err != nil {
			return err
		}
	}
	if outcome == "accepted" {
		outcome = "unknown"
	}
	return c.request(ctx, "POST", "commands/result", struct {
		commandClaim
		Outcome string `json:"outcome"`
	}{claim, outcome}, nil)
}

// executionLimit bounds one command's run. A build gets the Hub's 15 minutes; everything else
// keeps the 10 minutes this transport has always allowed.
func executionLimit(kind string) time.Duration {
	switch kind {
	case "build":
		return 15 * time.Minute
	case "spec":
		return 2 * time.Minute
	default:
		return 10 * time.Minute
	}
}

// withClaim runs fn while renewing the claim, and cancels it the moment a renewal is refused (a
// cancelled command, a lost App lease or a stale claim). An interrupted run is "unknown".
func (c *Client) withClaim(ctx context.Context, claim commandClaim, limit time.Duration, fn func(context.Context) string) string {
	execution, cancel := context.WithTimeout(ctx, limit)
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		ticker := time.NewTicker(c.RenewInterval)
		defer ticker.Stop()
		for {
			select {
			case <-execution.Done():
				return
			case <-ticker.C:
				if err := c.request(execution, "POST", "commands/renew", claim, nil); err != nil {
					cancel()
					return
				}
			}
		}
	}()
	outcome := fn(execution)
	if execution.Err() != nil {
		outcome = "unknown"
	}
	cancel()
	<-stopped
	if outcome != "success" && outcome != "failure" {
		outcome = "unknown"
	}
	return outcome
}

// executeSpec reads the spec file out of a run's source. Reading has no effect on the Node, so it
// is not journaled: a re-delivered spec command reads the source again, which is also the only way
// to report the text, since the journal never stores command data.
func (c *Client) executeSpec(ctx context.Context, cmd pendingCommand, claim commandClaim) error {
	var payload Payload
	if err := c.request(ctx, "POST", "commands/payload", claim, &payload); err != nil {
		return err
	}
	if payload.Kind != cmd.Kind {
		return errors.New("command kind mismatch")
	}
	reader, ok := c.exec.(SpecReader)
	var spec string
	outcome := "failure"
	if ok {
		outcome = c.withClaim(ctx, claim, executionLimit("spec"), func(execution context.Context) string {
			text, err := reader.ReadSpec(execution, payload)
			if err != nil {
				return "failure"
			}
			spec = text
			return "success"
		})
	}
	result := map[string]any{"commandId": claim.CommandID, "owner": claim.Owner, "epoch": claim.Epoch, "outcome": outcome}
	if outcome == "success" && spec != "" {
		if len(spec) > maxSpecBytes {
			result["outcome"] = "failure"
		} else {
			result["spec"] = spec
		}
	}
	return c.request(ctx, "POST", "commands/result", result, nil)
}

// maxSpecBytes matches the control plane's spec limit (spec.MAX_SPEC_BYTES).
const maxSpecBytes = 64 * 1024

func idleDelay(previous time.Duration, busy bool) time.Duration {
	if busy {
		return time.Second
	}
	if previous < 2*time.Second {
		return 2 * time.Second
	}
	next := previous * 2
	if next > 30*time.Second {
		next = 30 * time.Second
	}
	return next
}
func (c *Client) Run(ctx context.Context) error {
	if c.Mesh != nil {
		mesh := make(chan struct{})
		go func() { defer close(mesh); c.RunMesh(ctx, *c.Mesh) }()
		defer func() { <-mesh }()
	}
	var delay time.Duration
	for {
		busy, err := c.Step(ctx)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		// Errors never log response bodies or payloads. Cached journal outcomes survive a control
		// network outage; reclaiming a command only uploads that result, it does not repeat the effect.
		delay = idleDelay(delay, busy && err == nil)
		b := make([]byte, 1)
		if _, err := rand.Read(b); err != nil {
			return err
		}
		jitter := time.Duration(float64(delay) * (float64(b[0])/255.0*0.4 - 0.2))
		timer := time.NewTimer(delay + jitter)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}
