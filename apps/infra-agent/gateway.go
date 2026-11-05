package main

import (
	"context"
	"errors"
	"flag"
	"os"
	"path/filepath"
	"strings"

	"github.com/Fanzzzd/erainfra/apps/infra-agent/internal/gateway"
)

// defaultGatewayListen is the loopback port cloudflared points at on a gateway Node. Outside the
// Hub's 61050/61080 and the ingress link range 61100-61999 (packages/backend/convex/infra/ingress.ts).
const defaultGatewayListen = "127.0.0.1:61090"

// runGateway is the ingress proxy of a gateway Node (ADR 0016 phase 3b). It is the same binary as
// the Infra Agent but a separate process, run as its own unprivileged user (deploy/infra/gateway.sh):
// the proxy parses every public request, so it must not share the agent's root, its Convex
// credential or its Docker socket. It needs only the routes file the agent writes and a loopback
// port. Shipping it inside the Infra Agent binary keeps one attested release artifact per platform.
func runGateway(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("gateway", flag.ContinueOnError)
	listen := fs.String("listen", envOr("ERAINFRA_GATEWAY_LISTEN", defaultGatewayListen), "loopback address cloudflared connects to")
	zones := fs.String("zone", os.Getenv("ERAINFRA_ZONE"), "zone(s) whose first-level names are routed, comma-separated (apps live at <app>.<zone>)")
	routes := fs.String("routes-file", os.Getenv("ERAINFRA_GATEWAY_ROUTES_FILE"), "route table written by the connect-convex Infra Agent")
	headerTimeout := fs.Duration("response-header-timeout", gateway.DefaultResponseHeaderTimeout, "longest wait for an App's response headers")
	allowRoot := fs.Bool("allow-root", false, "run as root anyway (not recommended)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if os.Geteuid() == 0 && !*allowRoot {
		return errors.New("the gateway serves public traffic and must not run as root; run it as an unprivileged user (deploy/infra/gateway.sh creates erainfra-gateway), or pass --allow-root")
	}
	if *routes == "" || !filepath.IsAbs(*routes) {
		return errors.New("--routes-file (or ERAINFRA_GATEWAY_ROUTES_FILE) must be an absolute path")
	}
	var list []string
	for z := range strings.SplitSeq(*zones, ",") {
		if z = strings.TrimSpace(z); z != "" {
			list = append(list, z)
		}
	}
	return gateway.Run(ctx, *listen, gateway.Config{Zones: list, RoutesFile: *routes, ResponseHeaderTimeout: *headerTimeout})
}

// gatewayRoutesFile is where connect-convex writes the route table, or "" for nowhere.
func gatewayRoutesFile() (string, error) {
	path := os.Getenv("ERAINFRA_GATEWAY_ROUTES_FILE")
	if path == "" {
		return "", nil
	}
	if !filepath.IsAbs(path) {
		return "", errors.New("ERAINFRA_GATEWAY_ROUTES_FILE must be an absolute path")
	}
	if info, err := os.Stat(filepath.Dir(path)); err != nil || !info.IsDir() {
		return "", errors.New("the directory of ERAINFRA_GATEWAY_ROUTES_FILE must exist")
	}
	return path, nil
}

func envOr(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}
