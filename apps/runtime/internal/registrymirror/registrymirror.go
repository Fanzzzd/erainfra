// Package registrymirror holds the one rule every holder of a registry mirror
// URL applies to it: the runtime that reads it from RC_REGISTRY_MIRROR_URL, the
// Attempt spec that carries it, and the guest that reads it back out of MMDS
// and writes it into dockerd's daemon.json and BuildKit's configuration.
//
// The rule is dockerd's own, made stricter where a looser value would fail
// later and somewhere harder to see. dockerd validates registry-mirrors when it
// loads daemon.json, and a value it rejects does not fail a reload quietly: it
// stops the daemon from starting after the next restart. So a value is checked
// here, before it can reach that file.
package registrymirror

import (
	"errors"
	"net/url"
	"strings"
)

// Validate accepts an absolute http or https URL that names a host and nothing
// else: no user information, no query, no fragment and no path beyond "/".
//
// dockerd itself (ValidateMirror in moby's daemon/pkg/registry/config.go)
// rejects a missing or non-http(s) scheme, a query, a fragment and user
// information. A path is legal to dockerd but not to every consumer: BuildKit's
// mirrors list takes a bare host, so a path would mean two different mirrors to
// the two clients this one value configures.
func Validate(raw string) error {
	if raw == "" {
		return errors.New("registry mirror URL is empty")
	}
	for _, r := range raw {
		if r <= ' ' || r == 0x7f {
			return errors.New("registry mirror URL must not contain whitespace or control characters")
		}
	}
	scheme, _, ok := strings.Cut(raw, "://")
	if !ok || (scheme != "http" && scheme != "https") {
		return errors.New("registry mirror URL must start with http:// or https://")
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return errors.New("registry mirror URL does not parse")
	}
	switch {
	case parsed.Host == "" || parsed.Hostname() == "":
		return errors.New("registry mirror URL must name a host")
	case parsed.User != nil:
		return errors.New("registry mirror URL must not carry credentials: a mirror serves public images to every job")
	case parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "":
		return errors.New("registry mirror URL must not carry a query or fragment")
	case parsed.Path != "" && parsed.Path != "/":
		return errors.New("registry mirror URL must not carry a path")
	}
	return nil
}

// Host returns the host[:port] BuildKit's mirrors list names the mirror by.
// It assumes raw passed Validate.
func Host(raw string) string {
	parsed, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	return parsed.Host
}

// Plain reports whether the mirror speaks plain HTTP, which BuildKit has to be
// told per host. It assumes raw passed Validate.
func Plain(raw string) bool { return strings.HasPrefix(raw, "http://") }

// Canonical returns the URL in the form dockerd stores it: one trailing slash.
// Writing that form means a reload that compares old and new mirrors sees the
// same string the daemon already holds.
func Canonical(raw string) string { return strings.TrimSuffix(raw, "/") + "/" }
