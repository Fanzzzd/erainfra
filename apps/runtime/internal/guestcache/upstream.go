package guestcache

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strings"
	"time"
)

// Upstream reaches the real cache host without ever reading the guest's hosts
// file, which is where the guest pins that host to the interceptor. Resolving
// through the hosts file would hand the interceptor its own address and loop
// every forwarded request back into itself.
//
// It is built before the pin is written. At that moment the system resolver
// still answers with GitHub, so Upstream records the addresses it returns and
// the canonical name the host is a CNAME for. Afterwards it resolves the
// canonical name, which nothing pins, so it follows GitHub's load balancer as
// its short-TTL record rotates; the addresses recorded at build time are the
// fallback if that lookup fails.
type Upstream struct {
	host      string
	canonical string // "" when host is not a CNAME
	recorded  []net.IP
	lookup    func(ctx context.Context, host string) ([]net.IP, error)
	dialer    *net.Dialer
}

// DiscoverUpstream records how to reach host. Call it before host is pinned.
func DiscoverUpstream(ctx context.Context, host string) (*Upstream, error) {
	resolver := net.DefaultResolver
	return discoverUpstream(ctx, host,
		func(ctx context.Context, name string) (string, error) { return resolver.LookupCNAME(ctx, name) },
		func(ctx context.Context, name string) ([]net.IP, error) { return resolver.LookupIP(ctx, "ip4", name) },
	)
}

func discoverUpstream(
	ctx context.Context,
	host string,
	lookupCNAME func(context.Context, string) (string, error),
	lookupIP func(context.Context, string) ([]net.IP, error),
) (*Upstream, error) {
	recorded, err := lookupIP(ctx, host)
	if err != nil {
		return nil, fmt.Errorf("resolve %s: %w", host, err)
	}
	if len(recorded) == 0 {
		return nil, fmt.Errorf("resolve %s: no IPv4 addresses", host)
	}
	canonical := ""
	// A failed CNAME lookup only costs the rotation-following; the recorded
	// addresses still reach GitHub.
	if cname, err := lookupCNAME(ctx, host); err == nil {
		cname = strings.TrimSuffix(cname, ".")
		if cname != "" && !strings.EqualFold(cname, host) {
			canonical = cname
		}
	}
	return &Upstream{
		host:      host,
		canonical: canonical,
		recorded:  recorded,
		lookup:    lookupIP,
		dialer:    &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second},
	}, nil
}

// DialContext dials the real cache host. It refuses any other name: the
// interceptor forwards to exactly one upstream, and an Upstream that dialed
// whatever it was asked would be a way to reach past the guest's pin.
func (u *Upstream) DialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	if !strings.EqualFold(host, u.host) {
		return nil, fmt.Errorf("guestcache: upstream dials only %s, not %s", u.host, host)
	}
	var errs []error
	for _, ip := range u.candidates(ctx) {
		conn, err := u.dialer.DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
		if err == nil {
			return conn, nil
		}
		errs = append(errs, err)
		if ctx.Err() != nil {
			break
		}
	}
	return nil, fmt.Errorf("guestcache: reach %s: %w", u.host, errors.Join(errs...))
}

func (u *Upstream) candidates(ctx context.Context) []net.IP {
	var ips []net.IP
	if u.canonical != "" {
		if fresh, err := u.lookup(ctx, u.canonical); err == nil {
			ips = append(ips, fresh...)
		}
	}
	ips = append(ips, u.recorded...)
	seen := make(map[string]bool, len(ips))
	unique := ips[:0]
	for _, ip := range ips {
		if key := ip.String(); !seen[key] {
			seen[key] = true
			unique = append(unique, ip)
		}
	}
	return unique
}

// Transport is an HTTP transport whose connections go through DialContext.
// TLS still verifies against, and sends SNI for, the cache host's own name.
//
// Compression is disabled so the forward is a passthrough. Left on, Go's
// transport adds Accept-Encoding: gzip to a request whose client asked for no
// encoding and then decodes the reply, so the client would receive bytes
// GitHub never sent it. With it off, a client's Accept-Encoding reaches
// GitHub as the client wrote it and the reply comes back encoded or not
// exactly as GitHub chose.
func (u *Upstream) Transport() *http.Transport {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.DialContext = u.DialContext
	transport.DisableCompression = true
	return transport
}
