package convexnode

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
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
	"github.com/Fanzzzd/erainfra/apps/infra-agent/internal/oplog"
)

const maxWireBytes = 256 * 1024

var appNamePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)
var imagePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,511}$`)
var envNamePattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
var credentialPattern = regexp.MustCompile(`^erainfra_node_[0-9a-f]{64}$`)

type Config struct {
	URL, Credential, StateDir, Version string
	AllowHTTPForTests                  bool
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
	// Adopt names unlabelled containers this deploy replaces on the operator's word (erainfra deploy
	// --adopt). Convex sends only names this Node's services derive; DeployAppAdopting checks again.
	Adopt []string `json:"adopt"`
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

// LogReader is the log-tail step. Like SpecReader it returns data and has no effect on the Node,
// so it is not journaled; a re-delivered logs command reads the logs again.
type LogReader interface {
	ReadLogs(context.Context, Payload) (output []byte, truncated bool, err error)
}

// MaxLogBytes is how much of a log tail's output is kept, from the end. It matches the control
// plane's MAX_LOG_BYTES (packages/backend/convex/infra/logs.ts), which refuses anything larger.
const MaxLogBytes = 128 * 1024

// LocalExecutor reuses the existing Go allowlist and deployment implementation. Outputs are
// deliberately discarded: logs/child errors may contain secrets and are not command results. The
// one exception is ReadLogs, whose output goes to a row only the requesting operator can read.
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

// ReadLogs runs the allowlisted `container.logs` or `service.logs` operation and keeps the last
// MaxLogBytes of its output. No other operation can reach this path.
func (e LocalExecutor) ReadLogs(ctx context.Context, p Payload) ([]byte, bool, error) {
	if p.Kind != "logs" || (p.Operation.Name != "container.logs" && p.Operation.Name != "service.logs") {
		return nil, false, errors.New("invalid logs payload")
	}
	cmd, err := agent.Resolve(p.Operation)
	if err != nil {
		return nil, false, err
	}
	return e.Runner.ExecuteTail(ctx, cmd, MaxLogBytes)
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
		if len(p.Adopt) > len(p.Services) {
			return "failure"
		}
		_, err = e.Runner.DeployAppAdopting(ctx, p.App, p.Services, p.Adopt)
		if err != nil {
			// Only the outcome goes to Convex, so this log is where an operator reads why, such as
			// an ownership refusal. The error names the step and Docker objects, never env values:
			// those reach Docker through a 0600 env file, and command output is not in the error.
			fmt.Fprintf(os.Stderr, "[erainfra] deploy %s failed: %v\n", p.App, err)
		}
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

	// Logf receives operator-facing messages from Run. Default log.Printf.
	Logf func(format string, args ...any)

	now        func() time.Time // the mesh loop and heartbeat bookkeeping share one clock
	regMu      sync.Mutex
	registered registration

	// blocked is why the last command step failed, as a fixed code the heartbeat carries; ""
	// after a step that succeeded. sentBlocked is what the last heartbeat said.
	blocked, sentBlocked string
	// legacyHeartbeat is set when Convex predates the heartbeat's command health fields.
	legacyHeartbeat bool
	// lastSweep and lastForcedSweep pace the journal status sweep (sweepJournal).
	lastSweep, lastForcedSweep time.Time
	stepLog                    stepLog
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
	c := &Client{cfg: cfg, http: &http.Client{Timeout: 15 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}, journal: j, exec: executor, owner: hex.EncodeToString(nonce), RenewInterval: 10 * time.Second, now: time.Now}
	// A journal that is full at startup is reported by the first heartbeat, before any command
	// has had to be refused.
	c.blocked = c.commandsBlocked(nil)
	return c, nil
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
		return nodeAPIError("node API unavailable")
	}
	defer func() { _ = resp.Body.Close() }()
	b, err := io.ReadAll(io.LimitReader(resp.Body, maxWireBytes+1))
	if err != nil {
		return nodeAPIError("node API read failed")
	}
	if len(b) > maxWireBytes {
		return nodeAPIError("node API response limit exceeded")
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
		return nodeAPIError("invalid Node API response")
	}
	return nil
}

// nodeAPIError is a request that failed before Convex answered it with a status.
type nodeAPIError string

func (e nodeAPIError) Error() string { return string(e) }

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
//
// Whatever stops a step is kept as a fixed reason code (blockedReason) and sent with the next
// heartbeat, so a Node that is online but cannot run commands shows as blocked in Convex, the
// dashboard, /metrics and the node-commands-blocked alert, rather than as a healthy Node whose
// work times out.
func (c *Client) Step(ctx context.Context) (bool, error) {
	busy, err := c.step(ctx)
	var hb heartbeatError
	// A failed heartbeat says nothing about commands; Convex sees that Node go silent instead.
	if ctx.Err() == nil && !errors.As(err, &hb) {
		c.blocked = c.commandsBlocked(err)
	}
	return busy, err
}

// commandsBlocked is the reason the heartbeat gives after a step that ended with err. A step that
// refused nothing can still leave the journal full: the refused command left the queue (its run
// timed out, or someone cancelled it), but the next journaled command will be refused the same
// way. The step has already run the forced sweep in that case, so a journal still full is
// reported until keys are really freed.
func (c *Client) commandsBlocked(err error) string {
	if reason := blockedReason(err); reason != "" {
		return reason
	}
	if c.journal.full() {
		return blockedJournalFull
	}
	return ""
}

// Reasons a heartbeat gives for commandsBlocked. Convex accepts any short code
// (nodeState.heartbeat), so a newer agent can add one without a control-plane change.
const (
	blockedJournalFull  = "journal_full"
	blockedJournalError = "journal_error"
	blockedCommandAPI   = "command_api"
	blockedCommandError = "command_error"
)

func blockedReason(err error) string {
	var journal journalError
	var status apiStatusError
	var api nodeAPIError
	switch {
	case err == nil:
		return ""
	case errors.Is(err, ErrJournalFull):
		return blockedJournalFull
	case errors.As(err, &journal):
		return blockedJournalError
	case errors.As(err, &status), errors.As(err, &api):
		return blockedCommandAPI
	default:
		return blockedCommandError
	}
}

type heartbeatError struct{ err error }

func (e heartbeatError) Error() string { return e.err.Error() }
func (e heartbeatError) Unwrap() error { return e.err }

func (c *Client) heartbeat(ctx context.Context) error {
	var hb struct {
		NodeID     string  `json:"nodeId"`
		EndpointID *string `json:"endpointId"`
	}
	sent := c.now()
	blocked := c.blocked
	body := map[string]any{"version": c.cfg.Version, "journalKeys": c.journal.keys(), "journalKeyLimit": maxJournalKeys}
	if blocked != "" {
		body["commandsBlocked"] = blocked
	}
	err := errors.New("legacy heartbeat")
	if !c.legacyHeartbeat {
		err = c.request(ctx, "POST", "heartbeat", body, &hb)
		var status apiStatusError
		if errors.As(err, &status) && status.status == http.StatusBadRequest && status.code == "unknown_field" {
			// A control plane older than this agent refuses the new fields. Keep heartbeating
			// with the version alone; the blocked state is still logged here.
			c.legacyHeartbeat = true
			c.logf("connect-convex: WARNING: Convex does not accept command health in the heartbeat; deploy the control plane to show a blocked Node on the dashboard")
		}
	}
	if c.legacyHeartbeat {
		err = c.request(ctx, "POST", "heartbeat", map[string]string{"version": c.cfg.Version}, &hb)
	}
	if err != nil {
		return err
	}
	if hb.NodeID == "" {
		return errors.New("missing Node identity")
	}
	binding := c.cfg.URL + "|" + hb.NodeID
	if _, exists, err := c.journal.lookup(bindingKey, binding); err != nil {
		return err
	} else if !exists {
		if err = c.journal.append(bindingKey, binding, outcomeSuccess); err != nil {
			return err
		}
	}
	c.nodeID = hb.NodeID
	c.lastHeartbeat = c.now()
	c.sentBlocked = blocked
	registered := ""
	if hb.EndpointID != nil {
		registered = *hb.EndpointID
	}
	c.setRegistered(registered, sent)
	return nil
}

func (c *Client) logf(format string, args ...any) {
	if c.Logf != nil {
		c.Logf(format, args...)
		return
	}
	oplog.Printf(format, args...)
}

func (c *Client) step(ctx context.Context) (bool, error) {
	// A change in the blocked state is reported on the next poll, not up to 15 seconds later.
	since := c.now().Sub(c.lastHeartbeat)
	if c.nodeID == "" || since >= 15*time.Second || (c.blocked != c.sentBlocked && since >= 2*time.Second) {
		if err := c.heartbeat(ctx); err != nil {
			return false, heartbeatError{err}
		}
	}
	// A full journal is swept at the forced pace even with no command waiting, so its keys are
	// freed, and the blocked state cleared, as soon as Convex finishes their commands.
	if err := c.sweepJournal(ctx, c.journal.full()); err != nil {
		c.logf("connect-convex: journal status sweep failed: %v", err)
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
	var full error
	for _, cmd := range page.Commands {
		if err := c.execute(ctx, cmd); err != nil {
			var status apiStatusError
			// A stale App lease, competing claim or cancellation must not starve the other Apps
			// on this Node. Keep these queued for operator/coordinator disposition; do not spin.
			if errors.As(err, &status) && status.status == http.StatusConflict {
				continue
			}
			// A full journal refuses only journaled work; spec reads and log tails still run.
			if errors.Is(err, ErrJournalFull) {
				full = err
				continue
			}
			return false, err
		}
		progressed = true
	}
	if full != nil {
		return progressed, full
	}
	return progressed || c.cursor != "", nil
}

// Journal sweep pacing. A healthy Node settles each key when its report is acknowledged, so the
// sweep only finds keys whose acknowledgement was lost to a crash, or whose command was cancelled
// while it ran (by an operator, or by a deploy run that ended); it runs when enough of those
// collect, or every forcedSweepInterval while the journal is full.
const (
	sweepBatch          = 200 // matches MAX_STATUS_IDS in packages/backend/convex/infra/nodeCommands.ts
	sweepThreshold      = 500
	sweepInterval       = 10 * time.Minute
	forcedSweepInterval = 30 * time.Second
)

// terminalStatus is every nodeCommands status Convex never moves on from, so a command in one is
// never delivered again (commandStatus in packages/backend/convex/infra/nodeCommandModel.ts).
var terminalStatus = map[string]bool{"success": true, "failure": true, "unknown": true, "cancelled": true}

// sweepJournal asks Convex for the status of journaled commands and settles every key whose
// command is terminal: Convex will never deliver it again, so the key has nothing left to replay.
// A command still pending or running keeps its key, so its re-delivery replays the outcome. When
// Convex ended the command another way than the outcome recorded here (cancelled while it ran,
// say, after the Node had finished it), the difference is logged before the key goes, because
// Convex cannot know it. A command Convex does not know keeps its key for an operator and is not
// asked about again.
func (c *Client) sweepJournal(ctx context.Context, forced bool) error {
	candidates := c.journal.sweepCandidates()
	if len(candidates) == 0 {
		return nil
	}
	now := c.now()
	if forced {
		if !c.lastForcedSweep.IsZero() && now.Sub(c.lastForcedSweep) < forcedSweepInterval {
			return nil
		}
		c.lastForcedSweep = now
	} else if len(candidates) < sweepThreshold || (!c.lastSweep.IsZero() && now.Sub(c.lastSweep) < sweepInterval) {
		return nil
	}
	c.lastSweep = now
	settled := 0
	for start := 0; start < len(candidates); start += sweepBatch {
		batch := candidates[start:min(start+sweepBatch, len(candidates))]
		ids := make([]string, len(batch))
		for i, r := range batch {
			ids[i] = r.ID
		}
		var answer struct {
			Commands []struct {
				ID     string `json:"id"`
				Status string `json:"status"`
			} `json:"commands"`
		}
		if err := c.request(ctx, "POST", "commands/status", map[string]any{"commandIds": ids}, &answer); err != nil {
			return err
		}
		status := make(map[string]string, len(answer.Commands))
		for _, s := range answer.Commands {
			status[s.ID] = s.Status
		}
		var done []string
		for _, r := range batch {
			s := status[r.ID]
			switch {
			case terminalStatus[s]:
				if s != r.Outcome {
					c.logf("connect-convex: journal key %s (command %s) ended in Convex as %s, but this Node recorded %s; forgetting it, since Convex will not deliver it again. Check that the Node's state matches what that run expected", r.Key, r.ID, s, r.Outcome)
				}
				done = append(done, r.Key)
			case s == "missing":
				// Nothing confirms it cannot be delivered again.
				c.journal.review[r.Key] = true
			default:
				// Pending, running, not answered, or a status this agent does not know: the
				// command may be delivered again, so the key stays.
			}
		}
		if err := c.journal.settleMany(done); err != nil {
			return err
		}
		settled += len(done)
	}
	if settled > 0 {
		c.logf("connect-convex: journal sweep settled %d keys whose commands Convex has finished; %d keys remain", settled, c.journal.keys())
	}
	return nil
}
func (c *Client) execute(ctx context.Context, cmd pendingCommand) error {
	journaled := cmd.Kind != "spec" && cmd.Kind != "logs"
	// The journal is what makes a Node-side effect happen at most once per idempotency key. Convex
	// leases fence only Convex writes; a command can be re-delivered after a lost result or a
	// restart, and its deterministic key (deployment, step, Node for pipeline steps) finds the
	// outcome recorded here, which is reported again instead of building or deploying twice.
	key := c.nodeID + ":" + cmd.Key
	if journaled {
		if _, exists, _ := c.journal.lookup(key, cmd.ID); !exists && c.journal.full() {
			// Make room from keys Convex has already acknowledged before refusing. The command is
			// not claimed, so it holds no lease and the Node's other work is not held up behind it.
			if err := c.sweepJournal(ctx, true); err != nil {
				c.logf("connect-convex: journal status sweep failed: %v", err)
			}
			if c.journal.full() {
				return c.journal.fullError()
			}
		}
	}
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
	if cmd.Kind == "logs" {
		return c.executeLogs(ctx, cmd, claim)
	}
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
	if outcome == outcomeAccepted {
		outcome = outcomeUnknown
	}
	if err = c.request(ctx, "POST", "commands/result", struct {
		commandClaim
		Outcome string `json:"outcome"`
	}{claim, outcome}, nil); err != nil {
		return err
	}
	// The report committed: the command is terminal with this outcome, and Convex refuses to
	// claim a terminal command, so it is never delivered again and its key has nothing left to
	// replay. An unknown outcome is settled too: Convex now shows it on the command and fails the
	// deploy run with "inspect the Node", which is where an operator acts on it.
	if outcome == outcomeUnknown {
		c.logf("connect-convex: command %s (key %s) ended with an unknown outcome: it was interrupted, so its effect may or may not have happened; Convex records it as unknown and it will not run again", cmd.ID, key)
	}
	_, err = c.journal.settle(key, cmd.ID)
	return err
}

// executionLimit bounds one command's run. A build gets 15 minutes; everything else keeps the 10
// minutes this transport has always allowed.
func executionLimit(kind string) time.Duration {
	switch kind {
	case "build":
		return 15 * time.Minute
	case "spec":
		return 2 * time.Minute
	case "logs":
		return time.Minute
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

// executeLogs reads a log tail an operator asked for and uploads it with the result. It is not
// journaled: reading logs has no effect, and the journal never stores command data, so a
// re-delivered logs command reads the logs again.
func (c *Client) executeLogs(ctx context.Context, cmd pendingCommand, claim commandClaim) error {
	var payload Payload
	if err := c.request(ctx, "POST", "commands/payload", claim, &payload); err != nil {
		return err
	}
	if payload.Kind != cmd.Kind {
		return errors.New("command kind mismatch")
	}
	reader, ok := c.exec.(LogReader)
	var output []byte
	var truncated bool
	outcome := "failure"
	if ok {
		outcome = c.withClaim(ctx, claim, executionLimit("logs"), func(execution context.Context) string {
			out, cut, err := reader.ReadLogs(execution, payload)
			if err != nil {
				return "failure"
			}
			output, truncated = out, cut
			return "success"
		})
	}
	result := map[string]any{"commandId": claim.CommandID, "owner": claim.Owner, "epoch": claim.Epoch, "outcome": outcome}
	if outcome == "success" {
		if len(output) > MaxLogBytes {
			output, truncated = output[len(output)-MaxLogBytes:], true
		}
		result["output"] = base64.StdEncoding.EncodeToString(output)
		result["truncated"] = truncated
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
		// Errors never carry response bodies or payloads, so they are safe to log. Cached journal
		// outcomes survive a control network outage; reclaiming a command only uploads that
		// result, it does not repeat the effect.
		c.stepLog.observe(c.now(), err, c.logf)
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

// stepLogRepeat is how often an error that keeps recurring is logged again.
const stepLogRepeat = 5 * time.Minute

// stepLog logs each distinct step error once, then again every stepLogRepeat while it recurs, and
// says when steps succeed again. A Node polling every few seconds would otherwise either flood
// its log or say nothing at all while every command failed.
type stepLog struct {
	last     string
	loggedAt time.Time
	since    time.Time
	failures int
}

func (l *stepLog) observe(now time.Time, err error, logf func(string, ...any)) {
	if err == nil {
		if l.last != "" {
			logf("connect-convex: command polling recovered after %d failed polls since %s", l.failures, l.since.UTC().Format(time.RFC3339))
		}
		*l = stepLog{}
		return
	}
	message := err.Error()
	switch {
	case message != l.last:
		failures := l.failures + 1
		since := l.since
		if l.last == "" {
			since = now
		}
		logf("connect-convex: ERROR: command polling failed (%s): %s", blockedReason(err), message)
		*l = stepLog{last: message, loggedAt: now, since: since, failures: failures}
	case now.Sub(l.loggedAt) >= stepLogRepeat:
		l.failures++
		logf("connect-convex: ERROR: command polling still failing (%d polls since %s): %s", l.failures, l.since.UTC().Format(time.RFC3339), message)
		l.loggedAt = now
	default:
		l.failures++
	}
}
