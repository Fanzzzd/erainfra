// Package egress enforces and records a Profile's egress for each guest, on
// the host.
//
// The nftables rules that do the enforcing are static and verified by
// netpolicy. What changes per guest is set membership, and this package owns
// it: Register binds every guest to the host side of its own link and puts it
// into the sets its Profile needs when it boots,
// the resolver admits the addresses of allowed names into the guest's allow
// set as it answers them, and Unregister collects what the guest talked to and
// takes every element out again at teardown.
//
// Everything is fail-closed. A guest whose sets cannot be written does not
// boot; a resolved answer whose addresses cannot be admitted is a SERVFAIL, not
// an answer the guest then cannot use; and state that could not be removed is
// remembered and must be purged before its address is handed to anyone else.
package egress

import (
	"context"

	"fmt"
	"net/netip"
	"slices"
	"sort"
	"sync"
	"time"

	"github.com/Fanzzzd/erainfra/apps/runtime/internal/executor"
	"github.com/Fanzzzd/erainfra/apps/runtime/internal/netpolicy"
)

// Applier talks to the kernel. The production implementation pipes batches to
// `nft -f -`, which commits each one as a single transaction.
type Applier interface {
	Apply(ctx context.Context, batch string) error
	ListSet(ctx context.Context, set string) ([]byte, error)
}

// Guard owns every guest's per-guest egress state on one Worker.
type Guard struct {
	host     netpolicy.Policy
	applier  Applier
	resolver *Resolver

	mu       sync.Mutex
	guests   map[netip.Addr]*guest
	barriers map[netip.Addr]*addressBarrier
	// stale is state whose removal failed. Its address must not carry anyone
	// else's policy until it is gone.
	stale map[netip.Addr]netpolicy.GuestEgressState
}

// addressBarrier fences the complete kernel transition for one address, even
// while no guest is published or failed cleanup is being recorded. References
// include waiters so a barrier cannot disappear while another user holds it.
type addressBarrier struct {
	mu    sync.Mutex
	users int
}

func (g *Guard) lockAddress(address netip.Addr) func() {
	g.mu.Lock()
	barrier := g.barriers[address]
	if barrier == nil {
		barrier = &addressBarrier{}
		g.barriers[address] = barrier
	}
	barrier.users++
	g.mu.Unlock()
	barrier.mu.Lock()
	return func() {
		barrier.mu.Unlock()
		g.mu.Lock()
		barrier.users--
		if barrier.users == 0 {
			delete(g.barriers, address)
		}
		g.mu.Unlock()
	}
}

// guest is one registered guest. mu serializes the resolver admitting
// addresses against teardown removing them, so no element is written for a
// guest after its removal batch was built.
type guest struct {
	mu        sync.Mutex
	owner     string
	closed    bool
	effective netpolicy.EffectiveEgress
	matcher   netpolicy.DomainMatcher
	state     netpolicy.GuestEgressState
	resolved  map[netip.Addr]struct{}
	names     map[string]*executor.EgressNameSeen
	omitted   int
	addrNames map[netip.Addr]string
}

func NewGuard(host netpolicy.Policy, applier Applier) *Guard {
	guard := &Guard{
		host:     host,
		applier:  applier,
		guests:   make(map[netip.Addr]*guest),
		barriers: make(map[netip.Addr]*addressBarrier),
		stale:    make(map[netip.Addr]netpolicy.GuestEgressState),
	}
	guard.resolver = newResolver(guard, host.Nameservers)
	return guard
}

// Resolver is the DNS server observed guests are redirected to.
func (g *Guard) Resolver() *Resolver { return g.resolver }

// Register binds a guest to its link and puts it into the sets its effective
// egress needs, before the guest runs any code. link is the host side of the
// guest's link; every guest is registered, public or not, because the binding
// is what makes the host drop IPv6 and borrowed source addresses from it.
// owner identifies the VM, so a late teardown of a previous guest at the same
// address cannot remove this one's state.
func (g *Guard) Register(
	ctx context.Context,
	address netip.Addr,
	link string,
	owner string,
	effective netpolicy.EffectiveEgress,
) error {
	unlock := g.lockAddress(address)
	defer unlock()
	g.mu.Lock()
	previous := g.guests[address]
	delete(g.guests, address)
	g.mu.Unlock()
	if previous != nil {
		// Closing under the DNS admission lock waits for any in-flight kernel
		// insertion and captures every permission it installed before closing.
		previous.mu.Lock()
		state := previous.closeLocked()
		previous.mu.Unlock()
		g.mu.Lock()
		g.stale[address] = state
		g.mu.Unlock()
	}
	g.mu.Lock()
	stale, dirty := g.stale[address]
	g.mu.Unlock()
	if dirty {
		if err := g.purge(ctx, stale); err != nil {
			return fmt.Errorf("remove stale egress state for %s before reusing it: %w", address, err)
		}
		g.mu.Lock()
		delete(g.stale, address)
		g.mu.Unlock()
	}
	batch, state, err := netpolicy.RegistrationBatch(address, link, effective)
	if err != nil {
		return err
	}
	if err := g.applier.Apply(ctx, batch); err != nil {
		// An error may be a lost acknowledgement after an atomic commit.
		// Keep the full attempted state fenced until an idempotent purge succeeds.
		g.mu.Lock()
		g.stale[address] = state
		g.mu.Unlock()
		return fmt.Errorf("bind guest %s to link %s with %s egress: %w", address, link, effective.Mode, err)
	}
	g.mu.Lock()
	g.guests[address] = &guest{
		owner:     owner,
		effective: effective,
		matcher:   netpolicy.NewDomainMatcher(effective.Domains),
		state:     state,
		resolved:  make(map[netip.Addr]struct{}),
		names:     make(map[string]*executor.EgressNameSeen),
		addrNames: make(map[netip.Addr]string),
	}
	g.mu.Unlock()
	return nil
}

// purge removes state whose flows are no longer known in full, listing them
// from the kernel first so the record elements go too.
func (g *Guard) purge(ctx context.Context, state netpolicy.GuestEgressState) error {
	flows, blocked, err := g.listFlows(ctx, state.Guest)
	if err != nil {
		return err
	}
	state.Flows, state.Blocked = flows, blocked
	return g.applier.Apply(ctx, netpolicy.RemovalBatch(state))
}

func (g *Guard) listFlows(ctx context.Context, address netip.Addr) (flows, blocked []netpolicy.Flow, err error) {
	flowListing, err := g.applier.ListSet(ctx, netpolicy.FlowSetName)
	if err != nil {
		return nil, nil, err
	}
	if flows, err = netpolicy.ParseFlowSet(flowListing, address); err != nil {
		return nil, nil, err
	}
	blockedListing, err := g.applier.ListSet(ctx, netpolicy.BlockedSetName)
	if err != nil {
		return nil, nil, err
	}
	if blocked, err = netpolicy.ParseFlowSet(blockedListing, address); err != nil {
		return nil, nil, err
	}
	return flows, blocked, nil
}

// Claim hands a parked guest to an Attempt. What the guest did while parked
// belongs to no Attempt, so its record starts empty.
func (g *Guard) Claim(ctx context.Context, address netip.Addr, previousOwner, owner string) error {
	unlock := g.lockAddress(address)
	defer unlock()
	g.mu.Lock()
	registered, ok := g.guests[address]
	g.mu.Unlock()
	if !ok {
		return nil
	}
	registered.mu.Lock()
	defer registered.mu.Unlock()
	if registered.owner != previousOwner || registered.closed {
		return fmt.Errorf("guest %s is not the parked guest %s", address, previousOwner)
	}
	// Only an observed guest's flows are recorded.
	if registered.state.Observed {
		flows, blocked, err := g.listFlows(ctx, address)
		if err != nil {
			return fmt.Errorf("read the parked guest's flow record: %w", err)
		}
		if len(flows)+len(blocked) > 0 {
			if err := g.applier.Apply(ctx, netpolicy.FlowRecordBatch(flows, blocked)); err != nil {
				return fmt.Errorf("clear the parked guest's flow record: %w", err)
			}
		}
	}
	registered.owner = owner
	registered.names = make(map[string]*executor.EgressNameSeen)
	registered.omitted = 0
	return nil
}

// Unregister collects what the guest talked to and removes every element it
// holds, its link binding included. The record is nil for a guest whose egress
// is not observed, since nothing about it was recorded. A removal that fails
// is returned as an error and remembered, and the address is purged before it
// is registered again.
func (g *Guard) Unregister(ctx context.Context, address netip.Addr, owner string) (*executor.EgressRecord, error) {
	unlock := g.lockAddress(address)
	defer unlock()
	registered := g.lookup(address)
	if registered == nil {
		return nil, nil
	}
	registered.mu.Lock()
	if registered.owner != owner {
		registered.mu.Unlock()
		return nil, nil
	}
	state := registered.closeLocked()
	record := registered.recordLocked()
	registered.mu.Unlock()
	g.mu.Lock()
	delete(g.guests, address)
	g.mu.Unlock()

	if !state.Observed {
		if err := g.applier.Apply(ctx, netpolicy.RemovalBatch(state)); err != nil {
			g.mu.Lock()
			g.stale[address] = state
			g.mu.Unlock()
			return nil, fmt.Errorf("remove the link binding of guest %s: %w", address, err)
		}
		return nil, nil
	}
	flows, blocked, listErr := g.listFlows(ctx, address)
	if listErr != nil {
		record.Error = "flow record unavailable: " + listErr.Error()
	} else {
		state.Flows, state.Blocked = flows, blocked
		record.Flows, record.OmittedFlows = flowRecord(flows, blocked, registered.addrNames)
	}
	if err := g.applier.Apply(ctx, netpolicy.RemovalBatch(state)); err != nil {
		g.mu.Lock()
		g.stale[address] = state
		g.mu.Unlock()
		return record, fmt.Errorf("remove egress state for guest %s: %w", address, err)
	}
	if listErr != nil {
		// Membership and allow entries are gone; recorded flows of this guest
		// may remain, and they would be attributed to the next guest at this
		// address, so purge it before reuse.
		g.mu.Lock()
		g.stale[address] = netpolicy.GuestEgressState{Guest: address}
		g.mu.Unlock()
	}
	return record, nil
}

// closeLocked snapshots all permissions after DNS insertions have drained.
// The caller holds registered.mu and the address barrier until cleanup ends.
func (registered *guest) closeLocked() netpolicy.GuestEgressState {
	registered.closed = true
	state := registered.state
	for resolved := range registered.resolved {
		state.Resolved = append(state.Resolved, resolved)
	}
	slices.SortFunc(state.Resolved, func(left, right netip.Addr) int { return left.Compare(right) })
	return state
}

// Health reports whether the guard can enforce audit and allowlist egress
// right now: the resolver is serving and no guest's state is left behind.
func (g *Guard) Health() error {
	if err := g.resolver.Health(); err != nil {
		return err
	}
	g.mu.Lock()
	stale := len(g.stale)
	g.mu.Unlock()
	if stale > 0 {
		return fmt.Errorf(
			"%d guest addresses still hold egress state whose removal failed; restart runner-center-runtime to reload the table",
			stale,
		)
	}
	return nil
}

func (g *Guard) lookup(address netip.Addr) *guest {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.guests[address]
}

// verdict is what the record says about a name the guest asked for.
func (registered *guest) verdict(name string) string {
	switch {
	case registered.effective.Restricted:
		if registered.matcher.Allows(name) {
			return executor.EgressAllowed
		}
		return executor.EgressBlocked
	case len(registered.effective.Domains) == 0 && len(registered.effective.CIDRs) == 0:
		// An audit Profile without a list has nothing to compare against.
		return executor.EgressAllowed
	case registered.matcher.Allows(name):
		return executor.EgressAllowed
	default:
		return executor.EgressUnlisted
	}
}

// noteNameLocked counts one query. The caller holds registered.mu.
func (registered *guest) noteNameLocked(name, verdict string) {
	if seen, ok := registered.names[name]; ok {
		seen.Queries++
		return
	}
	if len(registered.names) >= executor.MaxEgressRecordNames {
		registered.omitted++
		return
	}
	registered.names[name] = &executor.EgressNameSeen{Name: name, Verdict: verdict, Queries: 1}
}

func (registered *guest) recordLocked() *executor.EgressRecord {
	record := &executor.EgressRecord{Mode: string(registered.effective.Mode), OmittedNames: registered.omitted}
	for _, seen := range registered.names {
		record.Names = append(record.Names, *seen)
	}
	sort.Slice(record.Names, func(left, right int) bool {
		return record.Names[left].Name < record.Names[right].Name
	})
	return record
}

func flowRecord(
	flows, blocked []netpolicy.Flow,
	names map[netip.Addr]string,
) ([]executor.EgressFlowSeen, int) {
	blockedSet := make(map[netpolicy.Flow]struct{}, len(blocked))
	for _, flow := range blocked {
		blockedSet[flow] = struct{}{}
	}
	// A blocked flow is always in the flow record too, because the forward
	// chain records before it jumps. Union them anyway: a full flow set must
	// not hide what the allowlist refused.
	all := slices.Clone(flows)
	for _, flow := range blocked {
		if !slices.Contains(flows, flow) {
			all = append(all, flow)
		}
	}
	slices.SortFunc(all, func(left, right netpolicy.Flow) int {
		if compared := left.Destination.Compare(right.Destination); compared != 0 {
			return compared
		}
		if left.Port != right.Port {
			return int(left.Port) - int(right.Port)
		}
		if left.Protocol < right.Protocol {
			return -1
		}
		if left.Protocol > right.Protocol {
			return 1
		}
		return 0
	})
	omitted := 0
	if len(all) > executor.MaxEgressRecordFlows {
		omitted = len(all) - executor.MaxEgressRecordFlows
		all = all[:executor.MaxEgressRecordFlows]
	}
	seen := make([]executor.EgressFlowSeen, 0, len(all))
	for _, flow := range all {
		verdict := executor.EgressAllowed
		if _, ok := blockedSet[flow]; ok {
			verdict = executor.EgressBlocked
		}
		seen = append(seen, executor.EgressFlowSeen{
			Destination: flow.Destination.String(),
			Protocol:    flow.Protocol,
			Port:        int(flow.Port),
			Name:        names[flow.Destination],
			Verdict:     verdict,
		})
	}
	return seen, omitted
}

// admitTimeout is how long an address the resolver answered stays admitted:
// the record's TTL, floored so a zero-TTL answer is still usable for the
// connection it was asked for, capped so a day-long TTL does not outlive the
// next policy change by a day, plus a grace for the guest's connect to land.
func admitTimeout(ttl uint32) (answerTTL uint32, timeout time.Duration) {
	const (
		floor = 60
		ceil  = 3600
		grace = 30 * time.Second
	)
	answerTTL = ttl
	if answerTTL > ceil {
		answerTTL = ceil
	}
	admitted := answerTTL
	if admitted < floor {
		admitted = floor
	}
	return answerTTL, time.Duration(admitted)*time.Second + grace
}
