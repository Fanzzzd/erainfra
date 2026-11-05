package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// upstream is everything the bump reads from the network. Tests replace it
// with fixtures, so no test touches the public network.
type upstream interface {
	// get returns the body of a 200 response to a GET of url.
	get(ctx context.Context, url string) ([]byte, error)
	// imageDigest returns the manifest digest (sha256:<hex>) a registry
	// serves for repository:tag. For a multi-platform image that is the
	// index digest, which is what a pull by digest needs.
	imageDigest(ctx context.Context, registry, repository, tag string) (string, error)
}

// maxBody bounds every download. The largest thing fetched is a GitHub source
// tarball of an action, a few MiB.
const maxBody = 256 << 20

type httpUpstream struct {
	client      *http.Client
	githubToken string
}

func newHTTPUpstream(githubToken string) *httpUpstream {
	return &httpUpstream{client: &http.Client{Timeout: 2 * time.Minute}, githubToken: githubToken}
}

func (h *httpUpstream) get(ctx context.Context, rawURL string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "erainfra-pinbump")
	if u, err := url.Parse(rawURL); err == nil && u.Host == "api.github.com" {
		req.Header.Set("Accept", "application/vnd.github+json")
		req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
		// Only api.github.com sees the token. net/http drops Authorization on
		// a redirect to another host, so a tarball redirected to codeload does
		// not carry it either.
		if h.githubToken != "" {
			req.Header.Set("Authorization", "Bearer "+h.githubToken)
		}
	}
	resp, err := h.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GET %s: %s", rawURL, resp.Status)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBody+1))
	if err != nil {
		return nil, fmt.Errorf("GET %s: %w", rawURL, err)
	}
	if len(body) > maxBody {
		return nil, fmt.Errorf("GET %s: body larger than %d bytes", rawURL, maxBody)
	}
	return body, nil
}

// registries maps the registries this repository pins images from to the
// host that serves /v2/ and the anonymous token endpoint for a pull scope.
var registries = map[string]struct{ api, token string }{
	"ghcr.io":   {api: "https://ghcr.io", token: "https://ghcr.io/token?service=ghcr.io&scope=repository:%s:pull"},
	"docker.io": {api: "https://registry-1.docker.io", token: "https://auth.docker.io/token?service=registry.docker.io&scope=repository:%s:pull"},
}

var digestPattern = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

func (h *httpUpstream) imageDigest(ctx context.Context, registry, repository, tag string) (string, error) {
	reg, ok := registries[registry]
	if !ok {
		return "", fmt.Errorf("no registry endpoint known for %s", registry)
	}
	raw, err := h.get(ctx, fmt.Sprintf(reg.token, repository))
	if err != nil {
		return "", err
	}
	var token struct {
		Token       string `json:"token"`
		AccessToken string `json:"access_token"`
	}
	if err := json.Unmarshal(raw, &token); err != nil {
		return "", fmt.Errorf("%s token: %w", registry, err)
	}
	bearer := token.Token
	if bearer == "" {
		bearer = token.AccessToken
	}
	// HEAD, not GET: Docker Hub does not count a HEAD against the anonymous
	// pull rate limit, and the digest header is all this needs.
	req, err := http.NewRequestWithContext(ctx, http.MethodHead,
		fmt.Sprintf("%s/v2/%s/manifests/%s", reg.api, repository, tag), nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+bearer)
	req.Header.Set("Accept", strings.Join([]string{
		"application/vnd.oci.image.index.v1+json",
		"application/vnd.docker.distribution.manifest.list.v2+json",
		"application/vnd.oci.image.manifest.v1+json",
		"application/vnd.docker.distribution.manifest.v2+json",
	}, ", "))
	resp, err := h.client.Do(req)
	if err != nil {
		return "", err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("HEAD %s/%s:%s: %s", registry, repository, tag, resp.Status)
	}
	digest := resp.Header.Get("Docker-Content-Digest")
	if !digestPattern.MatchString(digest) {
		return "", fmt.Errorf("%s/%s:%s: registry returned digest %q", registry, repository, tag, digest)
	}
	return digest, nil
}

// nodeKeyringURL is the keyring of Node.js's active releasers, published in a
// repository on GitHub rather than on nodejs.org. Checking SHASUMS256.txt
// against it means a tampered nodejs.org alone cannot hand the bump a checksum.
const nodeKeyringURL = "https://raw.githubusercontent.com/nodejs/release-keys/HEAD/gpg-only-active-keys/pubring.kbx"

// gpgvVerifier checks a detached signature with gpgv against a keyring file
// it downloads once per run. gpgv, unlike gpg, trusts exactly the keyring it is
// handed and nothing in a user's home directory.
type gpgvVerifier struct {
	up      upstream
	keyring string // path; downloaded on first use when empty
	scratch string
}

func (g *gpgvVerifier) verify(ctx context.Context, data, signature []byte) error {
	if g.scratch == "" {
		dir, err := os.MkdirTemp("", "pinbump-gpgv-")
		if err != nil {
			return err
		}
		g.scratch = dir
	}
	if g.keyring == "" {
		raw, err := g.up.get(ctx, nodeKeyringURL)
		if err != nil {
			return fmt.Errorf("fetching the Node.js release keyring: %w", err)
		}
		path := filepath.Join(g.scratch, "node-release-keys.kbx")
		if err := os.WriteFile(path, raw, 0o600); err != nil {
			return err
		}
		g.keyring = path
	}
	dataPath := filepath.Join(g.scratch, "SHASUMS256.txt")
	sigPath := dataPath + ".sig"
	if err := os.WriteFile(dataPath, data, 0o600); err != nil {
		return err
	}
	if err := os.WriteFile(sigPath, signature, 0o600); err != nil {
		return err
	}
	out, err := exec.CommandContext(ctx, "gpgv", "--keyring", g.keyring, sigPath, dataPath).CombinedOutput()
	if err != nil {
		return fmt.Errorf("gpgv rejected SHASUMS256.txt: %w\n%s", err, out)
	}
	return nil
}

func (g *gpgvVerifier) close() {
	if g.scratch != "" {
		_ = os.RemoveAll(g.scratch)
	}
}

func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}
