package netpolicy

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net/netip"
	"reflect"
	"slices"
	"sort"
)

// expectedExpressions describes enforcement independently of the text renderer.
// Live nft fixtures test this contract as well as mutations of individual
// matches and verdicts; stable comments alone are not evidence of enforcement.
func expectedExpressions() map[string][]any {
	payload := func(protocol, field string) any {
		return map[string]any{"payload": map[string]any{"protocol": protocol, "field": field}}
	}
	meta := map[string]any{"meta": map[string]any{"key": "l4proto"}}
	source, destination, port := payload("ip", "saddr"), payload("ip", "daddr"), payload("th", "dport")
	match := func(op string, left, right any) any {
		return map[string]any{"match": map[string]any{"op": op, "left": left, "right": right}}
	}
	member := func(left any, set string) any { return match("==", left, "@"+set) }
	protocols := match("==", meta, map[string]any{"set": []any{"tcp", "udp"}})
	verdict := func(name string) any { return map[string]any{name: nil} }
	concat := func(values ...any) any { return map[string]any{"concat": values} }
	record := func(set string) any {
		return map[string]any{"set": map[string]any{"op": "add", "elem": concat(source, destination, meta, port), "set": "@" + set}}
	}
	private := map[string]any{"set": prefixValues(deniedRanges)}
	state := map[string]any{"ct": map[string]any{"key": "state"}}
	return map[string][]any{
		RuleDenyEastWest:          {member(source, GuestSetName), member(destination, GuestSetName), verdict("drop")},
		RuleRecordFlows:           {member(source, ObservedSetName), match("in", state, "new"), protocols, record(FlowSetName)},
		RuleRestrictProfile:       {member(source, RestrictedSetName), map[string]any{"jump": map[string]any{"target": RestrictedChain}}},
		RuleAllowDestinations:     {member(source, GuestSetName), member(destination, AllowSetName), verdict("accept")},
		RuleDenyPrivate:           {member(source, GuestSetName), match("==", destination, private), verdict("drop")},
		RuleDenyDefault:           {member(source, GuestSetName), verdict("drop")},
		RuleRestrictedEstablished: {match("in", state, []any{"established", "related"}), verdict("return")},
		RuleRestrictedAllowCIDR:   {protocols, member(concat(source, destination), AllowCIDRSetName), verdict("return")},
		RuleRestrictedAllowDNS:    {protocols, member(concat(source, destination), AllowDNSSetName), verdict("return")},
		RuleRecordBlocked:         {protocols, record(BlockedSetName)},
		RuleRestrictedDeny:        {verdict("drop")},
		RuleRedirectDNS:           {member(source, ObservedSetName), protocols, match("==", port, float64(53)), map[string]any{"redirect": map[string]any{"port": float64(ResolverPort)}}},
		RuleAllowResolver:         {member(source, ObservedSetName), protocols, match("==", port, float64(ResolverPort)), verdict("accept")},
		RuleDenyHostInput:         {member(source, GuestSetName), verdict("drop")},
	}
}

func prefixValues(prefixes []string) []any {
	values := make([]any, 0, len(prefixes))
	for _, value := range prefixes {
		// These are validated, constant policy prefixes, not live input.
		prefix := netip.MustParsePrefix(value).Masked()
		address, bits := prefix.Addr().String(), prefix.Bits()
		values = append(values, map[string]any{"prefix": map[string]any{"addr": address, "len": float64(bits)}})
	}
	return values
}

// normalizeExpression canonicalizes unordered anonymous sets and conntrack
// masks, while preserving concatenation and statement order. Operators and
// set references remain significant. verifyExpressions removes only counters.
func normalizeExpression(value any) any {
	switch value := value.(type) {
	case []any:
		result := make([]any, 0, len(value))
		for _, child := range value {
			result = append(result, normalizeExpression(child))
		}
		return result
	case map[string]any:
		result := make(map[string]any, len(value))
		for key, child := range value {
			result[key] = normalizeExpression(child)
		}
		if members, ok := result["set"].([]any); ok {
			if intervals, ok := prefixIntervals(members); ok {
				result["set"] = intervals
			} else {
				sortJSONValues(members)
			}
		}
		if match, ok := result["match"].(map[string]any); ok {
			// nft encodes a conntrack state mask as an array rather than a set.
			if reflect.DeepEqual(match["left"], map[string]any{"ct": map[string]any{"key": "state"}}) {
				if members, ok := match["right"].([]any); ok {
					sortJSONValues(members)
				}
			}
		}
		return result
	default:
		return value
	}
}

// nft merges adjacent anonymous IP prefixes (224/4 + 240/4 becomes
// 224/3). Compare their address unions, without discarding unknown members.
func prefixIntervals(members []any) ([][2]uint64, bool) {
	intervals := make([][2]uint64, 0, len(members))
	for _, member := range members {
		object, ok := member.(map[string]any)
		if !ok || len(object) != 1 {
			return nil, false
		}
		value, ok := object["prefix"].(map[string]any)
		if !ok || len(value) != 2 {
			return nil, false
		}
		address, addressOK := value["addr"].(string)
		bits, bitsOK := value["len"].(float64)
		if !addressOK || !bitsOK || bits < 0 || bits > 32 || bits != float64(int(bits)) {
			return nil, false
		}
		prefix, err := netip.ParsePrefix(fmt.Sprintf("%s/%d", address, int(bits)))
		if err != nil || !prefix.Addr().Is4() {
			return nil, false
		}
		octets := prefix.Masked().Addr().As4()
		first := uint64(binary.BigEndian.Uint32(octets[:]))
		intervals = append(intervals, [2]uint64{first, first + (uint64(1) << (32 - int(bits))) - 1})
	}
	slices.SortFunc(intervals, func(a, b [2]uint64) int {
		if a[0] < b[0] {
			return -1
		}
		if a[0] > b[0] {
			return 1
		}
		return 0
	})
	merged := make([][2]uint64, 0, len(intervals))
	for _, interval := range intervals {
		last := len(merged) - 1
		if last >= 0 && interval[0] <= merged[last][1]+1 {
			merged[last][1] = max(merged[last][1], interval[1])
		} else {
			merged = append(merged, interval)
		}
	}
	return merged, true
}

func sortJSONValues(values []any) {
	sort.Slice(values, func(i, j int) bool {
		left, _ := json.Marshal(values[i])
		right, _ := json.Marshal(values[j])
		return string(left) < string(right)
	})
}

func verifyExpressions(comment string, actual []any) error {
	filtered := make([]any, 0, len(actual))
	for _, statement := range actual {
		if object, ok := statement.(map[string]any); ok && len(object) == 1 {
			if _, counter := object["counter"]; counter {
				continue
			}
		}
		filtered = append(filtered, statement)
	}
	expected, ok := expectedExpressions()[comment]
	if !ok || !reflect.DeepEqual(normalizeExpression(filtered), normalizeExpression(expected)) {
		return fmt.Errorf("nftables rule %q does not enforce the required matches and verdict", comment)
	}
	return nil
}

func verifySetDefinition(name string, datatype any, flags []string, timeout, size int) error {
	types := []string{"ipv4_addr"}
	var expectedFlags []string
	expectedTimeout, expectedSize := 0, 0
	switch name {
	case GuestSetName, AllowSetName:
		expectedFlags = []string{"interval"}
	case ObservedSetName, RestrictedSetName:
	case AllowCIDRSetName:
		types = []string{"ipv4_addr", "ipv4_addr"}
		expectedFlags = []string{"interval"}
	case AllowDNSSetName:
		types = []string{"ipv4_addr", "ipv4_addr"}
		expectedFlags = []string{"timeout"}
	case FlowSetName, BlockedSetName:
		types = []string{"ipv4_addr", "ipv4_addr", "inet_proto", "inet_service"}
		expectedFlags = []string{"dynamic", "timeout"}
		expectedTimeout, expectedSize = 7*60*60, FlowRecordCapacity
	default:
		return fmt.Errorf("nftables set %q was not installed by EraInfra", name)
	}
	var expectedType any = types[0]
	if len(types) > 1 {
		values := make([]any, len(types))
		for i, value := range types {
			values[i] = value
		}
		expectedType = values
	}
	sort.Strings(flags)
	if !reflect.DeepEqual(datatype, expectedType) || !slices.Equal(flags, expectedFlags) || timeout != expectedTimeout || size != expectedSize {
		return fmt.Errorf("nftables set %q has an unexpected type, flags, timeout or capacity", name)
	}
	return nil
}
