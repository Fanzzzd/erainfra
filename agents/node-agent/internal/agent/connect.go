package agent

import (
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"strings"
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
	Deploy(image, name string, args []string, env map[string]string) (string, error)
	Exec(argv []string) (string, error)
	Build(src BuildSource, registry, tag, hubBase string) (string, error)
}

// BuildSource is either a git repo (clone a ref) or a tarball URL (download + extract). Exactly one
// of RepoURL / TarURL is set.
type BuildSource struct {
	RepoURL string // git: clone url (may embed a short-lived GitHub App token)
	Ref     string // git: branch/tag
	TarURL  string // tar: hub url of the uploaded source.tgz (fetched with the agent's own token)
}

// ShellRunner shells out to the container CLI (docker/podman) and the OS for exec. ponytail: CLI
// shelling is what Coolify does and needs no heavy SDK; swap to github.com/docker/docker/client when
// we need fine-grained control (events, streamed logs, inspect).
// Token is the agent's own hub token, used to fetch app.deploy-gated uploaded sources.
type ShellRunner struct {
	Docker string
	Token  string
}

func (r ShellRunner) cli() string {
	if r.Docker != "" {
		return r.Docker
	}
	return "docker"
}

func (r ShellRunner) Exec(argv []string) (string, error) {
	if len(argv) == 0 {
		return "", fmt.Errorf("empty argv")
	}
	out, err := exec.Command(argv[0], argv[1:]...).CombinedOutput()
	return string(out), err
}

// Deploy pulls the image from the registry and (re)runs it detached. Idempotent on name. Secrets
// arrive as a map and are written to a 0600 --env-file (never argv) so they don't show in `ps` or
// leak into the reply output; the file is removed after the run.
func (r ShellRunner) Deploy(image, name string, args []string, env map[string]string) (string, error) {
	d := r.cli()
	var b strings.Builder
	if out, err := exec.Command(d, "pull", image).CombinedOutput(); err != nil {
		return string(out), fmt.Errorf("pull: %w", err)
	} else {
		b.Write(out)
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

// Build fetches a source (git clone OR tarball) into a temp dir, then builds+pushes it as an image,
// reusing the hub's image.sh (Dockerfile-or-nixpacks auto-detect) so there's one source of build
// logic. Git urls may embed a short-lived GitHub App token; tarballs are fetched with the agent's own
// hub token. Neither is persisted.
func (r ShellRunner) Build(src BuildSource, registry, tag, hubBase string) (string, error) {
	dir, err := os.MkdirTemp("", "pl-build-")
	if err != nil {
		return "", fmt.Errorf("tempdir: %w", err)
	}
	defer os.RemoveAll(dir)
	var b strings.Builder
	switch {
	case src.TarURL != "":
		// Token via env (not argv) so it doesn't show in `ps`. The /builds route is app.deploy-gated.
		cmd := exec.Command("sh", "-c", fmt.Sprintf(`curl -fsSL -H "Authorization: Bearer $PL_TOK" %s | tar -xz -C %s`, shellQuote(src.TarURL), shellQuote(dir)))
		cmd.Env = append(os.Environ(), "PL_TOK="+r.Token)
		if out, err := cmd.CombinedOutput(); err != nil {
			return string(out), fmt.Errorf("fetch source: %w", err)
		}
	default:
		clone := exec.Command("git", "clone", "--depth", "1", "--branch", src.Ref, src.RepoURL, dir)
		if out, err := clone.CombinedOutput(); err != nil {
			return scrub(string(out), src.RepoURL), fmt.Errorf("clone: %w", err) // scrub any token in the url
		} else {
			b.Write(out)
		}
	}
	// Build + push via the hub's image.sh (auto-detects Dockerfile vs nixpacks), targeting the registry.
	sh := fmt.Sprintf("curl -fsSL %s/image.sh | PORTLESS_REGISTRY=%s sh -s -- ship %s %s",
		shellQuote(hubBase), shellQuote(registry), shellQuote(dir), shellQuote(tag))
	out, err := exec.Command("sh", "-c", sh).CombinedOutput()
	b.Write(out)
	if err != nil {
		return b.String(), fmt.Errorf("build: %w", err)
	}
	return b.String(), nil
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
	Type     string            `json:"type"`
	ID       string            `json:"id"`
	Cmd      string            `json:"cmd"`
	Argv     []string          `json:"argv"`
	Image    string            `json:"image"`
	Name     string            `json:"name"`
	Args     []string          `json:"args"`
	Env      map[string]string `json:"env"`      // deploy: secrets → 0600 --env-file (never argv)
	RepoURL  string            `json:"repoUrl"`  // build (git): git url (may embed a short-lived token)
	Ref      string            `json:"ref"`      // build (git): branch/tag to clone
	TarURL   string            `json:"tarUrl"`   // build (upload): hub url of the uploaded source.tgz
	Registry string            `json:"registry"` // build: where to push the image
	Tag      string            `json:"tag"`      // build: image name:tag
	HubBase  string            `json:"hubBase"`  // build: hub http base to fetch image.sh from
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
	case "exec":
		out, err = r.Exec(m.Argv)
	case "deploy":
		out, err = r.Deploy(m.Image, m.Name, m.Args, m.Env)
	case "build":
		out, err = r.Build(BuildSource{RepoURL: m.RepoURL, Ref: m.Ref, TarURL: m.TarURL}, m.Registry, m.Tag, m.HubBase)
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
	if err := c.WriteJSON(map[string]any{"type": "hello", "agentId": agentID, "version": version, "roles": roles}); err != nil {
		return fmt.Errorf("hello: %w", err)
	}
	fmt.Printf("[agent] connected to %s as %q\n", hubURL, agentID)
	// ponytail: commands run synchronously (one at a time) — a long deploy blocks the read loop, which
	// is fine for a single-box agent. Add a write mutex + goroutines if concurrent commands are needed.
	for {
		var m cmdMsg
		if err := c.ReadJSON(&m); err != nil {
			return fmt.Errorf("read: %w", err)
		}
		if m.Type != "cmd" {
			continue
		}
		if err := c.WriteJSON(RunCmd(m, runner)); err != nil {
			return fmt.Errorf("write reply: %w", err)
		}
	}
}
