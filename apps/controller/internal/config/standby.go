package config

import (
	"errors"

	"github.com/Fanzzzd/erainfra/apps/controller/internal/fleet"
	"github.com/actions/scaleset"
)

func (c Config) Credential() string {
	if c.MachineToken != "" {
		return c.MachineToken
	}
	return c.ControllerToken
}

// WithProfile loads the complete serving contract from Convex. A standby never
// publishes it back: an old env file must not overwrite an operator's changes.
func (c Config) WithProfile(spec *fleet.ProfileSpec) (Config, error) {
	if spec == nil || spec.Name != c.Profile {
		return Config{}, errors.New("lease response has no matching Profile settings; register it once from a dedicated controller")
	}
	// Convex refuses the lease to a standby that cannot publish a Profile's cache
	// facts; this is the same rule, kept for a backend that predates the check.
	if spec.GitHubCacheFacts && (c.CacheFactsURL == "" || c.CacheSigningKey == "") {
		return Config{}, errors.New("this Profile publishes cache facts; configure ERAINFRA_CACHE_FACTS_URL (or RC_CACHE_FACTS_URL) and the cache signing key on this standby")
	}
	c.RegistrationURL = spec.RegistrationURL
	c.ScaleSetName = spec.ScaleSetName
	c.RunnerGroup = spec.RunnerGroup
	if c.RunnerGroup == "" {
		c.RunnerGroup = scaleset.DefaultRunnerGroup
	}
	c.Labels = spec.Labels
	if len(c.Labels) == 0 {
		c.Labels = []string{c.Profile}
	}
	c.WorkerLabels = spec.WorkerLabels
	c.Executor, c.ImageRelease = spec.Executor, spec.ImageRelease
	c.VCPUs, c.MemoryMiB = spec.VCPUs, spec.MemoryMiB
	c.WarmPool, c.FitPolicy = spec.WarmPool, spec.FitPolicy
	c.MinRunners, c.MaxRunners = spec.MinRunners, spec.MaxRunners
	c.Egress = Egress{}
	if spec.Egress != nil {
		c.Egress = Egress{Mode: spec.Egress.Mode, Presets: spec.Egress.Presets, Domains: spec.Egress.Domains, CIDRs: spec.Egress.CIDRs}
	}
	// Reuse full contract validation without pretending that the Worker has a
	// controller token or a static GitHub credential. The serving client receives
	// the short-lived token separately, after this validated registration URL.
	check := c
	check.MachineToken = ""
	check.ControllerToken = "validated-machine-credential"
	check.GitHubToken = "installation-token-from-convex"
	check.GitHubApp = nil
	if err := check.Validate(); err != nil {
		return Config{}, err
	}
	return c, nil
}
