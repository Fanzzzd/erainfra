package convexnode

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/netip"
	"os"
	"os/exec"
	"strings"
)

// A deployed service reaches a dependency on another Node at host.docker.internal:<port>, and the
// deploy pipeline starts it with `--add-host=host.docker.internal:host-gateway`. Convex's snapshot
// (version 2) asks for that link's listener as `bridge:<port>`, and the Infra Agent binds it on the
// address host-gateway resolves to on this Node. That address belongs to the host and is reached
// from the host and its containers only, unlike 0.0.0.0, which would put a database port on every
// network the Node is on.
//
// What host-gateway resolves to, per the dockerd reference
// (https://docs.docker.com/reference/cli/dockerd/, "host-gateway-ip"): "By default, `host-gateway`
// resolves to the IPv4 address of the default bridge", and an operator can change it with
// `host-gateway-ips` (a JSON array) or, for older daemons, `host-gateway-ip` (a string) in
// daemon.json. DockerBridge follows the same order. A daemon started with --host-gateway-ip on its
// command line is not visible here; set it in daemon.json instead.

// BridgeResolver returns the IPv4 address host.docker.internal resolves to in this Node's
// containers.
type BridgeResolver func(context.Context) (netip.Addr, error)

// DockerBridge resolves the host-gateway address from the Docker daemon on this Node.
type DockerBridge struct {
	// Docker is the container CLI. Empty means "docker".
	Docker string
	// DaemonConfig is the daemon.json path. Empty means /etc/docker/daemon.json.
	DaemonConfig string
}

// Resolve returns the daemon's configured host-gateway IPv4 address, or else the default bridge's
// IPv4 gateway. It never returns an unspecified or loopback address.
func (b DockerBridge) Resolve(ctx context.Context) (netip.Addr, error) {
	path := b.DaemonConfig
	if path == "" {
		path = "/etc/docker/daemon.json"
	}
	raw, err := os.ReadFile(path)
	switch {
	case err == nil:
		var config struct {
			IPs json.RawMessage `json:"host-gateway-ips"`
			IP  json.RawMessage `json:"host-gateway-ip"`
		}
		if json.Unmarshal(raw, &config) != nil {
			return netip.Addr{}, fmt.Errorf("cannot read %s", path)
		}
		var configured []string
		var one string
		if len(config.IPs) > 0 && json.Unmarshal(config.IPs, &configured) != nil {
			return netip.Addr{}, fmt.Errorf("%s: host-gateway-ips is not a list of addresses", path)
		}
		if len(configured) == 0 && len(config.IP) > 0 {
			if json.Unmarshal(config.IP, &one) != nil {
				return netip.Addr{}, fmt.Errorf("%s: host-gateway-ip is not an address", path)
			}
			if one != "" {
				configured = []string{one}
			}
		}
		if len(configured) > 0 {
			return firstBridgeIPv4(configured, path+" host-gateway-ips")
		}
	case errors.Is(err, fs.ErrNotExist):
	default:
		return netip.Addr{}, fmt.Errorf("cannot read %s: %w", path, err)
	}
	docker := b.Docker
	if docker == "" {
		docker = "docker"
	}
	out, err := exec.CommandContext(ctx, docker, "network", "inspect", "bridge", "--format", "{{range .IPAM.Config}}{{.Gateway}} {{end}}").Output()
	if err != nil {
		return netip.Addr{}, errors.New("docker network inspect bridge failed")
	}
	return firstBridgeIPv4(strings.Fields(string(out)), "the default bridge's gateway")
}

func firstBridgeIPv4(candidates []string, from string) (netip.Addr, error) {
	for _, c := range candidates {
		addr, err := netip.ParseAddr(c)
		if err != nil || !addr.Is4() {
			continue
		}
		if addr.IsUnspecified() || addr.IsLoopback() {
			return netip.Addr{}, fmt.Errorf("%s is %s, which is not a bridge address", from, addr)
		}
		return addr, nil
	}
	return netip.Addr{}, fmt.Errorf("%s has no IPv4 address", from)
}
