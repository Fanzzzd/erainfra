package netpolicy

import (
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
// depends on. Unknown fields are ignored so a newer nftables release that adds
// keys does not fail an otherwise correct host.
type nftDocument struct {
	Nftables []struct {
		Table *struct {
			Family string `json:"family"`
			Name   string `json:"name"`
		} `json:"table,omitempty"`
		Chain *struct {
			Family string `json:"family"`
			Table  string `json:"table"`
			Name   string `json:"name"`
			Type   string `json:"type"`
			Hook   string `json:"hook"`
			Policy string `json:"policy"`
		} `json:"chain,omitempty"`
		Rule *struct {
			Family  string `json:"family"`
			Table   string `json:"table"`
			Chain   string `json:"chain"`
			Comment string `json:"comment"`
		} `json:"rule,omitempty"`
		Set *struct {
			Family string `json:"family"`
			Table  string `json:"table"`
			Name   string `json:"name"`
			Elem   []any  `json:"elem"`
		} `json:"set,omitempty"`
	} `json:"nftables"`
}

// VerifyNftables reports whether the live nftables table enforces this policy.
//
// It takes the output of `nft --json list table inet runner-center`. Every rule
// the policy installs carries a stable comment, and the check requires each
// chain to contain exactly its expected comments in order: a removed rule, a
// reordered rule and an inserted uncommented rule all fail, which is what makes
// a host's isolation verifiable rather than assumed.
func (p Policy) VerifyNftables(listOutput []byte) error {
	if err := p.Validate(); err != nil {
		return err
	}
	var document nftDocument
	if err := json.Unmarshal(listOutput, &document); err != nil {
		return fmt.Errorf("decode nftables state: %w", err)
	}

	tableFound := false
	chains := map[string]string{}
	rules := map[string][]string{}
	sets := map[string][]string{}
	for _, entry := range document.Nftables {
		switch {
		case entry.Table != nil:
			if entry.Table.Family == "inet" && entry.Table.Name == TableName {
				tableFound = true
			}
		case entry.Chain != nil:
			if entry.Chain.Family != "inet" || entry.Chain.Table != TableName {
				continue
			}
			if entry.Chain.Type != "filter" {
				return fmt.Errorf("chain %q must be a filter chain, not %q", entry.Chain.Name, entry.Chain.Type)
			}
			chains[entry.Chain.Name] = entry.Chain.Hook
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
			rules[entry.Rule.Chain] = append(rules[entry.Rule.Chain], entry.Rule.Comment)
		case entry.Set != nil:
			if entry.Set.Family != "inet" || entry.Set.Table != TableName {
				continue
			}
			sets[entry.Set.Name] = setPrefixes(entry.Set.Elem)
		}
	}
	if !tableFound {
		return fmt.Errorf(
			"nftables table inet %s is missing; the host is not enforcing job network isolation",
			TableName,
		)
	}

	for chain, expectedComments := range p.ExpectedRules() {
		hook, ok := chains[chain]
		if !ok {
			return fmt.Errorf("nftables chain %q is missing from table inet %s", chain, TableName)
		}
		if hook != chain {
			return fmt.Errorf("nftables chain %q must hook %q, not %q", chain, chain, hook)
		}
		if !slices.Equal(rules[chain], expectedComments) {
			return fmt.Errorf(
				"nftables chain %q enforces [%s] but this Profile requires [%s]",
				chain,
				strings.Join(rules[chain], " "),
				strings.Join(expectedComments, " "),
			)
		}
	}

	if err := verifySet(sets, GuestSetName, []string{p.Subnet}); err != nil {
		return err
	}
	return verifySet(sets, AllowSetName, p.allowedOrEmpty())
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
