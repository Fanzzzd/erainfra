package egress

import (
	"context"
	"errors"
	"fmt"
	"net/netip"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Fanzzzd/erainfra/apps/runtime/internal/executor"
	"github.com/Fanzzzd/erainfra/apps/runtime/internal/netpolicy"
	"github.com/miekg/dns"
)

// fakeKernel records every batch and serves canned flow-set listings.
type fakeKernel struct {
	mu       sync.Mutex
	batches  []string
	listings map[string]string
	failNext error
	failList error
}

func (k *fakeKernel) Apply(_ context.Context, batch string) error {
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.failNext != nil {
		err := k.failNext
		k.failNext = nil
		return err
	}
	k.batches = append(k.batches, batch)
	return nil
}

func (k *fakeKernel) ListSet(_ context.Context, set string) ([]byte, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.failList != nil {
		return nil, k.failList
	}
	if listing, ok := k.listings[set]; ok {
		return []byte(listing), nil
	}
	return []byte(`{"nftables":[{"set":{"name":"` + set + `","elem":[]}}]}`), nil
}

func (k *fakeKernel) all() string {
	k.mu.Lock()
	defer k.mu.Unlock()
	return strings.Join(k.batches, "")
}

func (k *fakeKernel) reset() {
	k.mu.Lock()
	defer k.mu.Unlock()
	k.batches = nil
}

type upstream struct {
	mu      sync.Mutex
	queries []string
	answers map[string][]dns.RR
	block   chan struct{}
}

func (u *upstream) exchange(_ context.Context, query *dns.Msg, network, server string) (*dns.Msg, error) {
	if u.block != nil {
		<-u.block
	}
	u.mu.Lock()
	u.queries = append(u.queries, network+" "+server+" "+query.Question[0].Name)
	u.mu.Unlock()
	response := new(dns.Msg)
	response.SetReply(query)
	response.Answer = append(response.Answer, u.answers[strings.ToLower(query.Question[0].Name)]...)
	return response, nil
}

func (u *upstream) count() int {
	u.mu.Lock()
	defer u.mu.Unlock()
	return len(u.queries)
}

func rr(t *testing.T, text string) dns.RR {
	t.Helper()
	record, err := dns.NewRR(text)
	if err != nil {
		t.Fatalf("parse %q: %v", text, err)
	}
	return record
}

var guestAddress = netip.MustParseAddr("10.241.0.7")

// guestLink is the host side of guestAddress's link, named the way ptp names it.
const guestLink = "veth1a2b3c4d"

func setup(t *testing.T, profile netpolicy.ProfileEgress) (*Guard, *fakeKernel, *upstream) {
	t.Helper()
	host := netpolicy.DefaultPolicy("runner-center")
	kernel := &fakeKernel{listings: map[string]string{}}
	guard := NewGuard(host, kernel)
	answers := &upstream{answers: map[string][]dns.RR{
		"github.com.": {rr(t, "github.com. 20 IN A 140.82.112.3")},
		"objects.githubusercontent.com.": {
			rr(t, "objects.githubusercontent.com. 300 IN CNAME objects.fastly.example."),
			rr(t, "objects.fastly.example. 7200 IN A 185.199.108.133"),
			rr(t, "objects.fastly.example. 7200 IN A 185.199.109.133"),
		},
		"registry.npmjs.org.": {rr(t, "registry.npmjs.org. 60 IN A 104.16.0.35")},
	}}
	guard.resolver.exchange = answers.exchange
	effective, err := netpolicy.Effective(host, profile, "")
	if err != nil {
		t.Fatalf("effective: %v", err)
	}
	if err := guard.Register(context.Background(), guestAddress, guestLink, "vm-1", effective); err != nil {
		t.Fatalf("register: %v", err)
	}
	return guard, kernel, answers
}

func ask(guard *Guard, source netip.Addr, name string) *dns.Msg {
	query := new(dns.Msg)
	query.SetQuestion(name, dns.TypeA)
	return guard.resolver.answer(context.Background(), source, query, "udp")
}

var githubAllowlist = netpolicy.ProfileEgress{Mode: netpolicy.EgressAllowlist, Presets: []string{"github"}}

func TestRegisterWritesTheGuestsSetsBeforeItBoots(t *testing.T) {
	_, kernel, _ := setup(t, githubAllowlist)
	got := kernel.all()
	for _, want := range []string{"rc_restricted { 10.241.0.7 }", "rc_observed { 10.241.0.7 }"} {
		if !strings.Contains(got, want) {
			t.Fatalf("registration batch %q is missing %q", got, want)
		}
	}
}

func TestRegisterFailsClosedWhenTheKernelRefuses(t *testing.T) {
	host := netpolicy.DefaultPolicy("runner-center")
	kernel := &fakeKernel{failNext: errors.New("Could not process rule: No such file or directory")}
	guard := NewGuard(host, kernel)
	effective, _ := netpolicy.Effective(host, githubAllowlist, "")
	if err := guard.Register(context.Background(), guestAddress, guestLink, "vm-1", effective); err == nil {
		t.Fatal("a guest whose allowlist cannot be installed must not boot")
	}
	if guard.lookup(guestAddress) != nil {
		t.Fatal("a failed registration must leave no view for the resolver to answer from")
	}
}

// A public guest needs no egress state, but it is still bound to its link: it
// can write IPv6 frames and borrowed source addresses as well as any other.
func TestPublicGuestsAreBoundToTheirLinkAndNothingElse(t *testing.T) {
	guard, kernel, _ := setup(t, netpolicy.ProfileEgress{})
	want := "add element inet runner-center rc_guest_sources { \"veth1a2b3c4d\" . 10.241.0.7 }\n" +
		"add element inet runner-center rc_guest_links { \"veth1a2b3c4d\" }\n"
	if kernel.all() != want {
		t.Fatalf("a public guest on a public host must write only its link binding, wrote %q", kernel.all())
	}
	if response := ask(guard, guestAddress, "github.com."); response.Rcode != dns.RcodeRefused {
		t.Fatal("the resolver must not answer a guest whose DNS is not redirected to it")
	}
	kernel.reset()
	record, err := guard.Unregister(context.Background(), guestAddress, "vm-1")
	if record != nil || err != nil {
		t.Fatalf("a public guest has no record, got %+v %v", record, err)
	}
	removal := kernel.all()
	for _, gone := range []string{
		"delete element inet runner-center rc_guest_links { \"veth1a2b3c4d\" }",
		"delete element inet runner-center rc_guest_sources { \"veth1a2b3c4d\" . 10.241.0.7 }",
	} {
		if !strings.Contains(removal, gone) {
			t.Fatalf("teardown must take the link binding away, missing %q in\n%s", gone, removal)
		}
	}
	if strings.Contains(removal, netpolicy.ObservedSetName) || strings.Contains(removal, netpolicy.FlowSetName) {
		t.Fatalf("a public guest's teardown touches only what it registered:\n%s", removal)
	}
}

func TestLinkBindingIsRemovedWithEveryOtherSet(t *testing.T) {
	guard, kernel, _ := setup(t, githubAllowlist)
	if !strings.Contains(kernel.all(), "rc_guest_links { \"veth1a2b3c4d\" }") {
		t.Fatalf("an allowlist guest must be bound to its link too:\n%s", kernel.all())
	}
	kernel.reset()
	if _, err := guard.Unregister(context.Background(), guestAddress, "vm-1"); err != nil {
		t.Fatal(err)
	}
	removal := kernel.all()
	links := strings.Index(removal, "delete element inet runner-center rc_guest_links { \"veth1a2b3c4d\" }")
	restricted := strings.Index(removal, "delete element inet runner-center rc_restricted { 10.241.0.7 }")
	if links < 0 || restricted < 0 || links < restricted {
		t.Fatalf("the link binding must go, after membership:\n%s", removal)
	}
}

func TestAFailedLinkUnbindingFencesTheAddress(t *testing.T) {
	guard, kernel, _ := setup(t, netpolicy.ProfileEgress{})
	kernel.mu.Lock()
	kernel.failNext = errors.New("transaction aborted")
	kernel.mu.Unlock()
	if _, err := guard.Unregister(context.Background(), guestAddress, "vm-1"); err == nil {
		t.Fatal("a failed unbinding must be reported")
	}
	if guard.Health() == nil {
		t.Fatal("a Worker that could not unbind a dead guest's link must not be healthy")
	}
	kernel.reset()
	public, _ := netpolicy.Effective(netpolicy.DefaultPolicy("runner-center"), netpolicy.ProfileEgress{})
	if err := guard.Register(context.Background(), guestAddress, "veth99999999", "vm-2", public); err != nil {
		t.Fatal(err)
	}
	batches := kernel.all()
	purge := strings.Index(batches, "delete element inet runner-center rc_guest_sources { \"veth1a2b3c4d\" . 10.241.0.7 }")
	bind := strings.Index(batches, "add element inet runner-center rc_guest_sources { \"veth99999999\" . 10.241.0.7 }")
	if purge < 0 || bind < purge {
		t.Fatalf("the old link binding must be purged before the address is bound to a new link:\n%s", batches)
	}
}

func TestRegisterRefusesALinkNameItCannotWriteSafely(t *testing.T) {
	host := netpolicy.DefaultPolicy("runner-center")
	kernel := &fakeKernel{}
	guard := NewGuard(host, kernel)
	public, _ := netpolicy.Effective(host, netpolicy.ProfileEgress{})
	for _, link := range []string{"", "veth } ; flush", "../../etc", "a-name-longer-than-15"} {
		if err := guard.Register(context.Background(), guestAddress, link, "vm-1", public); err == nil {
			t.Fatalf("link %q must be refused", link)
		}
	}
	if kernel.all() != "" {
		t.Fatalf("a refused link must write nothing, wrote %q", kernel.all())
	}
}

func TestResolverAdmitsAllowedAnswersBeforeReplying(t *testing.T) {
	guard, kernel, _ := setup(t, githubAllowlist)
	kernel.reset()

	response := ask(guard, guestAddress, "GitHub.com.")
	if response.Rcode != dns.RcodeSuccess || len(response.Answer) != 1 {
		t.Fatalf("an allowed name must be answered, got %v", response)
	}
	// A 20 second TTL is floored to 60 for admission and given 30 seconds of
	// grace; the guest still sees its real TTL, so it re-asks before the
	// element expires.
	want := "add element inet runner-center rc_allow_dns { 10.241.0.7 . 140.82.112.3 timeout 90s }"
	if !strings.Contains(kernel.all(), want) {
		t.Fatalf("admission batch = %q, want it to contain %q", kernel.all(), want)
	}
	if response.Answer[0].Header().Ttl != 20 {
		t.Fatalf("answer TTL = %d, want the upstream's 20", response.Answer[0].Header().Ttl)
	}

	kernel.reset()
	response = ask(guard, guestAddress, "objects.githubusercontent.com.")
	if response.Rcode != dns.RcodeSuccess {
		t.Fatalf("rcode = %s", dns.RcodeToString[response.Rcode])
	}
	// Every address at the end of the CNAME chain is admitted under the name
	// the guest asked for, and a day-long TTL is capped at an hour.
	for _, want := range []string{"10.241.0.7 . 185.199.108.133 timeout 3630s", "10.241.0.7 . 185.199.109.133 timeout 3630s"} {
		if !strings.Contains(kernel.all(), want) {
			t.Fatalf("admission batch %q is missing %q", kernel.all(), want)
		}
	}
	for _, record := range response.Answer {
		if record.Header().Ttl > 3600 {
			t.Fatalf("answer TTL %d outlives the admission", record.Header().Ttl)
		}
	}
}

func TestResolverRefusesNamesOffTheAllowlistWithoutAskingUpstream(t *testing.T) {
	guard, kernel, answers := setup(t, githubAllowlist)
	kernel.reset()
	response := ask(guard, guestAddress, "registry.npmjs.org.")
	if response.Rcode != dns.RcodeNameError {
		t.Fatalf("an unlisted name must be NXDOMAIN, got %s", dns.RcodeToString[response.Rcode])
	}
	if answers.count() != 0 {
		t.Fatal("a refused name must not leak to the upstream resolver")
	}
	if kernel.all() != "" {
		t.Fatalf("a refused name must admit nothing, wrote %q", kernel.all())
	}
}

func TestResolverFailsTheQueryWhenAdmissionFails(t *testing.T) {
	guard, kernel, _ := setup(t, githubAllowlist)
	kernel.mu.Lock()
	kernel.failNext = errors.New("netlink: Error: Could not process rule")
	kernel.mu.Unlock()
	if response := ask(guard, guestAddress, "github.com."); response.Rcode != dns.RcodeServerFailure {
		t.Fatalf("an answer whose addresses were not admitted must be SERVFAIL, got %s",
			dns.RcodeToString[response.Rcode])
	}
}

func TestResolverRefusesSourcesWithNoView(t *testing.T) {
	guard, _, answers := setup(t, githubAllowlist)
	for _, source := range []netip.Addr{netip.MustParseAddr("10.241.0.8"), netip.MustParseAddr("192.168.1.20"), {}} {
		if response := ask(guard, source, "github.com."); response.Rcode != dns.RcodeRefused {
			t.Fatalf("source %v must be refused, got %s", source, dns.RcodeToString[response.Rcode])
		}
	}
	if answers.count() != 0 {
		t.Fatal("an unregistered source must not reach upstream: the resolver is not an open resolver")
	}
}

func TestAuditAnswersEverythingAndMarksWhatTheListWouldBlock(t *testing.T) {
	guard, kernel, _ := setup(t, netpolicy.ProfileEgress{Mode: netpolicy.EgressAudit, Presets: []string{"github"}})
	kernel.reset()
	if response := ask(guard, guestAddress, "registry.npmjs.org."); response.Rcode != dns.RcodeSuccess {
		t.Fatalf("audit must answer every name, got %s", dns.RcodeToString[response.Rcode])
	}
	ask(guard, guestAddress, "github.com.")
	ask(guard, guestAddress, "github.com.")
	if strings.Contains(kernel.all(), netpolicy.AllowDNSSetName) {
		t.Fatal("audit restricts nothing, so it admits nothing")
	}
	record, err := guard.Unregister(context.Background(), guestAddress, "vm-1")
	if err != nil {
		t.Fatalf("unregister: %v", err)
	}
	want := []executor.EgressNameSeen{
		{Name: "github.com", Verdict: executor.EgressAllowed, Queries: 2},
		{Name: "registry.npmjs.org", Verdict: executor.EgressUnlisted, Queries: 1},
	}
	if fmt.Sprint(record.Names) != fmt.Sprint(want) || record.Mode != "audit" {
		t.Fatalf("record = %+v, want names %+v", record, want)
	}
}

const flowListing = `{"nftables":[{"set":{"name":"rc_flows","elem":[
	{"elem":{"val":{"concat":["10.241.0.7","140.82.112.3","tcp",443]},"expires":100}},
	{"elem":{"val":{"concat":["10.241.0.7","1.1.1.1","tcp",443]},"expires":100}},
	{"elem":{"val":{"concat":["10.241.0.9","8.8.8.8","udp",53]},"expires":100}}]}}]}`

const blockedListing = `{"nftables":[{"set":{"name":"rc_blocked","elem":[
	{"elem":{"val":{"concat":["10.241.0.7","1.1.1.1","tcp",443]},"expires":100}}]}}]}`

func TestUnregisterReturnsTheRecordAndRemovesEverything(t *testing.T) {
	guard, kernel, _ := setup(t, githubAllowlist)
	kernel.listings[netpolicy.FlowSetName] = flowListing
	kernel.listings[netpolicy.BlockedSetName] = blockedListing
	ask(guard, guestAddress, "github.com.")
	ask(guard, guestAddress, "evil.example.")
	kernel.reset()

	if record, _ := guard.Unregister(context.Background(), guestAddress, "vm-other"); record != nil {
		t.Fatal("a teardown for a different VM at the same address must not touch this guest")
	}
	record, err := guard.Unregister(context.Background(), guestAddress, "vm-1")
	if err != nil {
		t.Fatalf("unregister: %v", err)
	}
	removal := kernel.all()
	for _, want := range []string{
		"delete element inet runner-center rc_restricted { 10.241.0.7 }",
		"delete element inet runner-center rc_observed { 10.241.0.7 }",
		"delete element inet runner-center rc_allow_dns { 10.241.0.7 . 140.82.112.3 }",
		"delete element inet runner-center rc_flows { 10.241.0.7 . 140.82.112.3 . tcp . 443, 10.241.0.7 . 1.1.1.1 . tcp . 443 }",
		"delete element inet runner-center rc_blocked { 10.241.0.7 . 1.1.1.1 . tcp . 443 }",
	} {
		if !strings.Contains(removal, want) {
			t.Fatalf("removal batch is missing %q:\n%s", want, removal)
		}
	}
	if strings.Contains(removal, "10.241.0.9") {
		t.Fatal("another guest's flows must not be removed")
	}
	wantFlows := []executor.EgressFlowSeen{
		{Destination: "1.1.1.1", Protocol: "tcp", Port: 443, Verdict: executor.EgressBlocked},
		{Destination: "140.82.112.3", Protocol: "tcp", Port: 443, Name: "github.com", Verdict: executor.EgressAllowed},
	}
	if fmt.Sprint(record.Flows) != fmt.Sprint(wantFlows) {
		t.Fatalf("flows = %+v, want %+v", record.Flows, wantFlows)
	}
	wantNames := []executor.EgressNameSeen{
		{Name: "evil.example", Verdict: executor.EgressBlocked, Queries: 1},
		{Name: "github.com", Verdict: executor.EgressAllowed, Queries: 1},
	}
	if fmt.Sprint(record.Names) != fmt.Sprint(wantNames) {
		t.Fatalf("names = %+v, want %+v", record.Names, wantNames)
	}
	if response := ask(guard, guestAddress, "github.com."); response.Rcode != dns.RcodeRefused {
		t.Fatal("a torn-down guest's address must lose its view")
	}
}

func TestAFailedRemovalIsPurgedBeforeTheAddressIsReused(t *testing.T) {
	guard, kernel, _ := setup(t, githubAllowlist)
	ask(guard, guestAddress, "github.com.")
	kernel.mu.Lock()
	kernel.failNext = errors.New("transaction aborted")
	kernel.mu.Unlock()
	if _, err := guard.Unregister(context.Background(), guestAddress, "vm-1"); err == nil {
		t.Fatal("a failed removal must be reported")
	}
	if guard.Health() == nil {
		t.Fatal("a Worker holding a dead guest's permissions must not be healthy")
	}

	kernel.reset()
	host := netpolicy.DefaultPolicy("runner-center")
	public, _ := netpolicy.Effective(host, netpolicy.ProfileEgress{Mode: netpolicy.EgressAudit}, "")
	if err := guard.Register(context.Background(), guestAddress, guestLink, "vm-2", public); err != nil {
		t.Fatalf("register: %v", err)
	}
	batches := kernel.all()
	purge := strings.Index(batches, "delete element inet runner-center rc_allow_dns { 10.241.0.7 . 140.82.112.3 }")
	register := strings.LastIndex(batches, "add element inet runner-center rc_observed { 10.241.0.7 }")
	if purge < 0 || register < purge {
		t.Fatalf("the stale allow entry must be purged before the next guest is registered:\n%s", batches)
	}
	// The resolver is not serving in this test, so only the stale check is
	// asserted: it must be gone.
	guard.mu.Lock()
	stale := len(guard.stale)
	guard.mu.Unlock()
	if stale != 0 {
		t.Fatal("a purged address must no longer count as stale")
	}
}

func TestAnAnswerInFlightAtTeardownAdmitsNothing(t *testing.T) {
	guard, kernel, answers := setup(t, githubAllowlist)
	answers.block = make(chan struct{})
	done := make(chan *dns.Msg)
	go func() { done <- ask(guard, guestAddress, "github.com.") }()
	// Let the query reach the upstream, then tear the guest down under it.
	time.Sleep(20 * time.Millisecond)
	if _, err := guard.Unregister(context.Background(), guestAddress, "vm-1"); err != nil {
		t.Fatalf("unregister: %v", err)
	}
	kernel.reset()
	close(answers.block)
	if response := <-done; response.Rcode != dns.RcodeServerFailure {
		t.Fatalf("an answer for a torn-down guest must fail, got %s", dns.RcodeToString[response.Rcode])
	}
	if kernel.all() != "" {
		t.Fatalf("nothing may be admitted after teardown, wrote %q", kernel.all())
	}
}

func TestATruncatedUDPAnswerIsRetriedOverTCP(t *testing.T) {
	guard, _, _ := setup(t, githubAllowlist)
	var networks []string
	guard.resolver.exchange = func(_ context.Context, query *dns.Msg, network, _ string) (*dns.Msg, error) {
		networks = append(networks, network)
		response := new(dns.Msg)
		response.SetReply(query)
		response.Truncated = network == "udp"
		return response, nil
	}
	ask(guard, guestAddress, "github.com.")
	if strings.Join(networks, ",") != "udp,tcp" {
		t.Fatalf("networks = %v, want a TCP retry after a truncated UDP answer", networks)
	}
}

func TestClaimStartsTheAttemptsRecordEmpty(t *testing.T) {
	guard, kernel, _ := setup(t, githubAllowlist)
	ask(guard, guestAddress, "github.com.")
	kernel.listings[netpolicy.FlowSetName] = flowListing
	kernel.reset()
	if err := guard.Claim(context.Background(), guestAddress, "vm-other", "attempt-1"); err == nil {
		t.Fatal("claiming someone else's guest must fail")
	}
	if err := guard.Claim(context.Background(), guestAddress, "vm-1", "attempt-1"); err != nil {
		t.Fatalf("claim: %v", err)
	}
	if !strings.Contains(kernel.all(), "delete element inet runner-center rc_flows") {
		t.Fatalf("the parked guest's flows must be cleared at claim, got %q", kernel.all())
	}
	if strings.Contains(kernel.all(), netpolicy.RestrictedSetName) {
		t.Fatal("claim must not touch the guest's membership")
	}
	kernel.listings[netpolicy.FlowSetName] = `{"nftables":[]}`
	record, err := guard.Unregister(context.Background(), guestAddress, "attempt-1")
	if err != nil {
		t.Fatalf("unregister: %v", err)
	}
	if len(record.Names) != 0 || len(record.Flows) != 0 {
		t.Fatalf("the Attempt's record must not carry the parked guest's traffic, got %+v", record)
	}
}

func TestRecordIsBounded(t *testing.T) {
	guard, _, _ := setup(t, netpolicy.ProfileEgress{Mode: netpolicy.EgressAudit})
	for index := range executor.MaxEgressRecordNames + 10 {
		ask(guard, guestAddress, fmt.Sprintf("host-%d.example.", index))
	}
	record, _ := guard.Unregister(context.Background(), guestAddress, "vm-1")
	if len(record.Names) != executor.MaxEgressRecordNames || record.OmittedNames != 10 {
		t.Fatalf("names = %d omitted = %d, want %d and 10", len(record.Names), record.OmittedNames, executor.MaxEgressRecordNames)
	}
}

func TestResolverServesRealSockets(t *testing.T) {
	host := netpolicy.DefaultPolicy("runner-center")
	kernel := &fakeKernel{listings: map[string]string{}}
	guard := NewGuard(host, kernel)
	guard.resolver.exchange = (&upstream{answers: map[string][]dns.RR{
		"github.com.": {rr(t, "github.com. 60 IN A 140.82.112.3")},
	}}).exchange
	loopback := netip.MustParseAddr("127.0.0.1")
	effective, _ := netpolicy.Effective(host, githubAllowlist, "")
	if err := guard.Register(context.Background(), loopback, "veth00000001", "vm-1", effective); err != nil {
		t.Fatalf("register: %v", err)
	}
	if guard.Health() == nil {
		t.Fatal("a resolver that is not serving must not be healthy")
	}
	packet, stream, err := Listen(context.Background(), "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	guard.resolver.Serve(packet, stream)
	t.Cleanup(func() { _ = guard.resolver.Close() })
	if err := guard.Health(); err != nil {
		t.Fatalf("a serving resolver must be healthy: %v", err)
	}
	for _, network := range []string{"udp", "tcp"} {
		address := packet.LocalAddr().String()
		if network == "tcp" {
			address = stream.Addr().String()
		}
		client := &dns.Client{Net: network, Timeout: 2 * time.Second}
		query := new(dns.Msg)
		query.SetQuestion("github.com.", dns.TypeA)
		var response *dns.Msg
		deadline := time.Now().Add(2 * time.Second)
		for {
			response, _, err = client.Exchange(query, address)
			if err == nil || time.Now().After(deadline) {
				break
			}
			time.Sleep(20 * time.Millisecond)
		}
		if err != nil || response.Rcode != dns.RcodeSuccess || len(response.Answer) != 1 {
			t.Fatalf("%s query: %v %v", network, response, err)
		}
		blocked := new(dns.Msg)
		blocked.SetQuestion("example.org.", dns.TypeA)
		response, _, err = client.Exchange(blocked, address)
		if err != nil || response.Rcode != dns.RcodeNameError {
			t.Fatalf("%s blocked query: %v %v", network, response, err)
		}
	}
}
