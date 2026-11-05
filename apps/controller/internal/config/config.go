package config

import (
	"errors"
	"fmt"
	"log/slog"
	"net/netip"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"

	"github.com/Fanzzzd/erainfra/apps/controller/internal/fleet"
	"github.com/Fanzzzd/erainfra/internal/dualenv"
	"github.com/actions/scaleset"
)

type Config struct {
	ConvexURL       string
	ControllerToken string
	MachineToken    string
	RegistrationURL string
	Profile         string
	Executor        string
	ImageRelease    string
	VCPUs           int64
	MemoryMiB       int64
	WarmPool        int
	FitPolicy       string
	ScaleSetName    string
	Labels          []string
	RunnerGroup     string
	MinRunners      int
	MaxRunners      int
	LogLevel        slog.Level
	GitHubApp       *scaleset.GitHubAppAuth
	GitHubToken     string
	CacheFactsURL   string
	CacheSigningKey string
	// Egress is the Profile's egress policy, published with the rest of the
	// contract. Empty mode is public egress.
	Egress Egress
}

// Egress is RC_EGRESS_MODE, RC_EGRESS_PRESETS and RC_EGRESS_ALLOW, with
// RC_EGRESS_ALLOW split into the domains and CIDRs it names. The control plane
// validates every entry again before it stores the Profile, and each Worker
// validates it once more before it enforces it.
type Egress struct {
	Mode    string   `json:"mode"`
	Presets []string `json:"presets,omitempty"`
	Domains []string `json:"domains,omitempty"`
	CIDRs   []string `json:"cidrs,omitempty"`
}

// Published reports whether the Profile carries an egress policy at all. A
// controller with none configured publishes none, which every reader treats
// as public egress.
func (e Egress) Published() bool {
	return e.Mode != "" || len(e.Presets)+len(e.Domains)+len(e.CIDRs) > 0
}

// Load reads the controller's configuration. Every RC_<NAME> it reads is also accepted as
// ERAINFRA_<NAME>, which wins; the two set to different values is refused before anything else is
// read (docs/runbooks/rename-phase-2.md, section 1).
func Load() (Config, error) {
	if err := dualenv.Check(); err != nil {
		return Config{}, err
	}
	config := Config{
		ConvexURL:       strings.TrimSpace(dualenv.Value("RC_CONVEX_URL")),
		RegistrationURL: strings.TrimSpace(dualenv.Value("RC_GITHUB_CONFIG_URL")),
		Profile:         strings.TrimSpace(dualenv.Value("RC_PROFILE")),
		Executor:        strings.TrimSpace(dualenv.Value("RC_EXECUTOR")),
		ImageRelease:    strings.TrimSpace(dualenv.Value("RC_IMAGE_RELEASE")),
		ScaleSetName:    strings.TrimSpace(dualenv.Value("RC_SCALE_SET_NAME")),
		RunnerGroup:     strings.TrimSpace(dualenv.Value("RC_RUNNER_GROUP")),
		MinRunners:      0,
		MaxRunners:      1,
		VCPUs:           2,
		MemoryMiB:       4096,
		FitPolicy:       "balanced",
		WarmPool:        0,
		LogLevel:        slog.LevelInfo,
	}
	if value := strings.ToLower(strings.TrimSpace(dualenv.Value("RC_FIT_POLICY"))); value != "" {
		config.FitPolicy = value
	}
	if config.ScaleSetName == "" {
		config.ScaleSetName = config.Profile
	}
	if config.RunnerGroup == "" {
		config.RunnerGroup = scaleset.DefaultRunnerGroup
	}
	for _, label := range strings.Split(dualenv.Value("RC_LABELS"), ",") {
		if value := strings.TrimSpace(label); value != "" {
			config.Labels = append(config.Labels, value)
		}
	}
	if len(config.Labels) == 0 && config.Profile != "" {
		config.Labels = []string{config.Profile}
	}

	var err error
	config.ControllerToken, err = readSecret("RC_CONTROLLER_TOKEN", "RC_CONTROLLER_TOKEN_FILE")
	if err != nil {
		return Config{}, err
	}
	config.MachineToken, err = readSecret("RC_MACHINE_TOKEN", "RC_MACHINE_TOKEN_FILE")
	if err != nil {
		return Config{}, err
	}
	config.GitHubToken, err = readSecret("RC_GITHUB_TOKEN", "RC_GITHUB_TOKEN_FILE")
	if err != nil {
		return Config{}, err
	}
	config.CacheFactsURL = strings.TrimSpace(dualenv.Value("RC_CACHE_FACTS_URL"))
	config.CacheSigningKey, err = readSecret("RC_CACHE_SIGNING_KEY", "RC_CACHE_SIGNING_KEY_FILE")
	if err != nil {
		return Config{}, err
	}
	privateKey, err := readSecret("RC_GITHUB_APP_PRIVATE_KEY", "RC_GITHUB_APP_PRIVATE_KEY_FILE")
	if err != nil {
		return Config{}, err
	}

	if value := strings.TrimSpace(dualenv.Value("RC_MIN_RUNNERS")); value != "" {
		config.MinRunners, err = strconv.Atoi(value)
		if err != nil {
			return Config{}, fmt.Errorf("RC_MIN_RUNNERS must be an integer: %w", err)
		}
	}
	if value := strings.TrimSpace(dualenv.Value("RC_MAX_RUNNERS")); value != "" {
		config.MaxRunners, err = strconv.Atoi(value)
		if err != nil {
			return Config{}, fmt.Errorf("RC_MAX_RUNNERS must be an integer: %w", err)
		}
	}
	if value := strings.TrimSpace(dualenv.Value("RC_VCPUS")); value != "" {
		config.VCPUs, err = strconv.ParseInt(value, 10, 64)
		if err != nil {
			return Config{}, fmt.Errorf("RC_VCPUS must be an integer: %w", err)
		}
	}
	if value := strings.TrimSpace(dualenv.Value("RC_MEMORY_MIB")); value != "" {
		config.MemoryMiB, err = strconv.ParseInt(value, 10, 64)
		if err != nil {
			return Config{}, fmt.Errorf("RC_MEMORY_MIB must be an integer: %w", err)
		}
	}
	config.Egress = parseEgress(
		dualenv.Value("RC_EGRESS_MODE"), dualenv.Value("RC_EGRESS_PRESETS"), dualenv.Value("RC_EGRESS_ALLOW"),
	)
	if value := strings.TrimSpace(dualenv.Value("RC_WARM_POOL")); value != "" {
		config.WarmPool, err = strconv.Atoi(value)
		if err != nil {
			return Config{}, fmt.Errorf("RC_WARM_POOL must be an integer: %w", err)
		}
	}
	switch strings.ToLower(strings.TrimSpace(dualenv.Value("RC_LOG_LEVEL"))) {
	case "", "info":
	case "debug":
		config.LogLevel = slog.LevelDebug
	case "warn":
		config.LogLevel = slog.LevelWarn
	case "error":
		config.LogLevel = slog.LevelError
	default:
		return Config{}, fmt.Errorf("RC_LOG_LEVEL must be debug, info, warn, or error")
	}

	clientID := strings.TrimSpace(dualenv.Value("RC_GITHUB_APP_CLIENT_ID"))
	installation := strings.TrimSpace(dualenv.Value("RC_GITHUB_APP_INSTALLATION_ID"))
	if clientID != "" || installation != "" || privateKey != "" {
		installationID, parseErr := strconv.ParseInt(installation, 10, 64)
		if parseErr != nil || installationID <= 0 {
			return Config{}, errors.New("RC_GITHUB_APP_INSTALLATION_ID must be a positive integer")
		}
		config.GitHubApp = &scaleset.GitHubAppAuth{
			ClientID:       clientID,
			InstallationID: installationID,
			PrivateKey:     privateKey,
		}
		if err := config.GitHubApp.Validate(); err != nil {
			return Config{}, fmt.Errorf("invalid GitHub App credentials: %w", err)
		}
	}

	if err := config.Validate(); err != nil {
		return Config{}, err
	}
	return config, nil
}

func (c Config) Validate() error {
	if c.MachineToken != "" {
		if c.ControllerToken != "" || c.GitHubToken != "" || c.GitHubApp != nil {
			return errors.New("a Worker standby uses only RC_MACHINE_TOKEN_FILE, not controller or GitHub credentials")
		}
		if matched, _ := regexp.MatchString(`^[0-9a-fA-F]{32}$`, c.MachineToken); !matched {
			return errors.New("RC_MACHINE_TOKEN must be the Worker's 32-character hexadecimal credential")
		}
		parsed, err := url.Parse(c.ConvexURL)
		if err != nil || parsed.Scheme != "https" || parsed.Host == "" {
			return errors.New("RC_CONVEX_URL must be an absolute HTTPS URL")
		}
		if err := ProfileNameError(c.Profile); err != nil {
			return fmt.Errorf("RC_PROFILE: %w", err)
		}
		if c.RegistrationURL != "" || c.Executor != "" || c.ImageRelease != "" {
			return errors.New("a Worker standby reads its Profile from Convex; do not set local Profile or GitHub settings")
		}
		if (c.CacheFactsURL == "") != (c.CacheSigningKey == "") || (c.CacheSigningKey != "" && len(c.CacheSigningKey) < 32) {
			return errors.New("cache facts require RC_CACHE_FACTS_URL and a signing key of at least 32 bytes")
		}
		return nil
	}
	for name, value := range map[string]string{
		"RC_CONVEX_URL":        c.ConvexURL,
		"RC_CONTROLLER_TOKEN":  c.ControllerToken,
		"RC_GITHUB_CONFIG_URL": c.RegistrationURL,
		"RC_PROFILE":           c.Profile,
		"RC_EXECUTOR":          c.Executor,
		"RC_IMAGE_RELEASE":     c.ImageRelease,
		"RC_SCALE_SET_NAME":    c.ScaleSetName,
	} {
		if strings.TrimSpace(value) == "" {
			return fmt.Errorf("%s is required", name)
		}
	}
	if err := ProfileNameError(c.Profile); err != nil {
		return fmt.Errorf("RC_PROFILE: %w", err)
	}
	if err := ProfileNameError(c.ScaleSetName); err != nil {
		return fmt.Errorf("RC_SCALE_SET_NAME: %w", err)
	}
	scope, err := RegistrationScope(c.RegistrationURL)
	if err != nil {
		return err
	}
	// GitHub: "You cannot authenticate using a GitHub App for runners at the
	// enterprise level." The registration-token endpoint for an enterprise takes
	// a personal access token (classic) with manage_runners:enterprise.
	if scope == ScopeEnterprise && c.GitHubApp != nil {
		return errors.New(
			"a GitHub App cannot register enterprise runners; set RC_GITHUB_TOKEN to a personal access token (classic) with the manage_runners:enterprise scope",
		)
	}
	if c.MinRunners < 0 || c.MaxRunners < 1 || c.MinRunners > c.MaxRunners {
		return errors.New("runner bounds require 0 <= RC_MIN_RUNNERS <= RC_MAX_RUNNERS and RC_MAX_RUNNERS >= 1")
	}
	if c.Executor != "docker" && c.Executor != "firecracker" && c.Executor != "tart" && c.Executor != "hyperv" {
		return errors.New("RC_EXECUTOR must be docker, firecracker, tart, or hyperv")
	}
	if c.VCPUs < 1 || c.MemoryMiB < 512 {
		return errors.New("RC_VCPUS must be positive and RC_MEMORY_MIB must be at least 512")
	}
	if c.WarmPool < 0 || c.WarmPool > 16 || c.WarmPool > c.MaxRunners {
		return errors.New("RC_WARM_POOL must be between 0 and 16 and no greater than RC_MAX_RUNNERS")
	}
	if c.WarmPool > 0 && c.Executor != "firecracker" {
		return errors.New("RC_WARM_POOL is supported only by the firecracker executor")
	}
	if c.FitPolicy != "balanced" && c.FitPolicy != "cpu" && c.FitPolicy != "network" && c.FitPolicy != "io" {
		return errors.New("RC_FIT_POLICY must be balanced, cpu, network, or io")
	}
	if matched, _ := regexp.MatchString(`@sha256:[0-9a-f]{64}$`, c.ImageRelease); !matched {
		return errors.New("RC_IMAGE_RELEASE must be immutable and end in @sha256:<64 hex characters>")
	}
	if c.GitHubApp == nil && c.GitHubToken == "" {
		return errors.New("GitHub App credentials or RC_GITHUB_TOKEN is required")
	}
	if c.GitHubApp != nil && c.GitHubToken != "" {
		return errors.New("configure GitHub App credentials or RC_GITHUB_TOKEN, not both")
	}
	// The cache is optional, but half of it is a misconfiguration: a URL with no
	// key cannot sign a push, and a key with no URL has nowhere to send one.
	if (c.CacheFactsURL == "") != (c.CacheSigningKey == "") {
		return errors.New("RC_CACHE_FACTS_URL and RC_CACHE_SIGNING_KEY must be set together")
	}
	if c.CacheSigningKey != "" && len(c.CacheSigningKey) < 32 {
		return errors.New("RC_CACHE_SIGNING_KEY must be at least 32 bytes")
	}
	return c.Egress.validate(c.Executor)
}

// ProfileSpec is the Profile contract this controller publishes.
func (c Config) ProfileSpec() fleet.ProfileSpec {
	spec := fleet.ProfileSpec{
		Name:             c.Profile,
		ScaleSetName:     c.ScaleSetName,
		Executor:         c.Executor,
		ImageRelease:     c.ImageRelease,
		VCPUs:            c.VCPUs,
		MemoryMiB:        c.MemoryMiB,
		WarmPool:         c.WarmPool,
		FitPolicy:        c.FitPolicy,
		MinRunners:       c.MinRunners,
		MaxRunners:       c.MaxRunners,
		RegistrationURL:  c.RegistrationURL,
		GitHubCacheFacts: c.CacheFactsURL != "",
		RunnerGroup:      c.RunnerGroup,
		Labels:           c.Labels,
	}
	if c.Egress.Published() {
		spec.Egress = &fleet.ProfileEgress{
			Mode:    c.Egress.Mode,
			Presets: c.Egress.Presets,
			Domains: c.Egress.Domains,
			CIDRs:   c.Egress.CIDRs,
		}
	}
	return spec
}

// parseEgress splits RC_EGRESS_ALLOW by what each entry is: an IPv4 address or
// CIDR is a CIDR, anything else is a domain. Presets are their own variable so
// that "github" is never mistaken for a one-label domain.
func parseEgress(mode, presets, allow string) Egress {
	egress := Egress{Mode: strings.ToLower(strings.TrimSpace(mode))}
	for _, preset := range strings.Split(presets, ",") {
		if value := strings.ToLower(strings.TrimSpace(preset)); value != "" {
			egress.Presets = append(egress.Presets, value)
		}
	}
	for _, entry := range strings.Split(allow, ",") {
		value := strings.TrimSpace(entry)
		if value == "" {
			continue
		}
		if address, err := netip.ParseAddr(value); err == nil {
			egress.CIDRs = append(egress.CIDRs, netip.PrefixFrom(address, address.BitLen()).String())
			continue
		}
		if prefix, err := netip.ParsePrefix(value); err == nil {
			egress.CIDRs = append(egress.CIDRs, prefix.Masked().String())
			continue
		}
		egress.Domains = append(egress.Domains, strings.TrimSuffix(strings.ToLower(value), "."))
	}
	if egress.Published() && egress.Mode == "" {
		// A list without a mode is almost certainly an allowlist someone forgot
		// to switch on. Refusing it is safer than guessing either way.
		egress.Mode = "unset"
	}
	return egress
}

func (e Egress) validate(executor string) error {
	if !e.Published() {
		return nil
	}
	switch e.Mode {
	case "public":
		if len(e.Presets)+len(e.Domains)+len(e.CIDRs) > 0 {
			return errors.New("RC_EGRESS_MODE=public takes no RC_EGRESS_ALLOW or RC_EGRESS_PRESETS; use audit or allowlist")
		}
	case "audit", "allowlist":
	case "unset":
		return errors.New("RC_EGRESS_ALLOW and RC_EGRESS_PRESETS need RC_EGRESS_MODE=audit or allowlist")
	default:
		return errors.New("RC_EGRESS_MODE must be public, audit, or allowlist")
	}
	// Only the Firecracker runtime renders and verifies a per-guest egress
	// policy. Publishing one for another executor would advertise a boundary
	// no Worker enforces.
	if e.Mode != "public" && executor != "firecracker" {
		return fmt.Errorf("RC_EGRESS_MODE=%s is enforced only by the firecracker executor", e.Mode)
	}
	for _, preset := range e.Presets {
		if preset != "github" {
			return fmt.Errorf("RC_EGRESS_PRESETS: unknown preset %q; the only preset is github", preset)
		}
	}
	for _, cidr := range e.CIDRs {
		if prefix, err := netip.ParsePrefix(cidr); err != nil || !prefix.Addr().Is4() {
			return fmt.Errorf("RC_EGRESS_ALLOW: %q must be an IPv4 address or CIDR; guests have no IPv6 egress", cidr)
		}
	}
	for _, domain := range e.Domains {
		if !strings.Contains(strings.TrimPrefix(domain, "*."), ".") || strings.ContainsAny(domain, " /:") {
			return fmt.Errorf("RC_EGRESS_ALLOW: %q is neither an IPv4 CIDR nor a domain with at least two labels", domain)
		}
	}
	if e.Mode == "allowlist" && len(e.Presets)+len(e.Domains)+len(e.CIDRs) == 0 {
		return errors.New("RC_EGRESS_MODE=allowlist with nothing allowed denies GitHub itself; set RC_EGRESS_PRESETS=github")
	}
	return nil
}

// Scope is the level a scale set is registered at, read from
// RC_GITHUB_CONFIG_URL. It decides which GitHub permission the controller's
// credential needs (README, "GitHub permissions the controller needs").
type Scope string

const (
	ScopeRepository   Scope = "repository"
	ScopeOrganization Scope = "organization"
	ScopeEnterprise   Scope = "enterprise"
)

// RegistrationScope classifies a GitHub config URL by the same path rules the
// scale-set client applies (github.com/actions/scaleset, config.go): one path
// segment is an organization, `enterprises/<slug>` is an enterprise, and any
// other two segments are a repository. That client does not check the scheme,
// host, query or depth, so a URL it would misread is refused here, at startup,
// rather than at the first registration-token call.
func RegistrationScope(raw string) (Scope, error) {
	invalid := func(reason string) error {
		return fmt.Errorf(
			"RC_GITHUB_CONFIG_URL %q %s; use https://<host>/<owner>/<repository>, https://<host>/<organization>, or https://<host>/enterprises/<enterprise>",
			raw, reason,
		)
	}
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return "", invalid("is not a URL")
	}
	if parsed.Scheme != "https" && parsed.Scheme != "http" {
		return "", invalid("needs an https:// scheme")
	}
	if parsed.Host == "" {
		return "", invalid("has no host")
	}
	if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", invalid("must not carry credentials, a query or a fragment")
	}
	path := strings.Trim(parsed.Path, "/")
	if path == "" {
		return "", invalid("names no repository, organization or enterprise")
	}
	segments := strings.Split(path, "/")
	switch {
	case len(segments) == 1:
		return ScopeOrganization, nil
	case len(segments) == 2 && strings.EqualFold(segments[0], "enterprises"):
		return ScopeEnterprise, nil
	case len(segments) == 2:
		return ScopeRepository, nil
	default:
		return "", invalid("has too many path segments")
	}
}

func readSecret(valueEnv, fileEnv string) (string, error) {
	value := dualenv.Value(valueEnv)
	filename := strings.TrimSpace(dualenv.Value(fileEnv))
	if value != "" && filename != "" {
		return "", fmt.Errorf("configure %s or %s, not both", valueEnv, fileEnv)
	}
	if filename == "" {
		return strings.TrimSpace(value), nil
	}
	contents, err := os.ReadFile(filename)
	if err != nil {
		return "", fmt.Errorf("read %s: %w", fileEnv, err)
	}
	return strings.TrimSpace(string(contents)), nil
}
