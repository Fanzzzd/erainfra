package netpolicy

import (
	"encoding/json"
	"fmt"
	"net/netip"
	"regexp"
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
	Guest netip.Addr
	// Link is the host side of the guest's link, written to rc_guest_links
	// and, bound to Guest, to rc_guest_sources. Every guest has one, public or
	// not: it is what makes the host drop IPv6 and borrowed sources from it.
	Link       string
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

// linkNamePattern is the interface names a guest link may have. The kernel
// allows more, but ptp names host links veth<hex>, and anything outside this
// pattern could not be written safely into an nft batch or a /proc path.
var linkNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,14}$`)

// ValidateLinkName refuses an interface name that is not a plain kernel
// interface name of at most 15 characters.
func ValidateLinkName(link string) error {
	if !linkNamePattern.MatchString(link) {
		return fmt.Errorf("guest link %q is not an interface name this runtime manages", link)
	}
	return nil
}

// RegistrationBatch binds a guest to its link and puts it into the sets its
// effective egress needs. It returns the state it wrote. Every guest gets the
// link binding, so the batch is never empty.
func RegistrationBatch(guest netip.Addr, link string, effective EffectiveEgress) (string, GuestEgressState, error) {
	state := GuestEgressState{Guest: guest, Link: link, Observed: effective.Observed, Restricted: effective.Restricted}
	if !guest.Is4() {
		return "", state, fmt.Errorf("guest address %s must be IPv4", guest)
	}
	if err := ValidateLinkName(link); err != nil {
		return "", state, err
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
	return RestoreBatch(state), state, nil
}

// RestoreBatch writes the elements RegistrationBatch wrote for state: the link
// binding, the allowed CIDRs and the membership. `add element` leaves an
// element that is already there alone, so the batch is safe to apply to a
// guest whose elements are partly or wholly present. Addresses the resolver
// admitted are not in it: their timeouts are not known here, and a guest
// missing one only fails closed until it resolves the name again.
func RestoreBatch(state GuestEgressState) string {
	var batch strings.Builder
	// The link first: what the link may carry, then that it is a guest's. In
	// one transaction a packet sees both or neither.
	writeElements(&batch, "add", GuestSourceSetName, []string{state.sourceElement()})
	writeElements(&batch, "add", GuestLinkSetName, []string{state.linkElement()})
	if len(state.CIDRs) > 0 {
		writeElements(&batch, "add", AllowCIDRSetName, state.cidrElements())
	}
	// Membership last: within one transaction the order does not matter to a
	// packet, but reading the batch top to bottom then says "what it may reach,
	// then that it is restricted".
	if state.Restricted {
		writeElements(&batch, "add", RestrictedSetName, []string{state.Guest.String()})
	}
	if state.Observed {
		writeElements(&batch, "add", ObservedSetName, []string{state.Guest.String()})
	}
	return batch.String()
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
	remove(AllowCIDRSetName, state.cidrElements())
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
	// The link binding goes last. The whole batch is one transaction, so the
	// order is for the reader: the guest stops being anyone's before its link
	// stops being a guest link.
	if state.Link != "" {
		remove(GuestLinkSetName, []string{state.linkElement()})
		remove(GuestSourceSetName, []string{state.sourceElement()})
	}
	return batch.String()
}

// linkElement and sourceElement quote the interface name: nft reads an
// unquoted name as a symbol, which an interface name is not.
func (s GuestEgressState) linkElement() string {
	return strconv.Quote(s.Link)
}

func (s GuestEgressState) sourceElement() string {
	return fmt.Sprintf("%s . %s", strconv.Quote(s.Link), s.Guest)
}

func (s GuestEgressState) cidrElements() []string {
	elements := make([]string, 0, len(s.CIDRs))
	for _, prefix := range s.CIDRs {
		elements = append(elements, fmt.Sprintf("%s . %s", s.Guest, prefix))
	}
	return elements
}

// MissingGuestElements returns the guests in registered whose link binding,
// allowed CIDRs or membership is absent from listOutput, the output of
// `nft --json list table inet runner-center`. registered is what the runtime
// wrote when it registered each guest, so anything missing was taken out by
// something other than the runtime. The usual cause is a reload of the table
// file: it starts with `delete table`, which empties every per-guest set under
// guests that are still running.
func MissingGuestElements(listOutput []byte, registered []GuestEgressState) ([]GuestEgressState, error) {
	live, err := liveGuestElements(listOutput)
	if err != nil {
		return nil, err
	}
	var missing []GuestEgressState
	for _, state := range registered {
		if !live.holds(state) {
			missing = append(missing, state)
		}
	}
	return missing, nil
}

// guestElements is the per-guest set membership a table listing shows, one
// normalised key per element.
type guestElements struct {
	links, sources, observed, restricted, cidrs map[string]struct{}
}

func (e guestElements) holds(state GuestEgressState) bool {
	has := func(set map[string]struct{}, key string) bool {
		_, ok := set[key]
		return ok
	}
	guest := state.Guest.String()
	if !has(e.links, state.Link) || !has(e.sources, state.Link+" . "+guest) {
		return false
	}
	if state.Observed && !has(e.observed, guest) {
		return false
	}
	if state.Restricted && !has(e.restricted, guest) {
		return false
	}
	for _, prefix := range state.CIDRs {
		if !has(e.cidrs, guest+" . "+prefix.Masked().String()) {
			return false
		}
	}
	return true
}

func liveGuestElements(listOutput []byte) (guestElements, error) {
	var document struct {
		Nftables []struct {
			Set *struct {
				Family string `json:"family"`
				Table  string `json:"table"`
				Name   string `json:"name"`
				Elem   []any  `json:"elem"`
			} `json:"set,omitempty"`
		} `json:"nftables"`
	}
	if err := json.Unmarshal(listOutput, &document); err != nil {
		return guestElements{}, fmt.Errorf("decode nftables state: %w", err)
	}
	live := guestElements{
		links: map[string]struct{}{}, sources: map[string]struct{}{},
		observed: map[string]struct{}{}, restricted: map[string]struct{}{}, cidrs: map[string]struct{}{},
	}
	for _, entry := range document.Nftables {
		set := entry.Set
		if set == nil || set.Family != "inet" || set.Table != TableName {
			continue
		}
		var into map[string]struct{}
		switch set.Name {
		case GuestLinkSetName:
			into = live.links
		case GuestSourceSetName:
			into = live.sources
		case ObservedSetName:
			into = live.observed
		case RestrictedSetName:
			into = live.restricted
		case AllowCIDRSetName:
			into = live.cidrs
		default:
			continue
		}
		for _, element := range set.Elem {
			// An element in a shape this build does not read counts as absent.
			// Its guest is then restored, which adds nothing, and readiness
			// fails rather than vouch for what it cannot see.
			if key, ok := elementKey(set.Name, element); ok {
				into[key] = struct{}{}
			}
		}
	}
	return live, nil
}

// elementKey normalises one element of a per-guest set. nft prints a single
// value as a bare string and a concatenation as {"concat": [...]}. An interval
// part is either a bare address, meaning a /32, or
// {"prefix": {"addr": ..., "len": ...}}.
func elementKey(set string, element any) (string, bool) {
	if set == GuestLinkSetName || set == ObservedSetName || set == RestrictedSetName {
		value, ok := element.(string)
		return value, ok
	}
	object, ok := element.(map[string]any)
	if !ok {
		return "", false
	}
	parts, ok := object["concat"].([]any)
	if !ok || len(parts) != 2 {
		return "", false
	}
	first, ok := parts[0].(string)
	if !ok {
		return "", false
	}
	if set == GuestSourceSetName {
		second, ok := parts[1].(string)
		return first + " . " + second, ok
	}
	prefix, ok := intervalPrefix(parts[1])
	if !ok {
		return "", false
	}
	return first + " . " + prefix.String(), true
}

func intervalPrefix(value any) (netip.Prefix, bool) {
	switch typed := value.(type) {
	case string:
		address, err := netip.ParseAddr(typed)
		if err != nil {
			return netip.Prefix{}, false
		}
		return netip.PrefixFrom(address, address.BitLen()), true
	case map[string]any:
		prefix, ok := typed["prefix"].(map[string]any)
		if !ok {
			return netip.Prefix{}, false
		}
		addressText, addressOK := prefix["addr"].(string)
		length, lengthOK := prefix["len"].(float64)
		if !addressOK || !lengthOK {
			return netip.Prefix{}, false
		}
		address, err := netip.ParseAddr(addressText)
		if err != nil {
			return netip.Prefix{}, false
		}
		parsed, err := address.Prefix(int(length))
		return parsed, err == nil
	}
	return netip.Prefix{}, false
}

// GuestLinks reads the interfaces in rc_guest_links out of
// `nft --json list table inet runner-center`: the host side of every guest link
// the runtime has registered and not yet torn down.
func GuestLinks(listOutput []byte) ([]string, error) {
	var document struct {
		Nftables []struct {
			Set *struct {
				Family string `json:"family"`
				Table  string `json:"table"`
				Name   string `json:"name"`
				Elem   []any  `json:"elem"`
			} `json:"set,omitempty"`
		} `json:"nftables"`
	}
	if err := json.Unmarshal(listOutput, &document); err != nil {
		return nil, fmt.Errorf("decode nftables state: %w", err)
	}
	var links []string
	for _, entry := range document.Nftables {
		set := entry.Set
		if set == nil || set.Name != GuestLinkSetName || set.Family != "inet" || set.Table != TableName {
			continue
		}
		for _, element := range set.Elem {
			link, ok := element.(string)
			if !ok {
				return nil, fmt.Errorf("nftables set %s holds an element that is not an interface name", GuestLinkSetName)
			}
			links = append(links, link)
		}
	}
	slices.Sort(links)
	return links, nil
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
