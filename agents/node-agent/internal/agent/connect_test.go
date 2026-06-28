package agent

import (
	"errors"
	"testing"
)

type fakeRunner struct {
	execOut, depOut, buildOut string
	execErr, depErr, buildErr error
}

func (f fakeRunner) Exec(argv []string) (string, error)                    { return f.execOut, f.execErr }
func (f fakeRunner) Deploy(image, name string, a []string, env map[string]string) (string, error) {
	return f.depOut, f.depErr
}
func (f fakeRunner) Build(src BuildSource, reg, tag, hub string) (string, error) {
	return f.buildOut, f.buildErr
}

func TestRunCmdPing(t *testing.T) {
	r := RunCmd(cmdMsg{Type: "cmd", ID: "1", Cmd: "ping"}, fakeRunner{})
	if !r.OK || r.Output != "pong" || r.ID != "1" || r.Type != "reply" {
		t.Fatalf("ping: %+v", r)
	}
}

func TestRunCmdExec(t *testing.T) {
	r := RunCmd(cmdMsg{ID: "2", Cmd: "exec", Argv: []string{"echo", "hi"}}, fakeRunner{execOut: "hi\n"})
	if !r.OK || r.Output != "hi\n" {
		t.Fatalf("exec: %+v", r)
	}
}

func TestRunCmdExecErr(t *testing.T) {
	r := RunCmd(cmdMsg{ID: "3", Cmd: "exec", Argv: []string{"x"}}, fakeRunner{execErr: errors.New("boom")})
	if r.OK || r.Error != "boom" {
		t.Fatalf("exec err: %+v", r)
	}
}

func TestRunCmdDeploy(t *testing.T) {
	r := RunCmd(cmdMsg{ID: "4", Cmd: "deploy", Image: "busybox", Name: "demo"}, fakeRunner{depOut: "started"})
	if !r.OK || r.Output != "started" {
		t.Fatalf("deploy: %+v", r)
	}
}

func TestRunCmdBuild(t *testing.T) {
	r := RunCmd(cmdMsg{ID: "6", Cmd: "build", RepoURL: "https://x@github.com/o/r.git", Ref: "main", Tag: "r:abc"}, fakeRunner{buildOut: "shipped"})
	if !r.OK || r.Output != "shipped" {
		t.Fatalf("build: %+v", r)
	}
}

func TestShellQuote(t *testing.T) {
	if got := shellQuote("a'b"); got != `'a'\''b'` {
		t.Fatalf("shellQuote: %s", got)
	}
	if got := scrub("cloning https://tok@github.com/o/r failed", "https://tok@github.com/o/r"); got != "cloning <redacted> failed" {
		t.Fatalf("scrub: %s", got)
	}
}

func TestRunCmdUnknown(t *testing.T) {
	r := RunCmd(cmdMsg{ID: "5", Cmd: "frob"}, fakeRunner{})
	if r.OK || r.Error == "" {
		t.Fatalf("unknown: %+v", r)
	}
}
