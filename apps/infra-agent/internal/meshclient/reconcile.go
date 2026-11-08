package meshclient

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
	"sync"
)

// Desired is control-plane neutral. The Hub supplies it now; connect-convex can use the same
// adapter later, under the same controller lock. Grants come only from declared consumer links.
type Desired struct {
	V         int        `json:"v"`
	Fleet     []Peer     `json:"fleet"`
	Relays    Relays     `json:"relays"`
	Exposures []Exposure `json:"exposures"`
	Links     []Link     `json:"links"`
}

func validName(s string) bool {
	if len(s) < 1 || len(s) > 64 {
		return false
	}
	for _, c := range s {
		ok := c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.ContainsRune("._-", c)
		if !ok {
			return false
		}
	}
	return true
}
func (d Desired) Validate() error {
	if d.V != 1 {
		return errors.New("mesh desired state must be v1")
	}
	if len(d.Fleet) > 4096 || len(d.Exposures) > 128 || len(d.Links) > 128 || len(d.Relays.List) > 16 {
		return errors.New("mesh desired state exceeds fleet/service/link limits")
	}
	for _, r := range d.Relays.List {
		if r.URL == "" || r.NoQUIC && r.QUICPort != 0 {
			return errors.New("invalid mesh relay entry")
		}
	}
	ids := map[string]bool{}
	for _, p := range d.Fleet {
		if !ValidID(p.ID) || ids[p.ID] || len(p.DirectAddrs) > 32 || len(p.RelayURLs) > 16 {
			return errors.New("invalid or duplicate fleet endpoint")
		}
		ids[p.ID] = true
	}
	names := map[string]bool{}
	for _, e := range d.Exposures {
		if !validName(e.Name) || names[e.Name] || len(e.AllowedPeers) > 4096 {
			return errors.New("invalid or duplicate mesh exposure")
		}
		names[e.Name] = true
		host, port, err := net.SplitHostPort(e.Target)
		p, eport := strconv.Atoi(port)
		if err != nil || eport != nil || p < 1 || p > 65535 || net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback() {
			return fmt.Errorf("exposure %s must target loopback", e.Name)
		}
		for _, peer := range e.AllowedPeers {
			if !ValidID(peer) {
				return errors.New("invalid exposure peer grant")
			}
		}
	}
	names = map[string]bool{}
	for _, l := range d.Links {
		if !validName(l.Name) || names[l.Name] || !validName(l.Service) || !ValidID(l.Peer) || l.Listen == "" {
			return errors.New("invalid or duplicate mesh link")
		}
		names[l.Name] = true
	}
	return nil
}

type Reconciler struct {
	Client *Client
	mu     sync.Mutex
}

// Apply authoritatively removes absent names. The Hub uses authorize then links stages across
// all Nodes: revoke old grants first, apply provider grants, refresh endpoint addresses after
// relay changes, then open consumer listeners. An empty stage performs both for one controller.
func (r *Reconciler) Apply(ctx context.Context, d Desired, stage string) (Status, error) {
	if err := d.Validate(); err != nil {
		return Status{}, err
	}
	if stage != "" && stage != "authorize" && stage != "links" {
		return Status{}, errors.New("invalid mesh reconciliation stage")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	current, err := r.Client.Status(ctx)
	if err != nil {
		return Status{}, err
	}
	if stage != "links" {
		wanted := map[string]bool{}
		for _, e := range d.Exposures {
			wanted[e.Name] = true
		}
		// Revocation does not wait for a subsequent connect operation or a daemon restart.
		for _, e := range current.Exposures {
			if !wanted[e.Name] {
				if err := r.Client.Unexpose(ctx, e.Name); err != nil {
					return Status{}, err
				}
			}
		}
		wanted = map[string]bool{}
		for _, l := range d.Links {
			wanted[l.Name] = true
		}
		for _, l := range current.Links {
			if !wanted[l.Name] {
				if err := r.Client.Unlink(ctx, l.Name); err != nil {
					return Status{}, err
				}
			}
		}
		if err := r.Client.SetRelays(ctx, d.Relays); err != nil {
			return Status{}, err
		}
		if err := r.Client.SetFleet(ctx, d.Fleet); err != nil {
			return Status{}, err
		}
		for _, e := range d.Exposures {
			if err := r.Client.Expose(ctx, e); err != nil {
				return Status{}, err
			}
		}
	}
	if stage != "authorize" {
		// Authorization can rebind endpoints. The Hub refreshes every address between stages.
		if err := r.Client.SetFleet(ctx, d.Fleet); err != nil {
			return Status{}, err
		}
		for _, l := range d.Links {
			if _, err := r.Client.Link(ctx, l); err != nil {
				return Status{}, err
			}
		}
	}
	return r.Client.Status(ctx)
}
