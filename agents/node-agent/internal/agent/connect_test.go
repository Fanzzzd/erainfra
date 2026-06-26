package agent

import (
	"errors"
	"testing"
)

type fakeRunner struct {
	execOut, depOut string
	execErr, depErr error
}

func (f fakeRunner) Exec(argv []string) (string, error)              { return f.execOut, f.execErr }
func (f fakeRunner) Deploy(image, name string, a []string) (string, error) { return f.depOut, f.depErr }

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

func TestRunCmdUnknown(t *testing.T) {
	r := RunCmd(cmdMsg{ID: "5", Cmd: "frob"}, fakeRunner{})
	if r.OK || r.Error == "" {
		t.Fatalf("unknown: %+v", r)
	}
}
