// Package runsonmigrate rewrites the `runs-on` labels of a repository's GitHub
// Actions workflows from GitHub-hosted (or another vendor's) labels to EraInfra
// Profile names, the job Blacksmith's Migration Wizard does for its labels.
//
// It never re-serializes YAML. The parser only locates each label; the edit
// replaces the label's own bytes in the original file, so comments, quoting,
// key order, blank lines and line endings stay exactly as they were.
package runsonmigrate

import (
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Where a proposal came from, in the order the Mapper consults them.
const (
	SourceMap          = "map"           // the operator's --map
	SourceControlPlane = "control-plane" // a Profile registered in Convex
	SourceBuiltIn      = "built-in"      // ADR 0010's naming, not checked against Convex
)

// Target is the Profile a label moves to.
type Target struct {
	Label  string `json:"to"`
	Source string `json:"source"`
	Reason string `json:"reason"`
}

// missKind says why a label stays as it is.
type missKind int

const (
	missNone     missKind = iota
	missProfile           // already an EraInfra Profile name: nothing to do, nothing to say
	missGeneric           // self-hosted, linux, x64 and the like
	missUnknown           // a label this package does not recognise
	missNoTarget          // recognised, but no registered Profile runs it
)

type miss struct {
	kind   missKind
	reason string
}

// Profile describes a registered Profile as far as matching needs it.
type Profile struct {
	Name  string
	State string
}

// Mapper decides, for one label, which Profile it becomes.
type Mapper struct {
	user map[string]string
	// registered is nil when the Profiles in Convex are unknown; then names
	// come from ADR 0010's scheme alone.
	registered []parsedProfile
	names      map[string]bool
	known      bool
}

// NewMapper builds a Mapper. user maps a label (matched case-insensitively,
// as GitHub matches labels) to the Profile it should become. registered is
// the control plane's Profile list, or nil when it could not be read.
func NewMapper(user map[string]string, registered []Profile) *Mapper {
	m := &Mapper{user: map[string]string{}, names: map[string]bool{}, known: registered != nil}
	for from, to := range user {
		m.user[strings.ToLower(from)] = to
	}
	for _, p := range registered {
		m.names[strings.ToLower(p.Name)] = true
		if p.State != "" && p.State != "active" {
			continue
		}
		if parsed, ok := parseProfileName(p.Name); ok {
			m.registered = append(m.registered, parsed)
		}
	}
	return m
}

// KnowsRegistered reports whether proposals were checked against Convex.
func (m *Mapper) KnowsRegistered() bool { return m.known }

// Registered reports whether a Profile of this name is registered. It is
// false for every name when the registered Profiles are unknown.
func (m *Mapper) Registered(name string) bool { return m.names[strings.ToLower(name)] }

func (m *Mapper) resolve(label string) (Target, miss) {
	lower := strings.ToLower(strings.TrimSpace(label))
	if to, ok := m.user[lower]; ok {
		if strings.EqualFold(to, label) {
			return Target{}, miss{kind: missProfile}
		}
		return Target{Label: to, Source: SourceMap, Reason: "--map " + label + "=" + to}, miss{}
	}
	// A Profile ADR 0010 renamed moves once its new name is registered: that
	// is the "switch" step of the ADR's register, canary, switch, retire.
	if to, ok := renamedProfiles[lower]; ok {
		if m.known && !m.Registered(to) {
			return Target{}, miss{kind: missNoTarget, reason: fmt.Sprintf("ADR 0010 renames %s to %s, which is not registered yet", label, to)}
		}
		return Target{Label: to, Source: m.source(), Reason: "ADR 0010 renamed " + label}, miss{}
	}
	if m.Registered(lower) || profileNameScheme.MatchString(lower) {
		return Target{}, miss{kind: missProfile}
	}
	if genericLabels[lower] {
		return Target{}, miss{kind: missGeneric, reason: fmt.Sprintf("%q is a generic self-hosted label", label)}
	}
	f, why, ok := familyOf(lower)
	if !ok {
		if why != "" {
			return Target{}, miss{kind: missNoTarget, reason: why}
		}
		return Target{}, miss{kind: missUnknown, reason: fmt.Sprintf("%q is not a GitHub-hosted label this command knows", label)}
	}
	if !m.known {
		// Offline, a moving label means the version it pointed at when the table was written.
		fixed := f
		fixed.latest = false
		return Target{Label: f.builtInName(), Source: SourceBuiltIn, Reason: fixed.describe(label)}, miss{}
	}
	if p, ok := m.pick(f); ok {
		return Target{Label: p.name, Source: SourceControlPlane, Reason: f.describe(label)}, miss{}
	}
	return Target{}, miss{kind: missNoTarget, reason: fmt.Sprintf("no active Profile registered in the control plane runs %s (%s)", f.platform(), label)}
}

func (m *Mapper) source() string {
	if m.known {
		return SourceControlPlane
	}
	return SourceBuiltIn
}

// pick chooses the registered Profile closest to a family: same OS, version
// and architecture; for a `-latest` label the newest registered version; then
// the smallest Profile with at least the label's vCPUs (the largest when none
// has that many), the standard 4 GiB per vCPU before a `-<M>gb` variant, and
// the name. Canary Profiles and
// flavoured images are never picked: neither is what a hosted label means.
func (m *Mapper) pick(f family) (parsedProfile, bool) {
	var candidates []parsedProfile
	for _, p := range m.registered {
		if p.canary || p.flavour != "" || p.os != f.os || p.arm != f.arm {
			continue
		}
		if !f.latest && p.version != f.version {
			continue
		}
		candidates = append(candidates, p)
	}
	if len(candidates) == 0 {
		return parsedProfile{}, false
	}
	if f.latest {
		newest := ""
		for _, p := range candidates {
			if versionLess(newest, p.version) {
				newest = p.version
			}
		}
		kept := candidates[:0]
		for _, p := range candidates {
			if p.version == newest {
				kept = append(kept, p)
			}
		}
		candidates = kept
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		a, b := candidates[i], candidates[j]
		// At least the label's size first, so a moved job is never given
		// fewer cores than it had; among those the smallest, below it the largest.
		aFits, bFits := a.vcpus >= f.vcpus, b.vcpus >= f.vcpus
		if aFits != bFits {
			return aFits
		}
		if a.vcpus != b.vcpus {
			return (a.vcpus < b.vcpus) == aFits
		}
		if (a.memoryGB == 0) != (b.memoryGB == 0) {
			return a.memoryGB == 0
		}
		return a.name < b.name
	})
	return candidates[0], true
}

func versionLess(a, b string) bool {
	if a == "" {
		return true
	}
	x, _ := strconv.Atoi(a)
	y, _ := strconv.Atoi(b)
	return x < y
}

// family is what a label asks for: an OS, its version, the architecture and
// the size it ran at. macOS is Apple silicon only under Tart, so it carries no
// architecture: GitHub's own `macos-15` is arm64 with no suffix, and so is an
// EraInfra macOS Profile name.
type family struct {
	os      string // ubuntu | windows | macos
	version string // undotted: 2404, 2025, 15
	arm     bool
	vcpus   int
	latest  bool
	vendor  string // blacksmith or buildjet when the label is theirs
}

// builtInName is the ADR 0010 name for a family. A vendor label keeps its
// size, which makes the move a prefix change; a hosted label gets the standard
// 4 vCPU, since nobody registers a Profile for ubuntu-slim's single vCPU.
func (f family) builtInName() string {
	vcpus := hostedVCPUs
	if f.vendor != "" {
		vcpus = f.vcpus
	}
	name := fmt.Sprintf("erainfra-%dvcpu-%s-%s", vcpus, f.os, f.version)
	if f.arm {
		name += "-arm"
	}
	return name
}

func (f family) platform() string {
	arch := "x64"
	switch {
	case f.os == "macos":
		arch = "Apple silicon"
	case f.arm:
		arch = "arm64"
	}
	version := f.version
	if f.os == "ubuntu" && len(version) == 4 {
		version = version[:2] + "." + version[2:]
	}
	if f.latest {
		return fmt.Sprintf("the newest %s %s", f.os, arch)
	}
	return fmt.Sprintf("%s %s %s", f.os, version, arch)
}

func (f family) describe(label string) string {
	if f.vendor != "" {
		return fmt.Sprintf("%s label %s: %d vCPU, %s", f.vendor, label, f.vcpus, f.platform())
	}
	return fmt.Sprintf("GitHub-hosted %s: %s", label, f.platform())
}

// GitHub's standard hosted runner for a public repository is 4 vCPU and
// 16 GiB, which is also the ratio ADR 0010 calls standard, so a hosted label
// asks for 4 vCPU. ubuntu-slim is GitHub's 1 vCPU container runner.
const hostedVCPUs = 4

// What the moving labels pointed at when this table was written
// (2026-11-06, docs.github.com runner-images): ubuntu-latest is Ubuntu 24.04,
// windows-latest is Windows Server 2025 and macos-latest is macOS 15. With a
// control-plane token the newest registered version is used instead, so the
// table matters only offline.
var latestVersions = map[string]string{"ubuntu": "2404", "windows": "2025", "macos": "15"}

var (
	ubuntuDotted   = regexp.MustCompile(`^ubuntu-([0-9]{2})\.([0-9]{2})(-arm)?$`)
	windowsYear    = regexp.MustCompile(`^windows-([0-9]{4})$`)
	macosVersion   = regexp.MustCompile(`^macos-([0-9]{2})(-[a-z0-9]+)?$`)
	vendorLabel    = regexp.MustCompile(`^(blacksmith|buildjet)-([1-9][0-9]{0,2})vcpu-(ubuntu|windows)-([0-9]{4})(-arm)?$`)
	vendorMacLabel = regexp.MustCompile(`^(blacksmith|buildjet)-([1-9][0-9]{0,2})vcpu-macos-([0-9]{2})$`)
	largerRunner   = regexp.MustCompile(`^(ubuntu|windows)-.*-([0-9]+)-?cores?$`)
)

// familyOf reads a hosted or vendor label. A recognised label with no
// EraInfra equivalent returns ok false and a reason.
func familyOf(label string) (family, string, bool) {
	switch label {
	case "ubuntu-latest":
		return family{os: "ubuntu", version: latestVersions["ubuntu"], vcpus: hostedVCPUs, latest: true}, "", true
	case "ubuntu-slim":
		return family{os: "ubuntu", version: "2404", vcpus: 1}, "", true
	case "windows-latest":
		return family{os: "windows", version: latestVersions["windows"], vcpus: hostedVCPUs, latest: true}, "", true
	case "macos-latest":
		return family{os: "macos", version: latestVersions["macos"], vcpus: hostedVCPUs, latest: true}, "", true
	case "windows-11-arm":
		return family{}, "windows-11-arm is Windows 11 on arm64; EraInfra has no Hyper-V Profile for arm64", false
	}
	if m := ubuntuDotted.FindStringSubmatch(label); m != nil {
		return family{os: "ubuntu", version: m[1] + m[2], arm: m[3] != "", vcpus: hostedVCPUs}, "", true
	}
	if m := windowsYear.FindStringSubmatch(label); m != nil {
		return family{os: "windows", version: m[1], vcpus: hostedVCPUs}, "", true
	}
	if m := macosVersion.FindStringSubmatch(label); m != nil {
		version, _ := strconv.Atoi(m[1])
		switch {
		case m[2] == "-intel" || m[2] == "-large" || version < 14:
			return family{}, label + " is an Intel Mac; Tart Profiles run on Apple silicon only", false
		case m[2] == "":
			return family{os: "macos", version: m[1], vcpus: hostedVCPUs}, "", true
		}
		// -xlarge and anything newer: a size of its own, which no default maps.
		return family{}, label + " is a GitHub larger runner; map it to a Profile of the size you want with --map", false
	}
	if m := vendorLabel.FindStringSubmatch(label); m != nil {
		vcpus, _ := strconv.Atoi(m[2])
		return family{os: m[3], version: m[4], arm: m[5] != "", vcpus: vcpus, vendor: titleCase(m[1])}, "", true
	}
	if m := vendorMacLabel.FindStringSubmatch(label); m != nil {
		vcpus, _ := strconv.Atoi(m[2])
		return family{os: "macos", version: m[3], vcpus: vcpus, vendor: titleCase(m[1])}, "", true
	}
	if largerRunner.MatchString(label) {
		return family{}, label + " looks like a GitHub larger runner; map it to a Profile of the size you want with --map", false
	}
	return family{}, "", false
}

func titleCase(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

// The labels every self-hosted runner carries by default. A scale set answers
// only to its own labels, so none of these targets a Profile.
var genericLabels = map[string]bool{
	"self-hosted": true, "linux": true, "windows": true, "macos": true,
	"x64": true, "arm64": true, "arm": true,
}

// ADR 0010's renames of the Profiles that predate it.
var renamedProfiles = map[string]string{
	"rc-linux-js": "erainfra-4vcpu-ubuntu-2404",
	"rc-e2e":      "erainfra-canary-4vcpu-ubuntu-2404",
}

// The scheme from ADR 0010, as apps/controller/internal/config/profilename.go
// enforces it: erainfra-[canary-]<N>vcpu-<os><version>[-arm][-<M>gb][-<flavour>].
var profileNameScheme = regexp.MustCompile(
	`^erainfra-(canary-)?([1-9][0-9]*)vcpu-(ubuntu|macos|windows)-([0-9]{2}|[0-9]{4})(-arm)?(-([1-9][0-9]*)gb)?(-([a-z][a-z0-9]*))?$`,
)

type parsedProfile struct {
	name     string
	canary   bool
	vcpus    int
	os       string
	version  string
	arm      bool
	memoryGB int
	flavour  string
}

func parseProfileName(name string) (parsedProfile, bool) {
	m := profileNameScheme.FindStringSubmatch(strings.ToLower(name))
	if m == nil {
		return parsedProfile{}, false
	}
	vcpus, _ := strconv.Atoi(m[2])
	memory, _ := strconv.Atoi(m[7])
	p := parsedProfile{
		name: name, canary: m[1] != "", vcpus: vcpus, os: m[3], version: m[4],
		arm: m[5] != "", memoryGB: memory, flavour: m[9],
	}
	if p.os == "macos" {
		p.arm = false
	}
	return p, true
}
