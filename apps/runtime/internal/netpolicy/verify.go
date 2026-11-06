package netpolicy

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/netip"
	"os/exec"
	"reflect"
	"slices"
	"sort"
	"strings"
)

// VerifyConflist reports whether the installed CNI configuration is exactly the
// one this policy describes.
//
// The comparison is semantic rather than textual — formatting differences are
// irrelevant, a changed subnet or a removed plugin is not.
func (p Policy) VerifyConflist(installed []byte) error {
	expectedBytes, err := p.Conflist()
	if err != nil {
		return err
	}
	var expected, actual map[string]any
	if err := json.Unmarshal(expectedBytes, &expected); err != nil {
		return fmt.Errorf("decode expected CNI configuration: %w", err)
	}
	if err := json.Unmarshal(installed, &actual); err != nil {
		return fmt.Errorf("decode installed CNI configuration: %w", err)
	}
	if reflect.DeepEqual(expected, actual) {
		return nil
	}
	differing := differingKeys(expected, actual)
	return fmt.Errorf(
		"installed CNI configuration does not match the Profile network policy (differs at: %s); "+
			"reinstall it with the host provisioner",
		strings.Join(differing, ", "),
	)
}

func differingKeys(expected, actual map[string]any) []string {
	seen := map[string]struct{}{}
	for key := range expected {
		seen[key] = struct{}{}
	}
	for key := range actual {
		seen[key] = struct{}{}
	}
	var differing []string
	for key := range seen {
		if !reflect.DeepEqual(expected[key], actual[key]) {
			differing = append(differing, key)
		}
	}
	sort.Strings(differing)
	if len(differing) == 0 {
		return []string{"(no keyed difference; the documents are not comparable)"}
	}
	return differing
}

// nftDocument is the subset of `nft --json list table ...` output the policy
// depends on. Volatile handles, counters and live element expiry are not policy.
// Rule expressions, chain configuration and set definitions are policy.
type nftDocument struct {
	Nftables []struct {
		Metainfo json.RawMessage `json:"metainfo,omitempty"`
		Table    *struct {
			Family  string          `json:"family"`
			Name    string          `json:"name"`
			Handle  json.RawMessage `json:"handle,omitempty"`
			Comment string          `json:"comment,omitempty"`
			Flags   []string        `json:"flags,omitempty"`
		} `json:"table,omitempty"`
		Chain *struct {
			Handle   json.RawMessage `json:"handle,omitempty"`
			Comment  string          `json:"comment,omitempty"`
			Family   string          `json:"family"`
			Table    string          `json:"table"`
			Name     string          `json:"name"`
			Type     string          `json:"type"`
			Hook     string          `json:"hook"`
			Policy   string          `json:"policy"`
			Priority *int            `json:"prio"`
			Device   string          `json:"dev"`
			Flags    []string        `json:"flags"`
		} `json:"chain,omitempty"`
		Rule *struct {
			Handle  json.RawMessage `json:"handle,omitempty"`
			Family  string          `json:"family"`
			Table   string          `json:"table"`
			Chain   string          `json:"chain"`
			Comment string          `json:"comment"`
			Expr    []any           `json:"expr"`
		} `json:"rule,omitempty"`
		Set *struct {
			Handle  json.RawMessage `json:"handle,omitempty"`
			Comment string          `json:"comment,omitempty"`
			Family  string          `json:"family"`
			Table   string          `json:"table"`
			Name    string          `json:"name"`
			Elem    []any           `json:"elem"`
			Type    any             `json:"type"`
			Flags   []string        `json:"flags"`
			Timeout int             `json:"timeout"`
			Size    int             `json:"size"`
		} `json:"set,omitempty"`
	} `json:"nftables"`
}

// VerifyNftables reports whether the live nftables table enforces this policy.
//
// It takes the output of `nft --json list table inet runner-center`. Every rule
// the policy installs carries a stable comment, and the check requires each
// chain to contain exactly its expected comments in order: a removed rule, a
// reordered rule and an inserted uncommented rule all fail, which is what makes
// a host's isolation verifiable rather than assumed. Each rule's normalized
// expressions must also match the enforcement contract, not merely its comment.
func (p Policy) VerifyNftables(listOutput []byte) error {
	if err := p.Validate(); err != nil {
		return err
	}
	var document nftDocument
	// Reject unknown enforcement fields instead of assuming a newer nft option
	// is harmless. Expression maps are compared in full below; handles and live
	// element metadata are deliberately opaque. Unmarshal also rejects trailing
	// data, which a single Decoder.Decode would otherwise leave unread.
	if err := json.Unmarshal(listOutput, &document); err != nil {
		return fmt.Errorf("decode nftables state: %w", err)
	}
	decoder := json.NewDecoder(bytes.NewReader(listOutput))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&document); err != nil {
		return fmt.Errorf("decode nftables enforcement fields: %w", err)
	}

	tableFound := false
	type liveChain struct {
		chainType, hook, policy string
		priority                *int
	}
	chains := map[string]liveChain{}
	rules := map[string][]string{}
	sets := map[string][]string{}
	for _, entry := range document.Nftables {
		switch {
		case entry.Table != nil:
			if entry.Table.Family == "inet" && entry.Table.Name == TableName {
				if tableFound || len(entry.Table.Flags) != 0 {
					return fmt.Errorf("nftables table %s has unexpected flags or duplicate metadata", TableName)
				}
				tableFound = true
			}
		case entry.Chain != nil:
			if entry.Chain.Family != "inet" || entry.Chain.Table != TableName {
				continue
			}
			if _, exists := chains[entry.Chain.Name]; exists {
				return fmt.Errorf("duplicate nftables chain %q", entry.Chain.Name)
			}
			if entry.Chain.Device != "" || len(entry.Chain.Flags) != 0 {
				return fmt.Errorf("nftables chain %q has unexpected device or flags", entry.Chain.Name)
			}
			chains[entry.Chain.Name] = liveChain{chainType: entry.Chain.Type, hook: entry.Chain.Hook, policy: entry.Chain.Policy, priority: entry.Chain.Priority}
		case entry.Rule != nil:
			if entry.Rule.Family != "inet" || entry.Rule.Table != TableName {
				continue
			}
			if entry.Rule.Comment == "" {
				return fmt.Errorf(
					"chain %q contains a rule EraInfra did not install; "+
						"an unmanaged rule can widen the job network boundary",
					entry.Rule.Chain,
				)
			}
			if err := verifyExpressions(entry.Rule.Comment, entry.Rule.Expr); err != nil {
				return err
			}
			rules[entry.Rule.Chain] = append(rules[entry.Rule.Chain], entry.Rule.Comment)
		case entry.Set != nil:
			if entry.Set.Family != "inet" || entry.Set.Table != TableName {
				continue
			}
			if _, exists := sets[entry.Set.Name]; exists {
				return fmt.Errorf("duplicate nftables set %q", entry.Set.Name)
			}
			if err := verifySetDefinition(entry.Set.Name, entry.Set.Type, entry.Set.Flags, entry.Set.Timeout, entry.Set.Size); err != nil {
				return err
			}
			prefixes := setPrefixes(entry.Set.Elem)
			if (entry.Set.Name == GuestSetName || entry.Set.Name == AllowSetName) && len(prefixes) != len(entry.Set.Elem) {
				return fmt.Errorf("nftables set %q contains an unrecognized static permission", entry.Set.Name)
			}
			sets[entry.Set.Name] = prefixes
		}
	}
	if !tableFound {
		return fmt.Errorf(
			"nftables table inet %s is missing; the host is not enforcing job network isolation",
			TableName,
		)
	}

	expectedChains := p.ExpectedChains()
	names := make([]string, 0, len(expectedChains))
	for name := range expectedChains {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, chain := range names {
		expected := expectedChains[chain]
		live, ok := chains[chain]
		if !ok {
			return fmt.Errorf("nftables chain %q is missing from table inet %s", chain, TableName)
		}
		if live.chainType != expected.Type {
			return fmt.Errorf("nftables chain %q must be of type %q, not %q", chain, expected.Type, live.chainType)
		}
		if live.hook != expected.Hook {
			return fmt.Errorf("nftables chain %q must hook %q, not %q", chain, expected.Hook, live.hook)
		}
		if expected.Hook == "" {
			if live.priority != nil || live.policy != "" {
				return fmt.Errorf("regular nftables chain %q has base-chain configuration", chain)
			}
		} else {
			if live.priority == nil || *live.priority != expected.Priority || live.policy != "accept" {
				return fmt.Errorf("nftables chain %q has an unexpected priority or policy", chain)
			}
		}
		if !slices.Equal(rules[chain], expected.Rules) {
			return fmt.Errorf(
				"nftables chain %q enforces [%s] but this Profile requires [%s]",
				chain,
				strings.Join(rules[chain], " "),
				strings.Join(expected.Rules, " "),
			)
		}
	}
	// A chain EraInfra did not render could redirect or re-route guest traffic
	// before any of the verified rules see it.
	for chain := range chains {
		if _, ok := expectedChains[chain]; !ok {
			return fmt.Errorf(
				"nftables table inet %s contains a chain %q EraInfra did not install",
				TableName, chain,
			)
		}
	}

	if err := verifySet(sets, GuestSetName, []string{p.Subnet}); err != nil {
		return err
	}
	if err := verifySet(sets, AllowSetName, p.allowedOrEmpty()); err != nil {
		return err
	}
	// The per-guest sets hold live state; their definitions, not their elements,
	// are part of the static contract. A missing one would make Profile egress
	// rules fail to load or match nothing.
	for _, name := range RuntimeSets() {
		if _, ok := sets[name]; !ok {
			return fmt.Errorf("nftables set %q is missing from table inet %s", name, TableName)
		}
	}
	return nil
}

func verifySet(sets map[string][]string, name string, expected []string) error {
	actual, ok := sets[name]
	if !ok {
		return fmt.Errorf("nftables set %q is missing from table inet %s", name, TableName)
	}
	normalizedExpected := normalizePrefixes(expected)
	normalizedActual := normalizePrefixes(actual)
	if !slices.Equal(normalizedExpected, normalizedActual) {
		return fmt.Errorf(
			"nftables set %q holds [%s] but this Profile requires [%s]",
			name,
			strings.Join(normalizedActual, " "),
			strings.Join(normalizedExpected, " "),
		)
	}
	return nil
}

// setPrefixes flattens the shapes nft uses for interval set members. A single
// address is a bare string, a CIDR is {"prefix":{"addr":...,"len":...}}.
func setPrefixes(elements []any) []string {
	prefixes := make([]string, 0, len(elements))
	for _, element := range elements {
		switch value := element.(type) {
		case string:
			prefixes = append(prefixes, value)
		case map[string]any:
			prefix, ok := value["prefix"].(map[string]any)
			if !ok {
				continue
			}
			address, addressOK := prefix["addr"].(string)
			length, lengthOK := prefix["len"].(float64)
			if addressOK && lengthOK {
				prefixes = append(prefixes, fmt.Sprintf("%s/%d", address, int(length)))
			}
		}
	}
	return prefixes
}

func normalizePrefixes(values []string) []string {
	normalized := make([]string, 0, len(values))
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if prefix, err := netip.ParsePrefix(trimmed); err == nil {
			normalized = append(normalized, prefix.Masked().String())
			continue
		}
		if address, err := netip.ParseAddr(trimmed); err == nil {
			normalized = append(normalized, netip.PrefixFrom(address, address.BitLen()).String())
			continue
		}
		normalized = append(normalized, trimmed)
	}
	sort.Strings(normalized)
	return normalized
}

// VerifyKernelArgs reports whether the guest boot arguments still carry every
// setting the policy relies on.
func VerifyKernelArgs(kernelArgs string) error {
	fields := strings.Fields(kernelArgs)
	var missing []string
	for _, required := range RequiredKernelArgs {
		if !slices.Contains(fields, required) {
			missing = append(missing, required)
		}
	}
	if len(missing) == 0 {
		return nil
	}
	return fmt.Errorf(
		"guest kernel arguments are missing %s, which the job network policy depends on",
		strings.Join(missing, " and "),
	)
}

// ReadLiveTable asks the kernel what it is enforcing right now. Reading the
// file the provisioner wrote would only prove what was intended, not what is
// loaded, so every verification path goes through this.
func ReadLiveTable(ctx context.Context, nftBinary string) ([]byte, error) {
	output, err := exec.CommandContext(ctx, nftBinary, "--json", "list", "table", "inet", TableName).Output()
	if err != nil {
		var exitError *exec.ExitError
		if errors.As(err, &exitError) && len(exitError.Stderr) > 0 {
			return nil, fmt.Errorf("list nftables table: %s", strings.TrimSpace(string(exitError.Stderr)))
		}
		return nil, fmt.Errorf("list nftables table: %w", err)
	}
	return output, nil
}
