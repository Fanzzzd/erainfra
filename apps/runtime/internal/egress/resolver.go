package egress

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"strconv"
	"sync"
	"time"

	"github.com/Fanzzzd/erainfra/apps/runtime/internal/executor"
	"github.com/Fanzzzd/erainfra/apps/runtime/internal/netpolicy"
	"github.com/miekg/dns"
)

const upstreamTimeout = 5 * time.Second

// Exchanger sends one query upstream. network is "udp" or "tcp".
type Exchanger func(ctx context.Context, query *dns.Msg, network, server string) (*dns.Msg, error)

// Resolver is the host-side DNS server every observed guest's DNS is
// redirected to. It has one view per guest, chosen by the query's source
// address: a restricted guest gets answers only for names its Profile allows,
// and the addresses in each answer are admitted to that guest's allow set
// before the answer is sent; an audit guest gets every answer and every name is
// recorded. A source with no registered view is refused, so the resolver is
// not an open resolver to anything else that can reach the gateway address.
type Resolver struct {
	guard     *Guard
	upstreams []string
	exchange  Exchanger

	mu      sync.Mutex
	servers []*dns.Server
	serving bool
	failure error
}

func newResolver(guard *Guard, nameservers []string) *Resolver {
	upstreams := make([]string, 0, len(nameservers))
	for _, nameserver := range nameservers {
		upstreams = append(upstreams, net.JoinHostPort(nameserver, "53"))
	}
	return &Resolver{guard: guard, upstreams: upstreams, exchange: exchangeUpstream}
}

func exchangeUpstream(ctx context.Context, query *dns.Msg, network, server string) (*dns.Msg, error) {
	client := &dns.Client{Net: network, Timeout: upstreamTimeout}
	response, _, err := client.ExchangeContext(ctx, query, server)
	return response, err
}

// Serve answers on the UDP and TCP listeners until Close. Health reports
// whether both are still up.
func (r *Resolver) Serve(packet net.PacketConn, stream net.Listener) {
	udp := &dns.Server{PacketConn: packet, Handler: r}
	tcp := &dns.Server{Listener: stream, Handler: r}
	r.mu.Lock()
	r.servers = []*dns.Server{udp, tcp}
	r.serving = true
	r.failure = nil
	r.mu.Unlock()
	for _, server := range []*dns.Server{udp, tcp} {
		go func() {
			err := server.ActivateAndServe()
			r.mu.Lock()
			defer r.mu.Unlock()
			if r.serving {
				r.serving = false
				r.failure = fmt.Errorf("host resolver stopped: %w", err)
			}
		}()
	}
}

// Close stops both listeners.
func (r *Resolver) Close() error {
	r.mu.Lock()
	servers := r.servers
	r.serving = false
	r.failure = errors.New("host resolver is shut down")
	r.mu.Unlock()
	var closeErrors []error
	for _, server := range servers {
		if err := server.Shutdown(); err != nil {
			closeErrors = append(closeErrors, err)
		}
	}
	return errors.Join(closeErrors...)
}

func (r *Resolver) Health() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.serving {
		return nil
	}
	if r.failure != nil {
		return r.failure
	}
	return errors.New("host resolver is not serving")
}

// ServeDNS answers one query. It implements dns.Handler.
func (r *Resolver) ServeDNS(writer dns.ResponseWriter, query *dns.Msg) {
	response := r.answer(context.Background(), sourceAddress(writer.RemoteAddr()), query, networkOf(writer))
	if networkOf(writer) == "udp" {
		response.Truncate(udpSize(query))
	}
	// A lost answer is retried by the guest's stub resolver.
	_ = writer.WriteMsg(response)
}

// answer is ServeDNS without the socket, so the policy is testable directly.
func (r *Resolver) answer(ctx context.Context, source netip.Addr, query *dns.Msg, network string) *dns.Msg {
	registered := r.guard.lookup(source)
	if registered == nil {
		return failure(query, dns.RcodeRefused)
	}
	if len(query.Question) != 1 {
		return failure(query, dns.RcodeFormatError)
	}
	name := netpolicy.NormalizeDomain(query.Question[0].Name)
	verdict := registered.verdict(name)
	if verdict == executor.EgressBlocked {
		registered.mu.Lock()
		closed := registered.closed
		if !closed {
			registered.noteNameLocked(name, verdict)
		}
		registered.mu.Unlock()
		// NXDOMAIN rather than REFUSED: a stub resolver moves on to its next
		// server on REFUSED, and every server it has is this one.
		return failure(query, dns.RcodeNameError)
	}

	upstream, err := r.forward(ctx, query, network)
	if err != nil {
		return failure(query, dns.RcodeServerFailure)
	}

	registered.mu.Lock()
	defer registered.mu.Unlock()
	if registered.closed {
		return failure(query, dns.RcodeServerFailure)
	}
	registered.noteNameLocked(name, verdict)
	var admitted []netip.Addr
	longest := uint32(0)
	for _, record := range upstream.Answer {
		answerTTL, _ := admitTimeout(record.Header().Ttl)
		record.Header().Ttl = answerTTL
		if answerTTL > longest {
			longest = answerTTL
		}
		a, ok := record.(*dns.A)
		if !ok {
			continue
		}
		address, ok := netip.AddrFromSlice(a.A.To4())
		if !ok {
			continue
		}
		registered.addrNames[address] = name
		admitted = append(admitted, address)
	}
	if registered.effective.Restricted && len(admitted) > 0 {
		// The guest connects the moment it reads the answer, so the addresses
		// are admitted first. If they cannot be, the answer would be a lie the
		// guest cannot use: fail the query instead.
		_, timeout := admitTimeout(longest)
		if err := r.guard.applier.Apply(ctx, netpolicy.ResolvedBatch(source, admitted, timeout)); err != nil {
			return failure(query, dns.RcodeServerFailure)
		}
		for _, address := range admitted {
			registered.resolved[address] = struct{}{}
		}
	}
	upstream.Id = query.Id
	return upstream
}

// forward asks each upstream in turn. A truncated UDP answer is retried over
// TCP so a large answer is never cut short on its way to the guest.
func (r *Resolver) forward(ctx context.Context, query *dns.Msg, network string) (*dns.Msg, error) {
	outbound := query.Copy()
	var lastErr error
	for _, server := range r.upstreams {
		attemptContext, cancel := context.WithTimeout(ctx, upstreamTimeout)
		response, err := r.exchange(attemptContext, outbound, network, server)
		if err == nil && response != nil && response.Truncated && network == "udp" {
			response, err = r.exchange(attemptContext, outbound, "tcp", server)
		}
		cancel()
		if err != nil {
			lastErr = err
			continue
		}
		if response == nil {
			lastErr = errors.New("empty upstream response")
			continue
		}
		if response.Rcode == dns.RcodeServerFailure || response.Rcode == dns.RcodeRefused {
			lastErr = fmt.Errorf("upstream %s answered %s", server, dns.RcodeToString[response.Rcode])
			continue
		}
		return response, nil
	}
	if lastErr == nil {
		lastErr = errors.New("no upstream resolver configured")
	}
	return nil, lastErr
}

func failure(query *dns.Msg, rcode int) *dns.Msg {
	response := new(dns.Msg)
	response.SetRcode(query, rcode)
	return response
}

func sourceAddress(address net.Addr) netip.Addr {
	if address == nil {
		return netip.Addr{}
	}
	host, _, err := net.SplitHostPort(address.String())
	if err != nil {
		return netip.Addr{}
	}
	parsed, err := netip.ParseAddr(host)
	if err != nil {
		return netip.Addr{}
	}
	return parsed.Unmap()
}

func networkOf(writer dns.ResponseWriter) string {
	if _, ok := writer.RemoteAddr().(*net.TCPAddr); ok {
		return "tcp"
	}
	return "udp"
}

func udpSize(query *dns.Msg) int {
	if option := query.IsEdns0(); option != nil && option.UDPSize() >= dns.MinMsgSize {
		return int(option.UDPSize())
	}
	return dns.MinMsgSize
}

// ListenAddress is where the resolver listens: the guest gateway address on
// netpolicy.ResolverPort.
func ListenAddress(host netpolicy.Policy) (string, error) {
	address, err := host.ResolverAddress()
	if err != nil {
		return "", err
	}
	return net.JoinHostPort(address.String(), strconv.Itoa(netpolicy.ResolverPort)), nil
}
