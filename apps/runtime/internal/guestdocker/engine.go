package guestdocker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
)

// ErrNotFound is the daemon's answer for a container that no longer exists.
var ErrNotFound = errors.New("no such container")

// Container is the slice of `docker inspect` the Watcher decides on.
type Container struct {
	ID      string
	Running bool
	// Pid is the container's init process on the guest, the way into its
	// filesystem through /proc/<pid>/root.
	Pid int
	Env []string
	// HostsPath is the guest-side file Docker bind-mounts as the container's
	// /etc/hosts. For a host-network container it starts as a copy of the
	// guest's own /etc/hosts.
	HostsPath string
}

// EventStream yields the ID of each container that starts.
type EventStream interface {
	Next() (string, error)
	Close() error
}

// Engine is the part of the Docker Engine API the Watcher uses.
type Engine interface {
	// Subscribe returns once the daemon has accepted the subscription, so a
	// container listed by Running afterwards cannot start unseen in between.
	Subscribe(ctx context.Context) (EventStream, error)
	Running(ctx context.Context) ([]string, error)
	Inspect(ctx context.Context, id string) (Container, error)
}

// Client speaks the Docker Engine API over the daemon's unix socket. It
// deliberately uses unversioned paths and no SDK: the guest needs four
// read-only calls and nothing else, and the daemon serves its newest API
// version on unversioned paths.
type Client struct {
	http *http.Client
	base string
}

// DefaultSocket is where dockerd listens in the guest.
const DefaultSocket = "/var/run/docker.sock"

// NewClient returns a client for the daemon listening on socket.
func NewClient(socket string) *Client {
	dialer := &net.Dialer{}
	return &Client{
		http: &http.Client{Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				return dialer.DialContext(ctx, "unix", socket)
			},
		}},
		base: "http://docker",
	}
}

// newClientForURL points a client at an HTTP server, for tests.
func newClientForURL(base string, client *http.Client) *Client {
	return &Client{http: client, base: base}
}

func (c *Client) get(ctx context.Context, path string, query url.Values) (*http.Response, error) {
	target := c.base + path
	if len(query) > 0 {
		target += "?" + query.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("docker %s: %w", path, err)
	}
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		_ = resp.Body.Close()
		err := fmt.Errorf("docker %s: %s: %s", path, resp.Status, body)
		if resp.StatusCode == http.StatusNotFound {
			err = fmt.Errorf("%w: %w", ErrNotFound, err)
		}
		return nil, err
	}
	return resp, nil
}

// Subscribe streams container start events.
func (c *Client) Subscribe(ctx context.Context) (EventStream, error) {
	filters, err := json.Marshal(map[string][]string{"type": {"container"}, "event": {"start"}})
	if err != nil {
		return nil, err
	}
	resp, err := c.get(ctx, "/events", url.Values{"filters": {string(filters)}})
	if err != nil {
		return nil, err
	}
	return &eventStream{body: resp.Body, decoder: json.NewDecoder(resp.Body)}, nil
}

type eventStream struct {
	body    io.ReadCloser
	decoder *json.Decoder
}

func (s *eventStream) Next() (string, error) {
	for {
		var event struct {
			Type   string
			Action string
			Actor  struct{ ID string }
		}
		if err := s.decoder.Decode(&event); err != nil {
			if errors.Is(err, io.EOF) {
				return "", errors.New("docker event stream ended")
			}
			return "", fmt.Errorf("docker event stream: %w", err)
		}
		// The subscription filters for these already; checking again costs
		// nothing and keeps a daemon that ignored the filter from feeding
		// the Watcher an exec or a network event.
		if event.Type == "container" && event.Action == "start" && event.Actor.ID != "" {
			return event.Actor.ID, nil
		}
	}
}

func (s *eventStream) Close() error { return s.body.Close() }

// Running lists the IDs of running containers.
func (c *Client) Running(ctx context.Context) ([]string, error) {
	resp, err := c.get(ctx, "/containers/json", nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close() //nolint:errcheck // read-only response body
	var list []struct {
		ID string `json:"Id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&list); err != nil {
		return nil, fmt.Errorf("docker /containers/json: %w", err)
	}
	ids := make([]string, 0, len(list))
	for _, entry := range list {
		ids = append(ids, entry.ID)
	}
	return ids, nil
}

// Inspect reads one container.
func (c *Client) Inspect(ctx context.Context, id string) (Container, error) {
	resp, err := c.get(ctx, "/containers/"+url.PathEscape(id)+"/json", nil)
	if err != nil {
		return Container{}, err
	}
	defer resp.Body.Close() //nolint:errcheck // read-only response body
	var raw struct {
		ID    string `json:"Id"`
		State struct {
			Running bool
			Pid     int
		}
		Config struct {
			Env []string
		}
		HostsPath string
	}
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return Container{}, fmt.Errorf("docker inspect %s: %w", id, err)
	}
	return Container{
		ID:        raw.ID,
		Running:   raw.State.Running,
		Pid:       raw.State.Pid,
		Env:       raw.Config.Env,
		HostsPath: raw.HostsPath,
	}, nil
}
