package agent

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"

	"github.com/Fanzzzd/erainfra/apps/infra-agent/internal/rename"
)

// Service is one container of a multi-service ("compose-like") App. The whole App shares a per-App
// docker network so services reach each other by Name (docker DNS).
type Service struct {
	Name  string            `json:"name"`  // DNS name on the App network (e.g. "web", "db")
	Image string            `json:"image"` // registry image ref
	Args  []string          `json:"args"`  // extra docker run flags (-p, -v, ...)
	Env   map[string]string `json:"env"`   // secrets → 0600 --env-file (never argv)
}

// ShellRunner shells out to the container CLI (docker/podman) and executes allowlist-resolved host
// operations. ponytail: CLI shelling is what Coolify does and needs no heavy SDK; swap to
// github.com/docker/docker/client when we need fine-grained control (events, streamed logs, inspect).
type ShellRunner struct {
	OutputLimit int // opt-in bounded capture; zero captures everything
	Docker      string
	// VolumeOwners is the directory where the Infra Agent records which App adopted each volume
	// that has no erainfra.app label (ownership.go). Empty records nothing, and then the containers
	// mounting a volume are its only evidence.
	VolumeOwners string
}

func (r ShellRunner) cli() string {
	if r.Docker != "" {
		return r.Docker
	}
	return "docker"
}

func (r ShellRunner) Execute(ctx context.Context, command Command) (string, error) {
	if command.Path == "" || len(command.Argv) == 0 || command.Argv[0] != command.Path {
		return "", fmt.Errorf("invalid resolved command")
	}
	out, err := r.combinedOutput(exec.CommandContext(ctx, command.Path, command.Argv[1:]...))
	return string(out), err
}

// DeployAppAdopting brings up a multi-service App: it ensures a per-App docker network (so services
// resolve each other by name over docker DNS), then (re)runs each service detached and attached to
// that network. Idempotent on the App and service names. Secrets arrive as a map and are written to
// a 0600 --env-file (never argv). A service that fails to run aborts and returns the output so far.
//
// It also replaces each unlabelled container named in adopt, which the ownership check would
// otherwise refuse (ownership.go, ownContainer). The operator
// names them with `erainfra deploy --adopt`. Each must be a container this deploy starts
// (`<app>-<service>`), so adopt can only take a name the deploy was going to replace anyway; a
// container labelled for another App or service is refused even when named.
func (r ShellRunner) DeployAppAdopting(ctx context.Context, app string, services []Service, adopt []string) (string, error) {
	for _, name := range adopt {
		if !slices.ContainsFunc(services, func(s Service) bool { return app+"-"+s.Name == name }) {
			return "", fmt.Errorf("adopt %s: this deploy starts no container of that name", name)
		}
	}
	for _, service := range services {
		if err := validateDockerArgs(service.Args); err != nil {
			return "", fmt.Errorf("service %s: %w", service.Name, err)
		}
	}
	d := r.cli()
	net := app + "-net"
	// Every name this App's services take must be this App's before anything is replaced, so a
	// refusal leaves the Node as it was (ownership.go).
	var mounts []string
	for _, s := range services {
		name := app + "-" + s.Name
		if err := r.ownContainer(ctx, name, app, s.Name, slices.Contains(adopt, name)); err != nil {
			return "", err
		}
		mounts = append(mounts, s.Args...) // validated flag/value pairs, so they concatenate
	}
	if err := r.ownVolumes(ctx, app, mounts, adopt); err != nil {
		return "", err
	}
	var b strings.Builder
	// Ensure the shared network. `network create` errors if it already exists — that's fine on
	// re-deploy, so only surface a failure when the network still isn't there afterwards.
	if out, err := r.combinedOutput(exec.CommandContext(ctx, d, "network", "create", net)); err != nil {
		if exec.CommandContext(ctx, d, "network", "inspect", net).Run() != nil {
			return string(out), fmt.Errorf("network %s: %w", net, err)
		}
	}
	for _, s := range services {
		name := app + "-" + s.Name
		if exec.CommandContext(ctx, d, "image", "inspect", s.Image).Run() != nil {
			if out, err := r.combinedOutput(exec.CommandContext(ctx, d, "pull", s.Image)); err != nil {
				return b.String() + string(out), fmt.Errorf("pull %s: %w", s.Name, err)
			} else {
				b.Write(out)
			}
		}
		run := []string{"run", "-d", "--name", name, "--network", net, "--network-alias", s.Name, "--restart", "unless-stopped"}
		run = append(run, ownershipLabels(app, s.Name)...)
		if len(s.Env) > 0 {
			ef, err := writeEnvFile(s.Env)
			if err != nil {
				return b.String(), fmt.Errorf("env-file %s: %w", s.Name, err)
			}
			defer removeSecretPath(ef)
			run = append(run, "--env-file", ef)
		}
		run = append(run, s.Args...)
		run = append(run, s.Image)
		_ = exec.CommandContext(ctx, d, "rm", "-f", name).Run() // replace this service's prior container
		out, err := r.combinedOutput(exec.CommandContext(ctx, d, run...))
		b.Write(out)
		if err != nil {
			return b.String(), fmt.Errorf("run %s: %w", s.Name, err)
		}
	}
	return b.String(), nil
}

// writeEnvFile writes KEY=VALUE lines to a 0600 temp file for `docker run --env-file`.
// ponytail: --env-file is line-oriented, so values can't contain newlines — fine for env vars.
func writeEnvFile(env map[string]string) (string, error) {
	f, err := os.CreateTemp("", "pl-env-")
	if err != nil {
		return "", err
	}
	if err := f.Chmod(0o600); err != nil {
		_ = f.Close() // the Chmod error is the one to report
		removeSecretPath(f.Name())
		return "", err
	}
	var b strings.Builder
	for k, v := range env {
		b.WriteString(k)
		b.WriteByte('=')
		b.WriteString(v)
		b.WriteByte('\n')
	}
	if _, err := f.WriteString(b.String()); err != nil {
		_ = f.Close() // the write error is the one to report
		removeSecretPath(f.Name())
		return "", err
	}
	return f.Name(), f.Close()
}

// removeSecretPath deletes a temp path that can hold a secret: an env file, or a checkout whose
// .git/config keeps a clone URL with a GitHub App token in it. A failure leaves that secret on disk,
// so it is logged rather than dropped.
func removeSecretPath(path string) {
	if err := os.RemoveAll(path); err != nil {
		fmt.Printf("[erainfra] could not remove %s: %v\n", path, err)
	}
}

// contextDir resolves the optional build-context subdir, confined to the source root (a spec that
// says `build: ../../etc` must not escape the checkout). The confinement has to hold against
// symlinks as well as `..`: root was just filled by fetchSource from an untrusted tarball or repo,
// so a `ctx -> /etc` entry in the checkout would otherwise pass a lexical check and still hand the
// host's /etc to the image build. So resolve both sides and decide on the resolved paths, and return
// the path that was validated — the caller then never traverses the symlink again.
func contextDir(root, sub string) (string, error) {
	// The root is resolved too: os.MkdirTemp returns a path under /var on macOS, itself a symlink to
	// /private/var, and no resolved child is ever lexically prefixed by the unresolved root.
	realRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", fmt.Errorf("source root %q: %w", root, err)
	}
	if sub == "" || sub == "." {
		return realRoot, nil
	}
	// Lexical first, so a `..` escape is still refused as one even when the path it names is absent.
	p := filepath.Clean(filepath.Join(realRoot, sub))
	if !contains(realRoot, p) {
		return "", fmt.Errorf("build dir %q escapes the source root", sub)
	}
	realDir, err := filepath.EvalSymlinks(p)
	if err != nil {
		if os.IsNotExist(err) {
			return "", fmt.Errorf("no such build dir %q in the source", sub)
		}
		return "", fmt.Errorf("build dir %q: %w", sub, err)
	}
	if !contains(realRoot, realDir) {
		return "", fmt.Errorf("build dir %q escapes the source root", sub)
	}
	return realDir, nil
}

// contains reports whether p is root itself or a path beneath it. Both must already be resolved.
func contains(root, p string) bool {
	return p == root || strings.HasPrefix(p, root+string(filepath.Separator))
}

// specFromCheckout is the candidate search, split out of ReadConvexSpec so a test can drive the
// real thing. A test that re-lists the candidates itself passes no matter what order production uses,
// which is the whole property here: read the renamed names first, but never stop reading the
// retired ones.
//
// Ordered, not exclusive (ADR 0004 stage 1). This name lives in a CUSTOMER's repository, so it is
// not ours to rewrite: every repo bound in the Hub era carries portless.yaml and must keep
// deploying byte-for-byte as it does. Reading the renamed names first costs a stat that misses.
func specFromCheckout(dir string) string {
	for _, f := range []string{"erainfra.yaml", "erainfra.yml", "portless.yaml", "portless.yml"} {
		body, err := readConfined(dir, f)
		if err != nil {
			// Absent, a directory, or pointing out of the checkout: try the next
			// name, then fall back to a single-service deploy as before.
			continue
		}
		if f == "portless.yaml" || f == "portless.yml" {
			rename.Warn(f, "erainfra"+f[len("portless"):],
				"Rename it whenever you like; both are read and will be for at least one more release.")
		}
		return string(body)
	}
	return ""
}

// readConfined reads name from root, refusing anything that resolves outside it. os.ReadFile follows
// symlinks, so without this a checkout containing `portless.yaml -> /etc/shadow` would have that
// file's contents returned to Convex as the App's spec — an arbitrary-file read on a Node, since the
// agent runs as root. Same root cause as contextDir, different call path.
func readConfined(root, name string) ([]byte, error) {
	realRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return nil, fmt.Errorf("source root %q: %w", root, err)
	}
	p, err := filepath.EvalSymlinks(filepath.Join(realRoot, name))
	if err != nil {
		return nil, err
	}
	if !contains(realRoot, p) {
		return nil, fmt.Errorf("%q escapes the source root", name)
	}
	// A symlink to a sibling in the checkout is fine and is why containment is
	// checked rather than symlinks refused outright; a directory is not a spec.
	info, err := os.Lstat(p)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("%q is not a regular file", name)
	}
	return os.ReadFile(p)
}

// scrub removes a secret-bearing URL from text (so clone errors don't leak the token).
func scrub(text, secret string) string {
	if secret == "" {
		return text
	}
	return strings.ReplaceAll(text, secret, "<redacted>")
}
