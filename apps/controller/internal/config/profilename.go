package config

import (
	"fmt"
	"regexp"
	"strings"
)

// MaxProfileNameLength is the tightest limit any tool in this space puts on a
// scale-set name: ARC's Helm chart caps runnerScaleSetName at 45 characters.
// A Profile name is the scale-set name, so it inherits the cap (ADR 0010).
const MaxProfileNameLength = 45

var (
	// Lowercase because GitHub matches self-hosted labels case-insensitively:
	// two names that differ only in case are one label.
	profileNameCharacters = regexp.MustCompile(`^[a-z][a-z0-9-]*[a-z0-9]$`)

	// The scheme from ADR 0010:
	// erainfra-[canary-]<N>vcpu-<os><version>[-arm][-<M>gb][-<flavour>].
	profileNameScheme = regexp.MustCompile(
		`^erainfra-(canary-)?[1-9][0-9]*vcpu-(ubuntu-[0-9]{4}|macos-[0-9]{2}|windows-[0-9]{4})(-arm)?(-[1-9][0-9]*gb)?(-[a-z][a-z0-9]*)?$`,
	)

	// Labels GitHub's own runners answer to. A self-hosted runner that also
	// answers to one of them makes `runs-on` ambiguous: the job may land on
	// either fleet.
	githubHostedLabel = regexp.MustCompile(
		`^(self-hosted|linux|windows|macos|x64|arm64|ubuntu-latest|windows-latest|macos-latest|ubuntu-slim|ubuntu-[0-9]{2}\.[0-9]{2}(-arm)?|windows-[0-9]{4}(-[a-z0-9]+)?|macos-[0-9]{2}(-[a-z0-9]+)?)$`,
	)
)

// ProfileNameError reports a name that cannot be a Profile at all: one GitHub
// would treat as a different or ambiguous label, or one too long for the
// scale-set tooling. It returns nil for every legal name, including legal names
// that predate ADR 0010's scheme.
func ProfileNameError(name string) error {
	switch {
	case len(name) > MaxProfileNameLength:
		return fmt.Errorf("profile name %q is %d characters; the limit is %d", name, len(name), MaxProfileNameLength)
	case !profileNameCharacters.MatchString(name) || strings.Contains(name, "--"):
		return fmt.Errorf("profile name %q must be lowercase letters, digits and single hyphens, starting with a letter and not ending in a hyphen", name)
	case githubHostedLabel.MatchString(name):
		return fmt.Errorf("profile name %q is a GitHub-hosted label; a self-hosted runner answering to it makes runs-on ambiguous", name)
	}
	return nil
}

// ProfileNameFollowsScheme reports whether a legal name also follows ADR 0010.
// A name that does not is still served, because GitHub holds the scale set of a
// Profile named before ADR 0010, but the controller says so at startup.
func ProfileNameFollowsScheme(name string) bool {
	return profileNameScheme.MatchString(name)
}
