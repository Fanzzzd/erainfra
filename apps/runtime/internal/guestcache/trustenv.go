package guestcache

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// SystemTrustBundle is the bundle update-ca-certificates rebuilds: Ubuntu's
// public roots plus every CA under /usr/local/share/ca-certificates, which is
// where the interceptor's CA is written. Pointing a client at it adds the
// interceptor's CA and removes nothing a job relied on, because the public
// roots in it are the same Mozilla set certifi and the image's OpenSSL carry.
const SystemTrustBundle = "/etc/ssl/certs/ca-certificates.crt"

// TrustEnv is what the runner's environment carries while the redirect is up,
// so the clients that would otherwise reject the interceptor's leaf trust it.
// Each variable is here because a common client reads it and has no other way
// to see the CA; anything already covered by the system store is left out,
// because every variable is one more difference from ubuntu-latest.
//
//   - NODE_EXTRA_CA_CERTS: Node ships its own roots and ignores the system
//     store. This is the client that matters most: actions/cache,
//     upload-artifact and download-artifact all run on it. It names the CA
//     alone, which Node adds to its own roots.
//   - REQUESTS_CA_BUNDLE: Python requests (and pip's vendored copy) trusts
//     certifi's bundle, not the system's.
//   - SSL_CERT_FILE: httpx reads it in place of certifi, and so does an
//     OpenSSL built with a different default path (conda, micromamba). For
//     the image's own OpenSSL and for Go it names the file they already read,
//     so it changes nothing there.
//
// Left out, each for a reason: CURL_CA_BUNDLE (the image's curl already reads
// the system bundle, and requests prefers REQUESTS_CA_BUNDLE), SSL_CERT_DIR
// (OpenSSL and Go already read /etc/ssl/certs), and anything for the JVM, which
// has no environment variable for a PEM bundle at all.
func TrustEnv(caPath string) []string {
	return []string{
		"NODE_EXTRA_CA_CERTS=" + caPath,
		"REQUESTS_CA_BUNDLE=" + SystemTrustBundle,
		"SSL_CERT_FILE=" + SystemTrustBundle,
	}
}

// trustEnvNames are the variable names TrustEnv sets, in its order.
func trustEnvNames() []string {
	env := TrustEnv("")
	names := make([]string, 0, len(env))
	for _, entry := range env {
		name, _, _ := strings.Cut(entry, "=")
		names = append(names, name)
	}
	return names
}

// sudoersDropIn is the file name under /etc/sudoers.d. It has no dot in it on
// purpose: sudo's includedir skips any name containing one, which is what
// makes the temporary name below safe to write next to it.
const sudoersDropIn = "erainfra-cache"

// SudoersContent keeps the trust variables across sudo. Ubuntu's sudo resets
// the environment, so `sudo node script.js` or `sudo pip install` would lose
// them and fail TLS to the cache host as root. env_keep only carries a value
// the caller already has, so it hands root exactly what the runner holds and
// sets nothing on its own.
func SudoersContent() []byte {
	return []byte("# Written by runner-center-guest while the job cache redirect is installed (ADR 0012).\n" +
		"Defaults env_keep += \"" + strings.Join(trustEnvNames(), " ") + "\"\n")
}

// InstallSudoersDropIn writes SudoersContent into dir, checked by validate
// (visudo -cf in a guest) before sudo can read it, and returns the func that
// removes it. A file that fails validation never takes the drop-in's name, so
// a bad write cannot lock the runner out of sudo.
func InstallSudoersDropIn(ctx context.Context, dir string, validate func(ctx context.Context, path string) error) (func(), error) {
	if validate == nil {
		return nil, errors.New("guestcache: a sudoers validator is required")
	}
	final := filepath.Join(dir, sudoersDropIn)
	staged := final + ".tmp"
	if err := os.WriteFile(staged, SudoersContent(), 0o440); err != nil {
		return nil, fmt.Errorf("write %s: %w", staged, err)
	}
	// WriteFile keeps an existing file's mode, and sudo refuses a drop-in
	// that is group- or world-writable.
	if err := os.Chmod(staged, 0o440); err != nil {
		_ = os.Remove(staged)
		return nil, fmt.Errorf("chmod %s: %w", staged, err)
	}
	if err := validate(ctx, staged); err != nil {
		_ = os.Remove(staged)
		return nil, fmt.Errorf("validate sudoers drop-in: %w", err)
	}
	if err := os.Rename(staged, final); err != nil {
		_ = os.Remove(staged)
		return nil, fmt.Errorf("install %s: %w", final, err)
	}
	return func() { _ = os.Remove(final) }, nil
}
