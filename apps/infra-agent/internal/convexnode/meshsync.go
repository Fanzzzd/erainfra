package convexnode

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"time"

	"github.com/Fanzzzd/erainfra/apps/infra-agent/internal/meshclient"
)

// Sidecar is this Node's erainfra-mesh endpoint as connect-convex drives it. agent.MeshManager
// implements it while holding the single-controller lock.
type Sidecar interface {
	EndpointStatus(context.Context) (meshclient.Status, error)
	SignChallenge(context.Context, string) (meshclient.Signature, error)
	ApplyDesired(context.Context, meshclient.Desired) (meshclient.Status, error)
}

// MeshOptions configures RunMesh. Zero durations take the production defaults.
type MeshOptions struct {
	Sidecar Sidecar
	// Relays is this Node's relay policy. Convex's snapshot carries no relay token (a secret) and
	// no fleet relay policy in this phase, so the snapshot's own relays field is ignored.
	Relays meshclient.Relays
	// Poll is how often the sidecar's status is read. Default 5 s.
	Poll time.Duration
	// Settle is how long a new address must stay unchanged before it is published, so a Node
	// that is still discovering addresses or flapping between networks publishes once. Default 3 s.
	Settle time.Duration
	// MinPublishGap bounds publications (two requests and a signature each). Default 30 s.
	MinPublishGap time.Duration
	// StatePoll is how often the snapshot revision is checked. Default 10 s.
	StatePoll time.Duration
	// Logf receives operator-facing messages. Default log.Printf. Messages never carry a
	// credential, a relay token or a response body.
	Logf func(format string, args ...any)
}

// Convex limits on a published address (nodeState.challenge).
const (
	maxPublishedRelays = 8
	maxPublishedDirect = 16
	maxDirectAddrBytes = 128
	refusalReminder    = 10 * time.Minute
)

// Refusal codes Convex returns as the 409 body of endpoint/challenge or endpoint.
const (
	refusedKeyChanged = "endpoint_key_changed"
	refusedInUse      = "endpoint_in_use"
)

type endpointRefusal struct {
	code       string
	key        string // the sidecar key Convex refused
	registered string // the key Convex holds for this Node, "" if none
	at         time.Time
	reminded   time.Time
}

type meshLoop struct {
	c   *Client
	o   MeshOptions
	now func() time.Time

	published     *meshclient.Peer
	publishedAt   time.Time
	candidate     *meshclient.Peer
	candidateFrom time.Time
	lastAttempt   time.Time
	refusal       *endpointRefusal

	revision    string
	applied     *meshclient.Desired
	lastState   time.Time
	stateDue    bool
	lastFailure map[string]time.Time
}

func newMeshLoop(c *Client, o MeshOptions) *meshLoop {
	if o.Poll <= 0 {
		o.Poll = 5 * time.Second
	}
	if o.Settle <= 0 {
		o.Settle = 3 * time.Second
	}
	if o.MinPublishGap <= 0 {
		o.MinPublishGap = 30 * time.Second
	}
	if o.StatePoll <= 0 {
		o.StatePoll = 10 * time.Second
	}
	if o.Logf == nil {
		o.Logf = log.Printf
	}
	return &meshLoop{c: c, o: o, now: c.now, lastFailure: map[string]time.Time{}}
}

// RunMesh keeps the sidecar's address published in Convex and the sidecar converged to Convex's
// snapshot until ctx ends. It never returns an error: every failure is logged and retried at the
// poll rate, except an endpoint refusal, which waits for an operator.
func (c *Client) RunMesh(ctx context.Context, o MeshOptions) {
	m := newMeshLoop(c, o)
	ticker := time.NewTicker(m.o.Poll)
	defer ticker.Stop()
	for {
		m.tick(ctx)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (m *meshLoop) tick(ctx context.Context) {
	if ctx.Err() != nil {
		return
	}
	now := m.now()
	st, err := m.o.Sidecar.EndpointStatus(ctx)
	if err != nil {
		m.fail("status", "mesh sidecar status failed: %v", err)
		return
	}
	reg := m.c.registration()
	if !reg.known {
		return // the command loop's first heartbeat has not answered yet
	}
	key := st.EndpointID
	if m.refusal != nil {
		if !m.refusalCleared(key, reg) {
			if now.Sub(m.refusal.reminded) >= refusalReminder {
				m.refusal.reminded = now
				m.logRefusal()
			}
			return
		}
		m.o.Logf("connect-convex: the mesh endpoint refusal is resolved; publishing %s", key)
		m.refusal, m.published = nil, nil
	}
	if reg.id != "" && reg.id != key {
		m.refuse(refusedKeyChanged, key, reg.id, now)
		return
	}
	// An operator reset, seen in a heartbeat taken after this process published: publish again.
	if reg.id == "" && m.published != nil && reg.at.After(m.publishedAt) {
		m.published = nil
	}
	addr := publishable(st.Addr)
	if m.published == nil || !samePeer(addr, *m.published) {
		if m.candidate == nil || !samePeer(addr, *m.candidate) {
			m.candidate, m.candidateFrom = &addr, now
		}
		if now.Sub(m.candidateFrom) >= m.o.Settle && (m.lastAttempt.IsZero() || now.Sub(m.lastAttempt) >= m.o.MinPublishGap) {
			m.lastAttempt = now
			if err := m.c.publishEndpoint(ctx, m.o.Sidecar, addr); err != nil {
				var status apiStatusError
				if errors.As(err, &status) && (status.code == refusedKeyChanged || status.code == refusedInUse) {
					m.refuse(status.code, key, reg.id, now)
					return
				}
				m.fail("publish", "publishing the mesh endpoint failed, retrying in %s: %v", m.o.MinPublishGap, err)
			} else {
				// Taken after the publication finished: a heartbeat sent later reflects it.
				m.published, m.publishedAt, m.stateDue = &addr, m.now(), true
				m.o.Logf("connect-convex: published mesh endpoint %s (%d relay, %d direct addresses)", key, len(addr.RelayURLs), len(addr.DirectAddrs))
			}
		}
	}
	// Peers can reach this sidecar only at a key Convex has proven, so nothing is applied before
	// this process has published it.
	if m.published == nil || m.published.ID != key {
		return
	}
	if m.applied != nil && drifted(st, *m.applied) {
		if _, err := m.o.Sidecar.ApplyDesired(ctx, *m.applied); err != nil {
			m.fail("apply", "re-applying the mesh snapshot after sidecar drift failed: %v", err)
		}
	}
	if m.stateDue || now.Sub(m.lastState) >= m.o.StatePoll {
		m.stateDue, m.lastState = false, now
		m.syncState(ctx)
	}
}

func (m *meshLoop) refusalCleared(key string, reg registration) bool {
	r := m.refusal
	if r.key != key {
		return true // the sidecar has another key now; judge that one afresh
	}
	if r.code == refusedInUse {
		return false // another Node holds this key; restart the agent once an operator fixes it
	}
	// Only a heartbeat taken after the refusal can show the operator's reset.
	return reg.at.After(r.at) && (reg.id == "" || reg.id == key)
}

func (m *meshLoop) refuse(code, key, registered string, now time.Time) {
	m.refusal = &endpointRefusal{code: code, key: key, registered: registered, at: m.now(), reminded: now}
	m.published = nil
	m.logRefusal()
}

func (m *meshLoop) logRefusal() {
	r := m.refusal
	switch r.code {
	case refusedInUse:
		m.o.Logf("connect-convex: ERROR: Convex refused mesh key %s because another Node already registered it. This Node's mesh links stay down. Give this Node its own key (a copied endpoint.key is the usual cause), or reset the other Node's endpoint, then restart the Infra Agent. Not retrying.", r.key)
	default:
		registered := r.registered
		if registered == "" {
			registered = "another key"
		}
		m.o.Logf("connect-convex: ERROR: Convex refused mesh key %s: this Node is registered as %s. This Node's mesh links stay down until an operator runs infra/nodes:resetEndpoint for it (only if the key change is expected), or the original endpoint.key is restored. Not retrying until then.", r.key, registered)
	}
}

// fail logs a retried failure at most once a minute per kind, so a dead sidecar does not flood
// the journal at the poll rate.
func (m *meshLoop) fail(kind, format string, args ...any) {
	now := m.now()
	if last, ok := m.lastFailure[kind]; ok && now.Sub(last) < time.Minute {
		return
	}
	m.lastFailure[kind] = now
	m.o.Logf("connect-convex: "+format, args...)
}

func (m *meshLoop) syncState(ctx context.Context) {
	var state struct {
		Revision  string          `json:"revision"`
		Unchanged bool            `json:"unchanged"`
		Desired   json.RawMessage `json:"desired"`
	}
	if err := m.c.request(ctx, http.MethodGet, "state?revision="+url.QueryEscape(m.revision), nil, &state); err != nil {
		m.fail("state", "fetching the mesh snapshot failed; keeping the last applied one: %v", err)
		return
	}
	if state.Unchanged && state.Revision == m.revision && m.applied != nil {
		return
	}
	d, err := decodeSnapshot(state.Desired)
	if err != nil {
		m.fail("state", "refusing the mesh snapshot; keeping the last applied one: %v", err)
		return
	}
	d.Relays = m.o.Relays
	if _, err := m.o.Sidecar.ApplyDesired(ctx, d); err != nil {
		m.fail("apply", "applying mesh snapshot %s failed; retrying: %v", shortRevision(state.Revision), err)
		return
	}
	m.revision, m.applied = state.Revision, &d
	// A local record of what is applied, for an operator. Never a secret: no relay token is in it.
	recorded := d
	recorded.Relays.AuthToken = ""
	if b, err := json.Marshal(recorded); err == nil {
		_ = os.WriteFile(filepath.Join(m.c.cfg.StateDir, "desired.json"), b, 0600)
	}
	m.o.Logf("connect-convex: applied mesh snapshot %s (%d peers, %d exposures, %d links)", shortRevision(state.Revision), len(d.Fleet), len(d.Exposures), len(d.Links))
}

func shortRevision(r string) string {
	if len(r) > 12 {
		return r[:12]
	}
	return r
}

// decodeSnapshot checks a Convex snapshot and converts it into the reconciler's Desired.
func decodeSnapshot(raw json.RawMessage) (meshclient.Desired, error) {
	if len(raw) == 0 || len(raw) > 200*1024 || !json.Valid(raw) {
		return meshclient.Desired{}, errors.New("invalid mesh desired state")
	}
	var from DesiredMesh
	if json.Unmarshal(raw, &from) != nil || from.V != 1 {
		return meshclient.Desired{}, errors.New("unsupported mesh desired state")
	}
	d := meshclient.Desired{V: 1, Fleet: []meshclient.Peer{}, Exposures: []meshclient.Exposure{}, Links: []meshclient.Link{}}
	for _, p := range from.Fleet {
		d.Fleet = append(d.Fleet, meshclient.Peer{ID: p.ID, RelayURLs: p.RelayURLs, DirectAddrs: p.DirectAddrs})
	}
	for _, e := range from.Exposures {
		d.Exposures = append(d.Exposures, meshclient.Exposure{Name: e.Name, Target: e.Target, AllowedPeers: e.AllowedPeers})
	}
	for _, l := range from.Links {
		d.Links = append(d.Links, meshclient.Link{Name: l.Name, Peer: l.Peer, Service: l.Service, Listen: l.Listen})
	}
	if err := d.Validate(); err != nil {
		return meshclient.Desired{}, err
	}
	return d, nil
}

// drifted reports whether the sidecar no longer holds what was applied, for example after it
// restarted without its state file. Fleet and relays are not reported in a comparable form, so
// a drift in exposures or links re-applies the whole snapshot, which also restores them.
func drifted(st meshclient.Status, d meshclient.Desired) bool {
	if len(st.Exposures) != len(d.Exposures) || len(st.Links) != len(d.Links) {
		return true
	}
	exposures := map[string]meshclient.Exposure{}
	for _, e := range st.Exposures {
		exposures[e.Name] = e.Exposure
	}
	for _, want := range d.Exposures {
		got, ok := exposures[want.Name]
		if !ok || got.Target != want.Target || !sameSet(got.AllowedPeers, want.AllowedPeers) {
			return true
		}
	}
	links := map[string]meshclient.Link{}
	for _, l := range st.Links {
		links[l.Name] = l.Link
	}
	for _, want := range d.Links {
		got, ok := links[want.Name]
		if !ok || got.Peer != want.Peer || got.Service != want.Service {
			return true
		}
	}
	return false
}

func sameSet(a, b []string) bool {
	x, y := slices.Clone(a), slices.Clone(b)
	slices.Sort(x)
	slices.Sort(y)
	return slices.Equal(slices.Compact(x), slices.Compact(y))
}

// publishable normalizes an address for comparison and fits it to Convex's limits. Order is not
// meaningful to a dialing peer, so sorting stops a reordered status from causing a publication.
func publishable(p meshclient.Peer) meshclient.Peer {
	relays := slices.Clone(p.RelayURLs)
	slices.Sort(relays)
	relays = slices.Compact(relays)
	if len(relays) > maxPublishedRelays {
		relays = relays[:maxPublishedRelays]
	}
	direct := []string{}
	for _, a := range p.DirectAddrs {
		if len(a) <= maxDirectAddrBytes {
			direct = append(direct, a)
		}
	}
	slices.Sort(direct)
	direct = slices.Compact(direct)
	if len(direct) > maxPublishedDirect {
		direct = direct[:maxPublishedDirect]
	}
	if relays == nil {
		relays = []string{}
	}
	return meshclient.Peer{ID: p.ID, RelayURLs: relays, DirectAddrs: direct}
}

func samePeer(a, b meshclient.Peer) bool {
	return a.ID == b.ID && slices.Equal(a.RelayURLs, b.RelayURLs) && slices.Equal(a.DirectAddrs, b.DirectAddrs)
}

// publishEndpoint proves possession of the sidecar's key and publishes addr. The challenge message
// goes to the sidecar exactly as Convex sent it: JSON decoding and re-encoding preserve the UTF-8
// bytes, which is what both sides sign and verify.
func (c *Client) publishEndpoint(ctx context.Context, sidecar Sidecar, addr meshclient.Peer) error {
	var challenge struct {
		ChallengeID string `json:"challengeId"`
		Message     string `json:"message"`
	}
	if err := c.request(ctx, http.MethodPost, "endpoint/challenge", map[string]any{"address": addr}, &challenge); err != nil {
		return err
	}
	if challenge.ChallengeID == "" {
		return errors.New("convex issued no endpoint challenge")
	}
	sig, err := sidecar.SignChallenge(ctx, challenge.Message)
	if err != nil {
		return fmt.Errorf("sidecar could not sign the challenge: %w", err)
	}
	if sig.EndpointID != addr.ID {
		return errors.New("the sidecar's key changed while publishing")
	}
	return c.request(ctx, http.MethodPost, "endpoint", map[string]string{"challengeId": challenge.ChallengeID, "signature": sig.Signature}, nil)
}
