package agent

import (
	"fmt"
	"net/http"
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
	Deploy(image, name string, args []string) (string, error)
	Exec(argv []string) (string, error)
}

// ShellRunner shells out to the container CLI (docker/podman) and the OS for exec. ponytail: CLI
// shelling is what Coolify does and needs no heavy SDK; swap to github.com/docker/docker/client when
// we need fine-grained control (events, streamed logs, inspect).
type ShellRunner struct{ Docker string }

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

// Deploy pulls the image from the registry and (re)runs it detached. Idempotent on name.
func (r ShellRunner) Deploy(image, name string, args []string) (string, error) {
	d := r.cli()
	var b strings.Builder
	if out, err := exec.Command(d, "pull", image).CombinedOutput(); err != nil {
		return string(out), fmt.Errorf("pull: %w", err)
	} else {
		b.Write(out)
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

type cmdMsg struct {
	Type  string   `json:"type"`
	ID    string   `json:"id"`
	Cmd   string   `json:"cmd"`
	Argv  []string `json:"argv"`
	Image string   `json:"image"`
	Name  string   `json:"name"`
	Args  []string `json:"args"`
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
		out, err = r.Deploy(m.Image, m.Name, m.Args)
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
