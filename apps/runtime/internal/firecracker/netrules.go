package firecracker

import (
	"errors"
	"fmt"
	"net"
	"strings"
)

// The iptables state the CNI plugins leave behind for one guest, beyond the
// host-local reservation file that cnistate.go already tracks:
//
//   - ptp: one POSTROUTING jump in the nat table, `-s <ip>/32 -j CNI-<hash>`,
//     tagged with the comment `name: "<network>" id: "<containerID>"`, plus
//     the CNI-<hash> chain it jumps to (the masquerade rule itself).
//   - firewall: two rules in the filter table's CNI-FORWARD chain keyed only
//     by the guest's address, `-d <ip>/32 ... RELATED,ESTABLISHED -j ACCEPT`
//     and `-s <ip>/32 -j ACCEPT`.
//
// A CNI DEL removes all of them, but only when it runs to completion with the
// guest's netns still mounted: ptp skips the masquerade teardown when the veth
// is already gone, and a DEL interrupted by a control-group kill leaves
// whichever half it had not reached. Recovery's backstop then removes the
// reservation file, and nothing after that can name the guest again. Each
// stray costs every packet from every guest one more chain walk (#143).
const (
	natTable      = "nat"
	filterTable   = "filter"
	postrouting   = "POSTROUTING"
	cniForward    = "CNI-FORWARD"
	cniChainStart = "CNI-"
)

// A natRule is one ptp masquerade jump parsed from `iptables -t nat -S`.
type natRule struct {
	ContainerID string
	// IP is the guest address without its prefix length.
	IP    string
	Chain string
	// Spec is the rule as iptables printed it, minus the leading `-A <chain>`,
	// which is exactly what `-D <chain>` accepts to delete it.
	Spec []string
}

// A forwardRule is one firewall-plugin rule in CNI-FORWARD.
type forwardRule struct {
	IP   string
	Spec []string
}

// hostRules is the slice of go-iptables that recovery and readiness use. The
// production implementation shells out to the same iptables binary the CNI
// plugins use; tests supply a table in memory.
type hostRules interface {
	ChainExists(table, chain string) (bool, error)
	List(table, chain string) ([]string, error)
	Delete(table, chain string, rulespec ...string) error
	ClearAndDeleteChain(table, chain string) error
}

// splitRuleSpec tokenises one line of `iptables -S` output. Comments are the
// only quoted tokens, printed as "..." with inner quotes and backslashes
// escaped the way iptables-save writes them.
func splitRuleSpec(line string) []string {
	var (
		fields  []string
		current strings.Builder
		quoted  bool
		escaped bool
		pending bool
	)
	for _, char := range line {
		switch {
		case escaped:
			current.WriteRune(char)
			escaped = false
		case char == '\\' && quoted:
			escaped = true
		case char == '"':
			quoted = !quoted
			pending = true
		case char == ' ' && !quoted:
			if pending {
				fields = append(fields, current.String())
				current.Reset()
				pending = false
			}
		default:
			current.WriteRune(char)
			pending = true
		}
	}
	if pending {
		fields = append(fields, current.String())
	}
	return fields
}

// ruleFlag returns the value following flag in a rule spec, if present.
func ruleFlag(spec []string, flag string) (string, bool) {
	for i := 0; i+1 < len(spec); i++ {
		if spec[i] == flag {
			return spec[i+1], true
		}
	}
	return "", false
}

// appendedSpec returns the rule spec of an `-A <chain>` line, or nil for the
// chain's policy and definition lines that `-S` prints first.
func appendedSpec(line, chain string) []string {
	fields := splitRuleSpec(line)
	if len(fields) < 3 || fields[0] != "-A" || fields[1] != chain {
		return nil
	}
	return fields[2:]
}

// stripPrefixLength turns the `<ip>/32` iptables prints into the bare address
// host-local names its reservation file after.
func stripPrefixLength(cidr string) string {
	if ip, _, err := net.ParseCIDR(cidr); err == nil {
		return ip.String()
	}
	if ip := net.ParseIP(cidr); ip != nil {
		return ip.String()
	}
	return ""
}

// parseNATRules picks out the masquerade jumps ptp installed for guests of
// networkName from a POSTROUTING listing. Rules for other networks, and the
// chain's policy line, are ignored.
func parseNATRules(lines []string, networkName string) []natRule {
	prefix := fmt.Sprintf("name: %q id: \"", networkName)
	var rules []natRule
	for _, line := range lines {
		spec := appendedSpec(line, postrouting)
		if spec == nil {
			continue
		}
		comment, ok := ruleFlag(spec, "--comment")
		if !ok || !strings.HasPrefix(comment, prefix) || !strings.HasSuffix(comment, "\"") {
			continue
		}
		containerID := strings.TrimSuffix(strings.TrimPrefix(comment, prefix), "\"")
		source, _ := ruleFlag(spec, "-s")
		chain, _ := ruleFlag(spec, "-j")
		if containerID == "" || !strings.HasPrefix(chain, cniChainStart) {
			continue
		}
		rules = append(rules, natRule{
			ContainerID: containerID,
			IP:          stripPrefixLength(source),
			Chain:       chain,
			Spec:        spec,
		})
	}
	return rules
}

// parseForwardRules picks out the per-guest accept rules from a CNI-FORWARD
// listing. The firewall plugin's own admin-override jump carries no address
// and is left alone.
func parseForwardRules(lines []string) []forwardRule {
	var rules []forwardRule
	for _, line := range lines {
		spec := appendedSpec(line, cniForward)
		if spec == nil {
			continue
		}
		address, ok := ruleFlag(spec, "-s")
		if !ok {
			address, ok = ruleFlag(spec, "-d")
		}
		if !ok {
			continue
		}
		if ip := stripPrefixLength(address); ip != "" {
			rules = append(rules, forwardRule{IP: ip, Spec: spec})
		}
	}
	return rules
}

// listGuestRules reads both chains. A host that has never run a guest has no
// CNI-FORWARD chain at all; that is an empty result, not an error.
func listGuestRules(table hostRules, networkName string) ([]natRule, []forwardRule, error) {
	natLines, err := table.List(natTable, postrouting)
	if err != nil {
		return nil, nil, fmt.Errorf("list %s %s: %w", natTable, postrouting, err)
	}
	exists, err := table.ChainExists(filterTable, cniForward)
	if err != nil {
		return nil, nil, fmt.Errorf("look up %s: %w", cniForward, err)
	}
	var forwardLines []string
	if exists {
		if forwardLines, err = table.List(filterTable, cniForward); err != nil {
			return nil, nil, fmt.Errorf("list %s: %w", cniForward, err)
		}
	}
	return parseNATRules(natLines, networkName), parseForwardRules(forwardLines), nil
}

// strayGuestRules is the rule state no guest can claim: a masquerade jump
// whose container ID owned() rejects, and a forward rule for an address that
// neither an owned reservation nor an owned masquerade jump accounts for.
func strayGuestRules(
	nat []natRule,
	forward []forwardRule,
	ownedIPs map[string]struct{},
	owned func(containerID string) bool,
) ([]natRule, []forwardRule) {
	ips := make(map[string]struct{}, len(ownedIPs)+len(nat))
	for ip := range ownedIPs {
		ips[ip] = struct{}{}
	}
	var strayNAT []natRule
	for _, rule := range nat {
		if owned(rule.ContainerID) {
			if rule.IP != "" {
				ips[rule.IP] = struct{}{}
			}
			continue
		}
		strayNAT = append(strayNAT, rule)
	}
	var strayForward []forwardRule
	for _, rule := range forward {
		if _, ok := ips[rule.IP]; !ok {
			strayForward = append(strayForward, rule)
		}
	}
	return strayNAT, strayForward
}

// deleteGuestRules removes stray rules the way the plugins would have: the
// POSTROUTING jump, then the chain it pointed at, then the forward accepts.
// Every rule is attempted; the errors are joined so one refusal does not
// leave the rest in place.
func deleteGuestRules(table hostRules, nat []natRule, forward []forwardRule) error {
	var deleteErrors []error
	for _, rule := range nat {
		if err := table.Delete(natTable, postrouting, rule.Spec...); err != nil {
			deleteErrors = append(deleteErrors, fmt.Errorf(
				"delete masquerade jump for %s: %w", rule.ContainerID, err,
			))
			continue
		}
		if err := table.ClearAndDeleteChain(natTable, rule.Chain); err != nil {
			deleteErrors = append(deleteErrors, fmt.Errorf(
				"delete masquerade chain %s for %s: %w", rule.Chain, rule.ContainerID, err,
			))
		}
	}
	for _, rule := range forward {
		if err := table.Delete(filterTable, cniForward, rule.Spec...); err != nil {
			deleteErrors = append(deleteErrors, fmt.Errorf(
				"delete forward rule for %s: %w", rule.IP, err,
			))
		}
	}
	return errors.Join(deleteErrors...)
}
