// Package guestdocker is what runner-center-guest does to the guest's own
// Docker so that containers a job starts can use the two host-side caches:
//
//   - the registry pull-through mirror, written as registry-mirrors into
//     dockerd's daemon.json and as a docker.io mirror into the default
//     BuildKit configuration buildx gives every builder it creates;
//   - the job cache interceptor, reached from a container only when the
//     container has been verified to trust the interceptor's per-guest CA, by
//     pinning the cache host in that container's own hosts file (Watcher).
//
// Every piece fails open. A mirror dockerd cannot reach is skipped and dockerd
// falls back to Docker Hub; a container that does not trust the CA is never
// pointed at the interceptor and keeps reaching GitHub directly.
package guestdocker

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/Fanzzzd/erainfra/apps/runtime/internal/registrymirror"
)

// RenderDaemonJSON returns dockerd's daemon.json with registry-mirrors set to
// exactly the one mirror, keeping every other key the file already had.
//
// dockerd tries a mirror first and falls back to Docker Hub when the mirror
// fails: LookupPullEndpoints in moby's daemon/pkg/registry lists the mirrors
// ahead of the official registry, and continueOnError in
// daemon/internal/distribution/errors.go treats any error from a mirror
// endpoint as one to continue past. registry-mirrors is also one of the
// options dockerd reloads on SIGHUP, which is why the guest can apply it to a
// daemon that started before the Attempt was claimed.
func RenderDaemonJSON(existing []byte, mirrorURL string) ([]byte, error) {
	if err := registrymirror.Validate(mirrorURL); err != nil {
		return nil, err
	}
	config := map[string]json.RawMessage{}
	if len(bytes.TrimSpace(existing)) > 0 {
		if err := json.Unmarshal(existing, &config); err != nil {
			// Never overwrite a file we cannot read: it may hold settings the
			// image or an operator relies on, and dockerd would refuse it too.
			return nil, fmt.Errorf("existing daemon.json is not a JSON object: %w", err)
		}
		if config == nil {
			return nil, errors.New("existing daemon.json is null, not a JSON object")
		}
	}
	mirrors, err := json.Marshal([]string{registrymirror.Canonical(mirrorURL)})
	if err != nil {
		return nil, err
	}
	config["registry-mirrors"] = mirrors
	out, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(out, '\n'), nil
}

// BuildkitdConfig is what the guest knows when it writes the default BuildKit
// configuration for the runner user.
type BuildkitdConfig struct {
	// MirrorURL is the registry mirror, or empty.
	MirrorURL string
	// CacheHost and CacheCAPath name the cache interceptor's host and the CA
	// file on the guest, or are both empty when there is no interceptor.
	CacheHost   string
	CacheCAPath string
}

// RenderBuildkitdConfig returns the buildkitd.default.toml buildx loads for
// every builder it creates without an explicit --config (docker buildx create
// reference: $BUILDX_CONFIG, $DOCKER_CONFIG/buildx, ~/.docker/buildx). The
// second return is false when there is nothing to configure, in which case no
// file should exist at all.
//
// The mirror goes under [registry."docker.io"]. BuildKit resolves through
// containerd's docker resolver, which tries each host in order and moves to the
// next on any error ("trying next host" in core/remotes/docker/resolver.go), so
// a dead mirror falls back to Docker Hub here too.
//
// The CA is listed as a registry CA for the cache host. Nothing ever pulls from
// that host; the entry is there because it is the one way to get a file into a
// docker-container builder without a workflow change: buildx copies every
// registry CA into the builder at /etc/buildkit/certs/<host>/<basename>
// (LoadConfigFiles in buildx's util/confutil/container.go). BuildKit's type=gha
// client does not read registry CAs, so the copy alone changes nothing; a
// workflow opts its builder in by pointing SSL_CERT_DIR at that directory, and
// only then does the Watcher pin the cache host inside the builder.
func RenderBuildkitdConfig(c BuildkitdConfig) ([]byte, bool, error) {
	if (c.CacheHost == "") != (c.CacheCAPath == "") {
		return nil, false, errors.New("cache host and CA path are set together or not at all")
	}
	if c.MirrorURL == "" && c.CacheHost == "" {
		return nil, false, nil
	}
	var b strings.Builder
	b.WriteString("# Written by runner-center-guest when this Attempt was claimed. buildx reads\n")
	b.WriteString("# this file as the default configuration of every builder it creates.\n")
	if c.MirrorURL != "" {
		if err := registrymirror.Validate(c.MirrorURL); err != nil {
			return nil, false, err
		}
		host := registrymirror.Host(c.MirrorURL)
		fmt.Fprintf(&b, "\n[registry.%s]\n  mirrors = [%s]\n", tomlString("docker.io"), tomlString(host))
		if registrymirror.Plain(c.MirrorURL) {
			fmt.Fprintf(&b, "\n[registry.%s]\n  http = true\n", tomlString(host))
		}
	}
	if c.CacheHost != "" {
		for _, value := range []string{c.CacheHost, c.CacheCAPath} {
			if strings.ContainsAny(value, "\"\\\n\r\t") {
				return nil, false, fmt.Errorf("%q cannot be written into buildkitd.toml", value)
			}
		}
		fmt.Fprintf(&b, "\n[registry.%s]\n  ca = [%s]\n", tomlString(c.CacheHost), tomlString(c.CacheCAPath))
	}
	return []byte(b.String()), true, nil
}

// tomlString quotes a value as a TOML basic string. Every value written here
// has already been refused if it carries a control character, so escaping the
// two characters that end or escape a basic string is the whole job.
func tomlString(value string) string {
	value = strings.ReplaceAll(value, `\`, `\\`)
	value = strings.ReplaceAll(value, `"`, `\"`)
	return `"` + value + `"`
}
