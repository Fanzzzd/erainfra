// Package meshclient drives one erainfra-mesh endpoint over its local NDJSON v1 API.
// It knows neither the Hub nor Convex. No request, key or relay token is logged or passed to a shell.
package meshclient

import (
	"bufio"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"sync/atomic"
	"time"
)

const MaxMessage = 4 * 1024 * 1024
const Timeout = 10 * time.Second
const Capability = "erainfra-mesh/v1"

var ErrUnsupported = errors.New("secure mesh unsupported on this Node: install the verified erainfra-mesh sidecar (/install --role node --mesh)")

type Peer struct {
	ID          string   `json:"id"`
	RelayURLs   []string `json:"relay_urls"`
	DirectAddrs []string `json:"direct_addrs"`
}
type Relays struct {
	List       []Relay `json:"relays"`
	AuthToken  string  `json:"auth_token,omitempty"`
	N0Fallback bool    `json:"n0_fallback"`
}
type Exposure struct {
	Name           string   `json:"name"`
	Target         string   `json:"target"`
	AllowedPeers   []string `json:"allowed_peers"`
	MaxConnections *uint32  `json:"max_connections,omitempty"`
}
type Link struct {
	Name           string  `json:"name"`
	Peer           string  `json:"peer"`
	Service        string  `json:"service"`
	Listen         string  `json:"listen"`
	MaxConnections *uint32 `json:"max_connections,omitempty"`
}
type ExposureStatus struct {
	Exposure
	BytesSent     uint64 `json:"bytes_sent"`
	BytesReceived uint64 `json:"bytes_received"`
	Active        uint64 `json:"connections_active"`
	Refused       uint64 `json:"connections_refused"`
}
type LinkStatus struct {
	Link
	Bound   string `json:"bound"`
	Active  uint64 `json:"connections_active"`
	Refused uint64 `json:"connections_refused"`
}
type Status struct {
	EndpointID string           `json:"endpoint_id"`
	Addr       Peer             `json:"addr"`
	Exposures  []ExposureStatus `json:"exposures"`
	Links      []LinkStatus     `json:"links"`
	Relay      json.RawMessage  `json:"relay"`
}
type Signature struct {
	EndpointID string `json:"endpoint_id"`
	Signature  string `json:"signature"`
}

type Client struct {
	Socket string
	// Dial is injectable for local protocol tests. Production uses a Unix socket or Windows pipe.
	Dial  func(context.Context, string) (net.Conn, error)
	next  atomic.Uint64
	slots chan struct{}
}

func New(socket string) *Client {
	return &Client{Socket: socket, Dial: dialLocal, slots: make(chan struct{}, 8)}
}

func (c *Client) call(ctx context.Context, op string, fields any, out any) error {
	if c == nil || c.Socket == "" {
		return ErrUnsupported
	}
	ctx, cancel := context.WithTimeout(ctx, Timeout)
	defer cancel()
	select {
	case c.slots <- struct{}{}:
		defer func() { <-c.slots }()
	case <-ctx.Done():
		return ctx.Err()
	}
	body, err := json.Marshal(fields)
	if err != nil {
		return errors.New("cannot encode mesh request")
	}
	var request map[string]json.RawMessage
	if err := json.Unmarshal(body, &request); err != nil {
		return errors.New("mesh request must be an object")
	}
	id := c.next.Add(1)
	request["v"] = json.RawMessage(`1`)
	request["op"], _ = json.Marshal(op)
	request["id"], _ = json.Marshal(id)
	raw, err := json.Marshal(request)
	if err != nil {
		return errors.New("cannot encode mesh request")
	}
	if len(raw)+1 > MaxMessage {
		return errors.New("mesh request exceeds 4 MiB")
	}
	conn, err := c.Dial(ctx, c.Socket)
	if err != nil {
		return fmt.Errorf("mesh socket unavailable: %w", err)
	}
	defer func() { _ = conn.Close() }()
	deadline, _ := ctx.Deadline()
	if err := conn.SetDeadline(deadline); err != nil {
		return fmt.Errorf("mesh deadline: %w", err)
	}
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	raw = append(raw, '\n')
	for len(raw) > 0 {
		n, e := conn.Write(raw)
		if e != nil {
			return fmt.Errorf("mesh request write: %w", e)
		}
		if n == 0 {
			return io.ErrShortWrite
		}
		raw = raw[n:]
	}
	line, err := bufio.NewReader(io.LimitReader(conn, MaxMessage+1)).ReadBytes('\n')
	if len(line) > MaxMessage {
		return errors.New("mesh response exceeds 4 MiB")
	}
	if err != nil {
		return fmt.Errorf("mesh response read: %w", err)
	}
	var reply struct {
		V      int             `json:"v"`
		ID     uint64          `json:"id"`
		OK     bool            `json:"ok"`
		Result json.RawMessage `json:"result"`
		Error  struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if json.Unmarshal(line, &reply) != nil || reply.V != 1 || reply.ID != id {
		return errors.New("invalid mesh v1 response")
	}
	if !reply.OK {
		// Do not surface arbitrary response text: it can contain a token echoed by a relay.
		switch reply.Error.Code {
		case "bad_request", "unsupported_version", "invalid_target", "listen_failed", "endpoint_failed", "shutting_down":
			return fmt.Errorf("mesh %s refused (%s)", op, reply.Error.Code)
		default:
			return fmt.Errorf("mesh %s refused", op)
		}
	}
	if out != nil && json.Unmarshal(reply.Result, out) != nil {
		return errors.New("invalid mesh result")
	}
	return nil
}
func ValidID(id string) bool { b, err := hex.DecodeString(id); return err == nil && len(b) == 32 }
func (c *Client) Status(ctx context.Context) (Status, error) {
	var s Status
	err := c.call(ctx, "status", struct{}{}, &s)
	if err == nil && (!ValidID(s.EndpointID) || s.Addr.ID != s.EndpointID) {
		err = errors.New("invalid mesh endpoint identity")
	}
	return s, err
}
func (c *Client) SetFleet(ctx context.Context, peers []Peer) error {
	if peers == nil {
		peers = []Peer{}
	}
	for i := range peers {
		if peers[i].RelayURLs == nil {
			peers[i].RelayURLs = []string{}
		}
		if peers[i].DirectAddrs == nil {
			peers[i].DirectAddrs = []string{}
		}
	}
	return c.call(ctx, "set_fleet", struct {
		Peers []Peer `json:"peers"`
	}{peers}, nil)
}
func (c *Client) SetRelays(ctx context.Context, r Relays) error {
	if r.List == nil {
		r.List = []Relay{}
	}
	return c.call(ctx, "set_relays", r, nil)
}
func (c *Client) Expose(ctx context.Context, e Exposure) error {
	if e.AllowedPeers == nil {
		e.AllowedPeers = []string{}
	}
	return c.call(ctx, "expose", e, nil)
}
func (c *Client) Unexpose(ctx context.Context, name string) error {
	return c.call(ctx, "unexpose", map[string]string{"name": name}, nil)
}
func (c *Client) Link(ctx context.Context, l Link) (string, error) {
	var result struct {
		Listen string `json:"listen"`
	}
	err := c.call(ctx, "link", l, &result)
	return result.Listen, err
}
func (c *Client) Unlink(ctx context.Context, name string) error {
	return c.call(ctx, "unlink", map[string]string{"name": name}, nil)
}
func (c *Client) SignChallenge(ctx context.Context, message string) (Signature, error) {
	var s Signature
	if len(message) > 4096 || len(message) < len("erainfra/node-endpoint/v1\n") || message[:len("erainfra/node-endpoint/v1\n")] != "erainfra/node-endpoint/v1\n" {
		return s, errors.New("invalid Node endpoint challenge domain or size")
	}
	err := c.call(ctx, "sign_challenge", map[string]string{"message": message}, &s)
	return s, err
}
