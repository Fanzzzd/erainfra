// Package aptmirror holds the apt mirror's rule and the two guest files that
// use it. The runtime reads the mirror from RC_APT_MIRROR_URL, the Attempt spec
// and MMDS carry it as apt_mirror_url, and the guest writes it into apt's
// configuration at claim.
//
// The mirror is an apt HTTP proxy, such as apt-cacher-ng. apt sends it every
// fetch from an http:// source. Fetches from https:// sources do not use an
// http proxy, so they still go straight to their repository.
//
// apt does not fall back to a direct fetch when its proxy fails. So the guest
// does not name the proxy outright. It names a Proxy-Auto-Detect script that
// probes the mirror on every apt run and answers DIRECT when the mirror does
// not answer. A mirror that dies costs a job one 2 second probe per apt run,
// never a failed install.
package aptmirror

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// ConfPath is apt's configuration snippet that names the probe script.
const ConfPath = "/etc/apt/apt.conf.d/01erainfra-mirror"

// ScriptPath is the probe script apt runs before it fetches.
const ScriptPath = "/usr/local/libexec/erainfra-apt-proxy"

// ProbeSeconds bounds each probe, so a mirror that hangs costs little.
const ProbeSeconds = 2

// The host lands in a shell script, so it is held to hostname and IP address
// characters, not just to "no whitespace".
var hostname = regexp.MustCompile(`^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$`)

// Validate accepts http://host or http://host:port with nothing else: no
// credentials, no path beyond "/", no query and no fragment.
//
// Only http: apt-cacher-ng and its kind serve plain HTTP, and an https:// proxy
// URL would make apt tunnel the very fetches the mirror exists to cache.
func Validate(raw string) error {
	if raw == "" {
		return errors.New("apt mirror URL is empty")
	}
	for _, r := range raw {
		if r <= ' ' || r == 0x7f {
			return errors.New("apt mirror URL must not contain whitespace or control characters")
		}
	}
	if !strings.HasPrefix(raw, "http://") {
		return errors.New("apt mirror URL must start with http://: it is an apt HTTP proxy")
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return errors.New("apt mirror URL does not parse")
	}
	host := parsed.Hostname()
	switch {
	case host == "":
		return errors.New("apt mirror URL must name a host")
	case parsed.User != nil:
		return errors.New("apt mirror URL must not carry credentials: every job on the Worker reads it")
	case parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "":
		return errors.New("apt mirror URL must not carry a query or fragment")
	case parsed.Path != "" && parsed.Path != "/":
		return errors.New("apt mirror URL must not carry a path")
	case net.ParseIP(host) == nil && !hostname.MatchString(host):
		return errors.New("apt mirror URL host must be a hostname or an IP address")
	}
	if port := parsed.Port(); port != "" {
		if n, err := strconv.Atoi(port); err != nil || n < 1 || n > 65535 {
			return errors.New("apt mirror URL port must be between 1 and 65535")
		}
	}
	return nil
}

// Canonical returns the proxy URL apt is told: no trailing slash. It assumes
// raw passed Validate.
func Canonical(raw string) string { return strings.TrimSuffix(raw, "/") }

// Conf is the content of ConfPath.
func Conf() string {
	return "// Written by runner-center-guest at claim. See " + ScriptPath + ".\n" +
		"Acquire::http::Proxy-Auto-Detect \"" + ScriptPath + "\";\n"
}

// Script is the content of ScriptPath for a mirror that passed Validate. apt
// runs it with the URI it is about to fetch and uses the one line it prints:
// the proxy URL, or DIRECT.
func Script(raw string) string {
	parsed, _ := url.Parse(raw)
	host := parsed.Hostname()
	port := parsed.Port()
	if port == "" {
		port = "80"
	}
	return fmt.Sprintf(`#!/bin/bash
# Written by runner-center-guest at claim. apt runs this before it fetches from
# an http:// source. It answers the Worker's apt mirror when the mirror accepts
# a connection within %[1]d s, and DIRECT otherwise, so a dead mirror never
# fails an apt run.
if timeout %[1]d bash -c ': > /dev/tcp/%[2]s/%[3]s' 2>/dev/null; then
  echo %[4]s
else
  echo DIRECT
fi
`, ProbeSeconds, host, port, Canonical(raw))
}

// Apply writes the probe script and apt's snippet under root ("/" in a guest).
// The script goes first, so apt never reads a snippet that names a missing
// script.
func Apply(root, raw string) error {
	if err := Validate(raw); err != nil {
		return err
	}
	if err := writeFile(filepath.Join(root, ScriptPath), Script(raw), 0o755); err != nil {
		return err
	}
	return writeFile(filepath.Join(root, ConfPath), Conf(), 0o644)
}

// writeFile replaces path atomically, so a concurrent apt run reads the old
// file or the new one, never half of one.
func writeFile(path, content string, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".erainfra-*")
	if err != nil {
		return err
	}
	// After a successful rename the temporary name is gone, so this removes
	// nothing; it only cleans up after a failed write.
	defer func() { _ = os.Remove(tmp.Name()) }()
	if _, err := tmp.WriteString(content); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Chmod(mode); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}
