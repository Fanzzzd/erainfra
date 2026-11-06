package agent

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// The build steps of the deploy pipeline when Convex coordinates it (connect-convex mode). They
// reuse the Hub path's source confinement (contextDir, readConfined via specFromCheckout) and its
// spec file search, and differ from it in three ways:
//
//   - no Hub serves image.sh, so the build runs `docker build` (or a Nixpacks binary the operator
//     installed on the Node) directly rather than piping a downloaded script into sh;
//   - an upload is fetched from a Convex file-storage URL, a capability URL that carries no
//     credential, so the Node's own credential is never sent with it;
//   - a repository is fetched at the exact pushed commit, with the read-only GitHub token passed
//     to git in the child's environment as an HTTP header, never in argv or in .git/config.

// ConvexSource is where a build step's source comes from, as the claimed command payload names it.
type ConvexSource struct {
	Kind  string `json:"kind"` // "upload" or "git"
	URL   string `json:"url"`
	Repo  string `json:"repo"`
	Ref   string `json:"ref"`
	Sha   string `json:"sha"`
	Token string `json:"token"`
}

// MaxUploadBytes matches the control plane's upload limit (pipeline.MAX_UPLOAD_BYTES).
const MaxUploadBytes = 256 << 20

var (
	repoPattern  = regexp.MustCompile(`^[\w.-]+/[\w.-]+$`)
	refPattern   = regexp.MustCompile(`^[A-Za-z0-9._/][A-Za-z0-9._/-]{0,254}$`)
	shaPattern   = regexp.MustCompile(`^[0-9a-f]{40}$`)
	imagePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,511}$`)
)

// ValidateImageRef applies the control plane's image reference rule at the execution boundary.
func ValidateImageRef(image string) error {
	if !imagePattern.MatchString(image) || strings.HasPrefix(image, "-") {
		return errors.New("invalid image reference")
	}
	return nil
}

// ConvexBuilder holds what the build steps need beyond the container CLI. The zero value is the
// production configuration.
type ConvexBuilder struct {
	// GitBase replaces https://github.com/ in tests, which serve a repository from disk.
	GitBase string
	// AllowLoopbackHTTP admits a plain-HTTP upload URL on 127.0.0.1, for tests only.
	AllowLoopbackHTTP bool
	// Nixpacks is the Nixpacks binary for a context with no Dockerfile; empty looks it up on PATH.
	Nixpacks string
	// RegistryProbeTimeout bounds the reachability check before a build; zero means 10 seconds.
	RegistryProbeTimeout time.Duration
}

func (b ConvexBuilder) checkout(ctx context.Context, r ShellRunner, dir string, src ConvexSource) error {
	switch src.Kind {
	case "upload":
		return b.fetchUpload(ctx, r, dir, src.URL)
	case "git":
		return b.fetchRepository(ctx, r, dir, src)
	default:
		return errors.New("unknown source kind")
	}
}

func (b ConvexBuilder) fetchUpload(ctx context.Context, r ShellRunner, dir, raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || u.Host == "" {
		return errors.New("invalid upload URL")
	}
	loopback := false
	if ip := net.ParseIP(u.Hostname()); ip != nil && ip.IsLoopback() {
		loopback = true
	}
	if u.Scheme != "https" && (u.Scheme != "http" || !loopback || !b.AllowLoopbackHTTP) {
		return errors.New("upload URL must be HTTPS")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return errors.New("invalid upload URL")
	}
	client := &http.Client{Timeout: 10 * time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		// The URL is a capability; neither it nor an error quoting it leaves this function.
		return errors.New("upload download failed")
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("upload download failed: status %d", resp.StatusCode)
	}
	archive := filepath.Join(dir, "source.tgz")
	f, err := os.OpenFile(archive, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	n, err := io.Copy(f, io.LimitReader(resp.Body, MaxUploadBytes+1))
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return errors.New("upload download failed")
	}
	if n > MaxUploadBytes {
		return errors.New("upload is larger than the limit")
	}
	tree := filepath.Join(dir, "src")
	if err := os.Mkdir(tree, 0o700); err != nil {
		return err
	}
	// tar refuses absolute and ..-escaping member names by default; --no-same-owner keeps a root
	// agent from restoring the archive's owners.
	if out, err := r.combinedOutput(exec.CommandContext(ctx, "tar", "-xzf", archive, "-C", tree, "--no-same-owner")); err != nil {
		return fmt.Errorf("extract upload: %w: %s", err, firstLine(out))
	}
	return os.Remove(archive)
}

func (b ConvexBuilder) fetchRepository(ctx context.Context, r ShellRunner, dir string, src ConvexSource) error {
	if !repoPattern.MatchString(src.Repo) || !refPattern.MatchString(src.Ref) || strings.Contains(src.Ref, "..") {
		return errors.New("invalid repository or branch")
	}
	if src.Sha != "" && !shaPattern.MatchString(src.Sha) {
		return errors.New("invalid commit id")
	}
	base := b.GitBase
	if base == "" {
		base = "https://github.com/"
	}
	remote := base + src.Repo + ".git"
	want := "refs/heads/" + src.Ref
	if src.Sha != "" {
		// The pushed commit, not whatever the branch points at by the time this runs, so every step
		// of one run builds the same tree.
		want = src.Sha
	}
	tree := filepath.Join(dir, "src")
	env := append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "GIT_CONFIG_NOSYSTEM=1")
	if src.Token != "" {
		basic := base64.StdEncoding.EncodeToString([]byte("x-access-token:" + src.Token))
		env = append(env, "GIT_CONFIG_COUNT=1", "GIT_CONFIG_KEY_0=http.extraHeader", "GIT_CONFIG_VALUE_0=Authorization: Basic "+basic)
	}
	for _, step := range []struct {
		name string
		argv []string
	}{
		{"init", []string{"init", "-q", tree}},
		{"fetch", []string{"-C", tree, "fetch", "-q", "--depth", "1", "--no-tags", remote, want}},
		{"checkout", []string{"-C", tree, "checkout", "-q", "--detach", "FETCH_HEAD"}},
	} {
		cmd := exec.CommandContext(ctx, "git", step.argv...)
		cmd.Env = env
		if out, err := r.combinedOutput(cmd); err != nil {
			return fmt.Errorf("git %s: %w: %s", step.name, err, scrub(firstLine(out), src.Token))
		}
	}
	return nil
}

func firstLine(out []byte) string {
	line, _, _ := strings.Cut(strings.TrimSpace(string(out)), "\n")
	if len(line) > 300 {
		line = line[:300]
	}
	return line
}

// ReadConvexSpec fetches a source and returns its spec file ("" when it has none), for the
// pipeline's spec step. It has no effect on the Node beyond a temporary directory.
func (b ConvexBuilder) ReadConvexSpec(ctx context.Context, r ShellRunner, src ConvexSource) (string, error) {
	dir, err := os.MkdirTemp("", "erainfra-spec-")
	if err != nil {
		return "", err
	}
	defer removeSecretPath(dir)
	if err := b.checkout(ctx, r, dir, src); err != nil {
		return "", err
	}
	return specFromCheckout(filepath.Join(dir, "src")), nil
}

// BuildConvexImage fetches a source, builds the context directory `sub` into `image`, and pushes
// it. Dockerfile first; with none, a Nixpacks binary already on the Node.
func (b ConvexBuilder) BuildConvexImage(ctx context.Context, r ShellRunner, src ConvexSource, sub, image string) (string, error) {
	if err := ValidateImageRef(image); err != nil {
		return "", err
	}
	dir, err := os.MkdirTemp("", "erainfra-build-")
	if err != nil {
		return "", err
	}
	defer removeSecretPath(dir)
	if err := b.checkout(ctx, r, dir, src); err != nil {
		return "", err
	}
	buildDir, err := contextDir(filepath.Join(dir, "src"), sub)
	if err != nil {
		return "", err
	}
	var out strings.Builder
	var build *exec.Cmd
	if info, err := os.Lstat(filepath.Join(buildDir, "Dockerfile")); err == nil && info.Mode().IsRegular() {
		build = exec.CommandContext(ctx, r.cli(), "build", "-t", image, buildDir)
	} else {
		nixpacks := b.Nixpacks
		if nixpacks == "" {
			if nixpacks, err = exec.LookPath("nixpacks"); err != nil {
				return "", errors.New("the build context has no Dockerfile and this Node has no nixpacks on PATH")
			}
		}
		build = exec.CommandContext(ctx, nixpacks, "build", buildDir, "--name", image)
	}
	// A registry that cannot be reached fails the push only after the whole build. Find out first.
	if err := b.probeRegistry(ctx, image); err != nil {
		return "", err
	}
	o, err := r.combinedOutput(build)
	out.Write(o)
	if err != nil {
		return out.String(), fmt.Errorf("build: %w", err)
	}
	o, err = r.combinedOutput(exec.CommandContext(ctx, r.cli(), "push", image))
	out.Write(o)
	if err != nil {
		return out.String(), fmt.Errorf("push: %w", err)
	}
	return out.String(), nil
}

// registryHost is the registry part of an image reference, or "" for a Docker Hub name. Docker's
// rule: the first path component names a registry when it has a dot or a colon, or is localhost.
func registryHost(image string) string {
	first, _, found := strings.Cut(image, "/")
	if !found || (!strings.ContainsAny(first, ".:") && first != "localhost") {
		return ""
	}
	return first
}

// probeRegistry checks that the registry an image is pushed to answers from this Node. A loopback
// registry (the Hub's, or one reached over an erainfra-mesh link) must answer HTTP on /v2/: a mesh
// listener accepts connections even while its far end is down, so a TCP connect proves nothing.
// Anything else is dialled on its port, or 443, which is what `docker push` would use.
func (b ConvexBuilder) probeRegistry(ctx context.Context, image string) error {
	host := registryHost(image)
	if host == "" {
		return nil
	}
	timeout := b.RegistryProbeTimeout
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	unreachable := func(err error) error {
		return fmt.Errorf("registry %s is not reachable from this Node (%v): builds push there and "+
			"Nodes pull from there. Check ERAINFRA_REGISTRY in the Convex environment and, when "+
			"ERAINFRA_REGISTRY_NODE is set, that this Node's registry mesh link is up", host, err)
	}
	name, port, err := net.SplitHostPort(host)
	if err != nil {
		name, port = host, "443"
	}
	if ip := net.ParseIP(name); (ip != nil && ip.IsLoopback()) || name == "localhost" {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+host+"/v2/", nil)
		if err != nil {
			return unreachable(err)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return unreachable(err)
		}
		_ = resp.Body.Close()
		// 200 for an open registry, 401 for one that wants a login: either way it answered.
		if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusUnauthorized {
			return unreachable(fmt.Errorf("GET /v2/ answered %d", resp.StatusCode))
		}
		return nil
	}
	conn, err := (&net.Dialer{}).DialContext(ctx, "tcp", net.JoinHostPort(name, port))
	if err != nil {
		return unreachable(err)
	}
	return conn.Close()
}
