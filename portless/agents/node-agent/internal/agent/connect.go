package agent

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// The agent dials OUT to the hub over WSS and stays connected; the hub pushes commands and the agent
// replies. This is the self-controlled control channel (no dumbpipe, no third-party relay) — it
// rides the hub's Cloudflare tunnel. No inbound port is ever opened on this box.

// Runner executes the hub's commands locally. Pluggable so the container backend can be swapped
// (docker CLI now, like Coolify; the Docker Go SDK later for typed lifecycle/events) and so tests
// can use a fake.
type Runner interface {
	Deploy(image, name string, args []string, env map[string]string, port int) (string, error)
	DeployApp(app string, services []Service) (string, error)
	MeshShare(name string, port int) (string, error)                // expose a local port on the mesh → ticket
	MeshConnect(name, ticket string, localPort int) (string, error) // dial a ticket → local 127.0.0.1:localPort
	MeshDrop(name string) (string, error)                           // tear down a mesh link by name
	Serve(app string, port int) (string, error)                     // (re)register app->port for the data plane, no deploy
	Execute(command Command) (string, error)
	Build(src BuildSource, registry, tag, hubBase string) (string, error)
	ReadSpec(src BuildSource) (string, error) // fetch the source, return its portless.yaml ("" if absent)
}

// Service is one container of a multi-service ("compose-like") app. The whole app shares a per-app
// docker network so services reach each other by Name (docker DNS); a service with a Route is also
// published (its Args must include the matching -p) and gets a data-plane ingress route.
type Service struct {
	Name  string            `json:"name"`  // DNS name on the app network (e.g. "web", "db")
	Image string            `json:"image"` // registry image ref
	Args  []string          `json:"args"`  // extra docker run flags (-p, -v, ...)
	Env   map[string]string `json:"env"`   // secrets → 0600 --env-file (never argv)
	Port  int               `json:"port"`  // loopback port for the data plane (when Route is set)
	Route string            `json:"route"` // external hostname label; empty = internal-only
}

// BuildSource is either a git repo (clone a ref) or a tarball URL (download + extract). Exactly one
// of RepoURL / TarURL is set. Dir optionally selects a subdirectory of the source as the build
// context (multi-service repos build each service from its own dir).
type BuildSource struct {
	RepoURL string // git: clone url (may embed a short-lived GitHub App token)
	Ref     string // git: branch/tag
	TarURL  string // tar: hub url of the uploaded source.tgz (fetched with the agent's own token)
	Dir     string // optional build-context subdir within the source (validated: no escaping the root)
}

// ShellRunner shells out to the container CLI (docker/podman) and executes allowlist-resolved host
// operations. ponytail: CLI
// shelling is what Coolify does and needs no heavy SDK; swap to github.com/docker/docker/client when
// we need fine-grained control (events, streamed logs, inspect).
// Token is the agent's own hub token, used to fetch app.deploy-gated uploaded sources.
type ShellRunner struct {
	Docker string
	Token  string
	Reg    *Registry    // records app->port on deploy so the data plane can proxy to it (loopback)
	Mesh   *MeshManager // dumbpipe sidecars for cross-node service links
}

// MeshShare exposes a local port on the mesh and returns the ticket. MeshConnect dials a ticket and
// returns the local address it's surfaced on.
func (r ShellRunner) MeshShare(name string, port int) (string, error) {
	if r.Mesh == nil {
		return "", fmt.Errorf("mesh not enabled on this agent")
	}
	return r.Mesh.Share(name, port)
}
func (r ShellRunner) MeshConnect(name, ticket string, localPort int) (string, error) {
	if r.Mesh == nil {
		return "", fmt.Errorf("mesh not enabled on this agent")
	}
	return r.Mesh.Connect(name, ticket, localPort)
}
func (r ShellRunner) MeshDrop(name string) (string, error) {
	if r.Mesh == nil {
		return "", fmt.Errorf("mesh not enabled on this agent")
	}
	if r.Mesh.Drop(name) {
		return "dropped", nil
	}
	return "no such link", nil
}

func (r ShellRunner) cli() string {
	if r.Docker != "" {
		return r.Docker
	}
	return "docker"
}

func (r ShellRunner) Execute(command Command) (string, error) {
	if command.Path == "" || len(command.Argv) == 0 || command.Argv[0] != command.Path {
		return "", fmt.Errorf("invalid resolved command")
	}
	out, err := exec.Command(command.Path, command.Argv[1:]...).CombinedOutput()
	return string(out), err
}

// Deploy pulls the image from the registry and (re)runs it detached. Idempotent on name. Secrets
// arrive as a map and are written to a 0600 --env-file (never argv) so they don't show in `ps` or
// leak into the reply output; the file is removed after the run.
func (r ShellRunner) Deploy(image, name string, args []string, env map[string]string, port int) (string, error) {
	if err := validateDockerArgs(args); err != nil {
		return "", err
	}
	d := r.cli()
	var b strings.Builder
	// Pull only if the image isn't already present locally. This supports pre-loaded / air-gapped
	// nodes (self-hosted, no Docker Hub) and skips a needless registry round-trip on every deploy.
	if exec.Command(d, "image", "inspect", image).Run() != nil {
		if out, err := exec.Command(d, "pull", image).CombinedOutput(); err != nil {
			return string(out), fmt.Errorf("pull: %w", err)
		} else {
			b.Write(out)
		}
	}
	if len(env) > 0 {
		ef, err := writeEnvFile(env)
		if err != nil {
			return "", fmt.Errorf("env-file: %w", err)
		}
		defer os.Remove(ef)
		args = append([]string{"--env-file", ef}, args...) // before args, so a platform -e PORT still wins
	}
	_ = exec.Command(d, "rm", "-f", name).Run() // replace any prior container with this name
	runArgs := append([]string{"run", "-d", "--name", name}, args...)
	runArgs = append(runArgs, image)
	out, err := exec.Command(d, runArgs...).CombinedOutput()
	b.Write(out)
	if err != nil {
		return b.String(), fmt.Errorf("run: %w", err)
	}
	if r.Reg != nil && port > 0 {
		r.Reg.Set(name, port) // now the data plane can reverse-proxy <name>.<domain> -> 127.0.0.1:port
	}
	return b.String(), nil
}

// Serve (re)registers app -> loopback port for the data plane without touching containers. The hub
// pushes these on reconnect: an agent restart forgets the registry while its containers keep running.
func (r ShellRunner) Serve(app string, port int) (string, error) {
	if app == "" || port <= 0 {
		return "", fmt.Errorf("serve: app and port required")
	}
	if r.Reg != nil {
		r.Reg.Set(app, port)
	}
	return "registered " + app, nil
}

// DeployApp brings up a multi-service app: it ensures a per-app docker network (so services resolve
// each other by name over docker DNS), then (re)runs each service detached and attached to that
// network. Idempotent on the app+service names. Exposed services (Route set) register app->port so the
// data plane can reverse-proxy them — their Args must publish the port (e.g. -p 127.0.0.1:port:cport).
// Best-effort sequential: a service that fails to run aborts and returns the output so far.
func (r ShellRunner) DeployApp(app string, services []Service) (string, error) {
	for _, service := range services {
		if err := validateDockerArgs(service.Args); err != nil {
			return "", fmt.Errorf("service %s: %w", service.Name, err)
		}
	}
	d := r.cli()
	net := app + "-net"
	var b strings.Builder
	// Ensure the shared network. `network create` errors if it already exists — that's fine on
	// re-deploy, so only surface a failure when the network still isn't there afterwards.
	if out, err := exec.Command(d, "network", "create", net).CombinedOutput(); err != nil {
		if exec.Command(d, "network", "inspect", net).Run() != nil {
			return string(out), fmt.Errorf("network %s: %w", net, err)
		}
	}
	for _, s := range services {
		name := app + "-" + s.Name
		if exec.Command(d, "image", "inspect", s.Image).Run() != nil {
			if out, err := exec.Command(d, "pull", s.Image).CombinedOutput(); err != nil {
				return b.String() + string(out), fmt.Errorf("pull %s: %w", s.Name, err)
			} else {
				b.Write(out)
			}
		}
		run := []string{"run", "-d", "--name", name, "--network", net, "--network-alias", s.Name, "--restart", "unless-stopped"}
		if len(s.Env) > 0 {
			ef, err := writeEnvFile(s.Env)
			if err != nil {
				return b.String(), fmt.Errorf("env-file %s: %w", s.Name, err)
			}
			defer os.Remove(ef)
			run = append(run, "--env-file", ef)
		}
		run = append(run, s.Args...)
		run = append(run, s.Image)
		_ = exec.Command(d, "rm", "-f", name).Run() // replace any prior container with this name
		out, err := exec.Command(d, run...).CombinedOutput()
		b.Write(out)
		if err != nil {
			return b.String(), fmt.Errorf("run %s: %w", s.Name, err)
		}
		if r.Reg != nil && s.Port > 0 && s.Route != "" {
			r.Reg.Set(s.Route, s.Port) // data plane: <route>.<domain> -> 127.0.0.1:port
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
		f.Close()
		os.Remove(f.Name())
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
		f.Close()
		os.Remove(f.Name())
		return "", err
	}
	return f.Name(), f.Close()
}

// fetchSource materializes a BuildSource (git clone OR tarball download) into dir. Git urls may embed
// a short-lived GitHub App token; tarballs are fetched with the agent's own hub token. Neither is
// persisted, and clone errors are scrubbed of the url before they leave this box.
func (r ShellRunner) fetchSource(dir string, src BuildSource) (string, error) {
	switch {
	case src.TarURL != "":
		// Token via env (not argv) so it doesn't show in `ps`. The /builds route is app.deploy-gated.
		cmd := exec.Command("sh", "-c", fmt.Sprintf(`curl -fsSL -H "Authorization: Bearer $PL_TOK" %s | tar -xz -C %s`, shellQuote(src.TarURL), shellQuote(dir)))
		cmd.Env = append(os.Environ(), "PL_TOK="+r.Token)
		if out, err := cmd.CombinedOutput(); err != nil {
			return string(out), fmt.Errorf("fetch source: %w", err)
		}
		return "", nil
	default:
		clone := exec.Command("git", "clone", "--depth", "1", "--branch", src.Ref, src.RepoURL, dir)
		out, err := clone.CombinedOutput()
		if err != nil {
			return scrub(string(out), src.RepoURL), fmt.Errorf("clone: %w", err)
		}
		return scrub(string(out), src.RepoURL), nil
	}
}

// contextDir resolves the optional build-context subdir, confined to the source root (a spec that
// says `build: ../../etc` must not escape the checkout).
func contextDir(root, sub string) (string, error) {
	if sub == "" || sub == "." {
		return root, nil
	}
	p := filepath.Clean(filepath.Join(root, sub))
	if p != root && !strings.HasPrefix(p, root+string(filepath.Separator)) {
		return "", fmt.Errorf("build dir %q escapes the source root", sub)
	}
	return p, nil
}

// Build fetches a source into a temp dir, then builds+pushes its (sub)directory as an image, reusing
// the hub's image.sh (Dockerfile-or-nixpacks auto-detect) so there's one source of build logic.
func (r ShellRunner) Build(src BuildSource, registry, tag, hubBase string) (string, error) {
	dir, err := os.MkdirTemp("", "pl-build-")
	if err != nil {
		return "", fmt.Errorf("tempdir: %w", err)
	}
	defer os.RemoveAll(dir)
	var b strings.Builder
	out, err := r.fetchSource(dir, src)
	b.WriteString(out)
	if err != nil {
		return b.String(), err
	}
	ctx, err := contextDir(dir, src.Dir)
	if err != nil {
		return b.String(), err
	}
	// Build + push via the hub's image.sh (auto-detects Dockerfile vs nixpacks), targeting the registry.
	sh := fmt.Sprintf("curl -fsSL %s/image.sh | PORTLESS_REGISTRY=%s sh -s -- ship %s %s",
		shellQuote(hubBase), shellQuote(registry), shellQuote(ctx), shellQuote(tag))
	sout, err := exec.Command("sh", "-c", sh).CombinedOutput()
	b.Write(sout)
	if err != nil {
		return b.String(), fmt.Errorf("build: %w", err)
	}
	return b.String(), nil
}

// ReadSpec fetches the source and returns its portless.yaml (or .yml) content, "" when the repo has
// none — the hub then falls back to a single-service deploy. Kept as its own cheap command so the hub
// can plan (services, builds, placement, links) BEFORE kicking off any build.
func (r ShellRunner) ReadSpec(src BuildSource) (string, error) {
	dir, err := os.MkdirTemp("", "pl-spec-")
	if err != nil {
		return "", fmt.Errorf("tempdir: %w", err)
	}
	defer os.RemoveAll(dir)
	if out, err := r.fetchSource(dir, src); err != nil {
		return out, err
	}
	for _, f := range []string{"portless.yaml", "portless.yml"} {
		if body, err := os.ReadFile(filepath.Join(dir, f)); err == nil {
			return string(body), nil
		}
	}
	return "", nil
}

// scrub removes a secret-bearing URL from text (so clone errors don't leak the token).
func scrub(text, secret string) string {
	if secret == "" {
		return text
	}
	return strings.ReplaceAll(text, secret, "<redacted>")
}

// shellQuote single-quotes an argument for safe interpolation into `sh -c`.
func shellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

type cmdMsg struct {
	Type      string            `json:"type"`
	ID        string            `json:"id"`
	Cmd       string            `json:"cmd"`
	Operation Operation         `json:"operation"`
	Image     string            `json:"image"`
	Name      string            `json:"name"`
	Args      []string          `json:"args"`
	Env       map[string]string `json:"env"`      // deploy: secrets → 0600 --env-file (never argv)
	Port      int               `json:"port"`     // deploy: app's loopback port, recorded for the data plane
	App       string            `json:"app"`      // deployApp: app name (per-app network + container prefix)
	Services  []Service         `json:"services"` // deployApp: the services to bring up together
	Ticket    string            `json:"ticket"`   // meshConnect: the mesh ticket to dial
	RepoURL   string            `json:"repoUrl"`  // build/spec (git): git url (may embed a short-lived token)
	Ref       string            `json:"ref"`      // build/spec (git): branch/tag to clone
	TarURL    string            `json:"tarUrl"`   // build/spec (upload): hub url of the uploaded source.tgz
	Dir       string            `json:"dir"`      // build: context subdir within the source
	Registry  string            `json:"registry"` // build: where to push the image
	Tag       string            `json:"tag"`      // build: image name:tag
	HubBase   string            `json:"hubBase"`  // build: hub http base to fetch image.sh from
}

type replyMsg struct {
	Type   string `json:"type"`
	ID     string `json:"id"`
	OK     bool   `json:"ok"`
	Output string `json:"output,omitempty"`
	Error  string `json:"error,omitempty"`
}

// RunCmd dispatches one hub command to the runner and builds the reply. Pure given the runner, so
// it's unit-testable with a fake.
func RunCmd(m cmdMsg, r Runner) replyMsg {
	reply := replyMsg{Type: "reply", ID: m.ID}
	var out string
	var err error
	switch m.Cmd {
	case "ping":
		reply.OK = true
		reply.Output = "pong"
		return reply
	case "operate":
		var command Command
		command, err = Resolve(m.Operation)
		if err == nil {
			out, err = r.Execute(command)
		}
	case "deploy":
		if err = validateDockerArgs(m.Args); err == nil {
			out, err = r.Deploy(m.Image, m.Name, m.Args, m.Env, m.Port)
		}
	case "deployApp":
		for _, service := range m.Services {
			if err = validateDockerArgs(service.Args); err != nil {
				err = fmt.Errorf("service %s: %w", service.Name, err)
				break
			}
		}
		if err == nil {
			out, err = r.DeployApp(m.App, m.Services)
		}
	case "serve":
		out, err = r.Serve(m.App, m.Port)
	case "meshShare":
		out, err = r.MeshShare(m.Name, m.Port) // Name=link name, Port=local service port → reply.output is the ticket
	case "meshConnect":
		out, err = r.MeshConnect(m.Name, m.Ticket, m.Port) // Name=link name, Ticket=ticket, Port=local port
	case "meshDrop":
		out, err = r.MeshDrop(m.Name)
	case "build":
		out, err = r.Build(BuildSource{RepoURL: m.RepoURL, Ref: m.Ref, TarURL: m.TarURL, Dir: m.Dir}, m.Registry, m.Tag, m.HubBase)
	case "spec":
		out, err = r.ReadSpec(BuildSource{RepoURL: m.RepoURL, Ref: m.Ref, TarURL: m.TarURL})
	default:
		reply.OK = false
		reply.Error = "unknown cmd: " + m.Cmd
		return reply
	}
	reply.Output = out
	if err != nil {
		reply.OK = false
		reply.Error = err.Error()
	} else {
		reply.OK = true
	}
	return reply
}

// decodeCmd is the wire trust boundary. Unknown fields are rejected so retired raw execution
// fields such as argv cannot be smuggled into a command frame and silently ignored.
func decodeCmd(raw []byte) (cmdMsg, error) {
	var m cmdMsg
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&m); err != nil {
		return cmdMsg{}, fmt.Errorf("decode command: %w", err)
	}
	if err := dec.Decode(&struct{}{}); err != io.EOF {
		if err == nil {
			return cmdMsg{}, fmt.Errorf("decode command: multiple JSON values")
		}
		return cmdMsg{}, fmt.Errorf("decode command: %w", err)
	}
	return m, nil
}

// Connect dials the hub and serves commands forever, reconnecting with a fixed backoff on drop.
func Connect(hubURL, token, agentID, version string, roles []Role, runner Runner) {
	for {
		if err := connectOnce(hubURL, token, agentID, version, roles, runner); err != nil {
			fmt.Printf("[agent] disconnected: %v — retrying in 3s\n", err)
		}
		time.Sleep(3 * time.Second)
	}
}

func connectOnce(hubURL, token, agentID, version string, roles []Role, runner Runner) error {
	h := http.Header{}
	if token != "" {
		h.Set("Authorization", "Bearer "+token)
	}
	c, _, err := websocket.DefaultDialer.Dial(hubURL, h)
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	defer c.Close()
	// Writes come from two goroutines now (replies + heartbeats) — gorilla forbids concurrent writers,
	// so guard every write with a mutex and a deadline (a black-hole hub then errors instead of hanging).
	var wmu sync.Mutex
	writeJSON := func(v any) error {
		wmu.Lock()
		defer wmu.Unlock()
		_ = c.SetWriteDeadline(time.Now().Add(10 * time.Second))
		return c.WriteJSON(v)
	}
	if err := writeJSON(map[string]any{"type": "hello", "agentId": agentID, "version": version, "roles": roles}); err != nil {
		return fmt.Errorf("hello: %w", err)
	}
	fmt.Printf("[agent] connected to %s as %q\n", hubURL, agentID)
	// Heartbeat on its OWN goroutine so it keeps flowing even while a long deploy blocks the read loop —
	// the hub uses it for liveness (a silently-dead NAT mapping never closes the socket, so without this
	// the hub would think a dead agent is still present and never fail its apps over).
	done := make(chan struct{})
	defer close(done)
	go func() {
		t := time.NewTicker(15 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case <-t.C:
				if err := writeJSON(map[string]any{"type": "heartbeat"}); err != nil {
					c.Close() // dead hub → unblock the read loop → reconnect
					return
				}
			}
		}
	}()
	// ponytail: commands still run synchronously (one at a time) — fine for a single-box agent; only the
	// heartbeat is concurrent. Spawn goroutines per command if concurrent execution is ever needed.
	for {
		_, raw, err := c.ReadMessage()
		if err != nil {
			return fmt.Errorf("read: %w", err)
		}
		m, err := decodeCmd(raw)
		if err != nil {
			return err
		}
		if m.Type != "cmd" {
			continue
		}
		if err := writeJSON(RunCmd(m, runner)); err != nil {
			return fmt.Errorf("write reply: %w", err)
		}
	}
}
