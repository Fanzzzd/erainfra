package netpolicy

import (
	"encoding/json"
	"fmt"
	"net/netip"
	"slices"
	"strconv"
	"strings"
	"time"
)

// This file renders the nft batches that put one guest into, and take it out
// of, the per-guest sets. They are pure so the exact element syntax is unit
// tested; the runtime pipes each batch to `nft -f -`, which applies it as one
// kernel transaction.
//
// Deleting an element that is not there fails the whole batch, so every delete
// is preceded by an add of the same element. "add, then delete" is therefore an
// idempotent removal, and "add, delete, add with a timeout" refreshes a timeout
// whether or not the element already existed, in one atomic step a packet can
// never observe half-done.

// GuestEgressState is everything the runtime put into the per-guest sets for
// one guest, which is exactly what has to come out again.
type GuestEgressState struct {
	Guest      netip.Addr
	Observed   bool
	Restricted bool
	// CIDRs are the collapsed allow prefixes written to rc_allow_cidr.
	CIDRs []netip.Prefix
	// Resolved are the addresses written to rc_allow_dns.
	Resolved []netip.Addr
	// Flows are elements of rc_flows and rc_blocked belonging to the guest.
	Flows   []Flow
	Blocked []Flow
}

// Flow is one recorded new connection: the guest, where it went, and how.
type Flow struct {
	Guest       netip.Addr `json:"-"`
	Destination netip.Addr `json:"destination"`
	Protocol    string     `json:"protocol"`
	Port        uint16     `json:"port"`
}

func (f Flow) element() string {
	return fmt.Sprintf("%s . %s . %s . %d", f.Guest, f.Destination, f.Protocol, f.Port)
}

// RegistrationBatch puts a guest into the sets its effective egress needs. It
// returns the state it wrote and an empty batch for a guest that needs no
// per-guest state at all, which is every public guest on a public host.
func RegistrationBatch(guest netip.Addr, effective EffectiveEgress) (string, GuestEgressState, error) {
	state := GuestEgressState{Guest: guest, Observed: effective.Observed, Restricted: effective.Restricted}
	if !guest.Is4() {
		return "", state, fmt.Errorf("guest address %s must be IPv4", guest)
	}
	if effective.Restricted {
		prefixes := make([]netip.Prefix, 0, len(effective.CIDRs))
		for _, cidr := range effective.CIDRs {
			prefix, err := parseIPv4Destination(cidr)
			if err != nil {
				return "", state, fmt.Errorf("allowed CIDR %q: %w", cidr, err)
			}
			prefixes = append(prefixes, prefix)
		}
		state.CIDRs = CollapsePrefixes(prefixes)
	}
	var batch strings.Builder
	if len(state.CIDRs) > 0 {
		elements := make([]string, 0, len(state.CIDRs))
		for _, prefix := range state.CIDRs {
			elements = append(elements, fmt.Sprintf("%s . %s", guest, prefix))
		}
		writeElements(&batch, "add", AllowCIDRSetName, elements)
	}
	// Membership last: within one transaction the order does not matter to a
	// packet, but reading the batch top to bottom then says "what it may reach,
	// then that it is restricted".
	if state.Restricted {
		writeElements(&batch, "add", RestrictedSetName, []string{guest.String()})
	}
	if state.Observed {
		writeElements(&batch, "add", ObservedSetName, []string{guest.String()})
	}
	return batch.String(), state, nil
}

// ResolvedBatch admits addresses the host resolver answered for an allowed
// name, each until ttl elapses, refreshing any timeout already running.
func ResolvedBatch(guest netip.Addr, addresses []netip.Addr, ttl time.Duration) string {
	if len(addresses) == 0 {
		return ""
	}
	seconds := int64(ttl / time.Second)
	if seconds < 1 {
		seconds = 1
	}
	plain := make([]string, 0, len(addresses))
	timed := make([]string, 0, len(addresses))
	for _, address := range addresses {
		element := fmt.Sprintf("%s . %s", guest, address)
		plain = append(plain, element)
		timed = append(timed, fmt.Sprintf("%s timeout %ds", element, seconds))
	}
	var batch strings.Builder
	writeElements(&batch, "add", AllowDNSSetName, timed)
	writeElements(&batch, "delete", AllowDNSSetName, plain)
	writeElements(&batch, "add", AllowDNSSetName, timed)
	return batch.String()
}

// RemovalBatch takes a guest out of every per-guest set. Membership goes
// first, so from the first instruction on no rule treats the address as this
// guest's any more.
func RemovalBatch(state GuestEgressState) string {
	var batch strings.Builder
	remove := func(set string, elements []string) {
		if len(elements) == 0 {
			return
		}
		writeElements(&batch, "add", set, elements)
		writeElements(&batch, "delete", set, elements)
	}
	if state.Observed {
		remove(ObservedSetName, []string{state.Guest.String()})
	}
	if state.Restricted {
		remove(RestrictedSetName, []string{state.Guest.String()})
	}
	cidrs := make([]string, 0, len(state.CIDRs))
	for _, prefix := range state.CIDRs {
		cidrs = append(cidrs, fmt.Sprintf("%s . %s", state.Guest, prefix))
	}
	remove(AllowCIDRSetName, cidrs)
	resolved := make([]string, 0, len(state.Resolved))
	for _, address := range state.Resolved {
		resolved = append(resolved, fmt.Sprintf("%s . %s", state.Guest, address))
	}
	remove(AllowDNSSetName, resolved)
	flows := make([]string, 0, len(state.Flows))
	for _, flow := range state.Flows {
		flows = append(flows, flow.element())
	}
	remove(FlowSetName, flows)
	blocked := make([]string, 0, len(state.Blocked))
	for _, flow := range state.Blocked {
		blocked = append(blocked, flow.element())
	}
	remove(BlockedSetName, blocked)
	return batch.String()
}

// FlowRecordBatch removes recorded flows without touching membership. A warm
// guest uses it at claim, so the Attempt's record starts empty.
func FlowRecordBatch(flows, blocked []Flow) string {
	return RemovalBatch(GuestEgressState{Flows: flows, Blocked: blocked})
}

func writeElements(batch *strings.Builder, verb, set string, elements []string) {
	fmt.Fprintf(batch, "%s element inet %s %s { %s }\n", verb, TableName, set, strings.Join(elements, ", "))
}

// CollapsePrefixes drops every prefix another one already covers. An interval
// set refuses overlapping elements, and a Profile listing 10.0.0.0/8 next to
// 10.1.0.0/16 means the same as listing the /8 alone.
func CollapsePrefixes(prefixes []netip.Prefix) []netip.Prefix {
	sorted := make([]netip.Prefix, 0, len(prefixes))
	for _, prefix := range prefixes {
		sorted = append(sorted, prefix.Masked())
	}
	slices.SortFunc(sorted, func(left, right netip.Prefix) int {
		if left.Bits() != right.Bits() {
			return left.Bits() - right.Bits()
		}
		return left.Addr().Compare(right.Addr())
	})
	var collapsed []netip.Prefix
	for _, prefix := range sorted {
		covered := false
		for _, kept := range collapsed {
			if kept.Contains(prefix.Addr()) && kept.Bits() <= prefix.Bits() {
				covered = true
				break
			}
		}
		if !covered {
			collapsed = append(collapsed, prefix)
		}
	}
	slices.SortFunc(collapsed, func(left, right netip.Prefix) int {
		return left.Addr().Compare(right.Addr())
	})
	return collapsed
}

// ParseFlowSet reads `nft --json list set inet runner-center <rc_flows|rc_blocked>`
// and returns the flows recorded for guest. Elements of other guests, and any
// element in a shape this build does not recognise, are skipped: a record is
// evidence of what a job did, and a newer nft adding fields must not lose it.
func ParseFlowSet(listOutput []byte, guest netip.Addr) ([]Flow, error) {
	var document struct {
		Nftables []struct {
			Set *struct {
				Elem []json.RawMessage `json:"elem"`
			} `json:"set,omitempty"`
		} `json:"nftables"`
	}
	if err := json.Unmarshal(listOutput, &document); err != nil {
		return nil, fmt.Errorf("decode nftables flow record: %w", err)
	}
	var flows []Flow
	for _, entry := range document.Nftables {
		if entry.Set == nil {
			continue
		}
		for _, raw := range entry.Set.Elem {
			flow, ok := parseFlowElement(raw)
			if ok && flow.Guest == guest {
				flows = append(flows, flow)
			}
		}
	}
	return flows, nil
}

// parseFlowElement accepts both shapes nft prints a concatenated element in:
// a bare {"concat": [...]}, and {"elem": {"val": {"concat": [...]}, ...}} when
// the element carries a timeout.
func parseFlowElement(raw json.RawMessage) (Flow, bool) {
	var element struct {
		Concat []any `json:"concat"`
		Elem   *struct {
			Val struct {
				Concat []any `json:"concat"`
			} `json:"val"`
		} `json:"elem"`
	}
	if err := json.Unmarshal(raw, &element); err != nil {
		return Flow{}, false
	}
	parts := element.Concat
	if element.Elem != nil {
		parts = element.Elem.Val.Concat
	}
	if len(parts) != 4 {
		return Flow{}, false
	}
	guestText, guestOK := parts[0].(string)
	destinationText, destinationOK := parts[1].(string)
	if !guestOK || !destinationOK {
		return Flow{}, false
	}
	guest, err := netip.ParseAddr(guestText)
	if err != nil {
		return Flow{}, false
	}
	destination, err := netip.ParseAddr(destinationText)
	if err != nil {
		return Flow{}, false
	}
	protocol, ok := flowProtocol(parts[2])
	if !ok {
		return Flow{}, false
	}
	port, ok := flowPort(parts[3])
	if !ok {
		return Flow{}, false
	}
	return Flow{Guest: guest, Destination: destination, Protocol: protocol, Port: port}, true
}

func flowProtocol(value any) (string, bool) {
	switch typed := value.(type) {
	case string:
		if typed == "tcp" || typed == "udp" {
			return typed, true
		}
	case float64:
		switch typed {
		case 6:
			return "tcp", true
		case 17:
			return "udp", true
		}
	}
	return "", false
}

func flowPort(value any) (uint16, bool) {
	switch typed := value.(type) {
	case float64:
		if typed >= 0 && typed <= 65535 && typed == float64(int(typed)) {
			return uint16(typed), true
		}
	case string:
		// nft prints a service name only when asked to (-S); accept a number in
		// a string, and nothing else, rather than guess at /etc/services.
		if parsed, err := strconv.ParseUint(typed, 10, 16); err == nil {
			return uint16(parsed), true
		}
	}
	return 0, false
}
