package agent

import (
	"errors"
	"testing"
)

type fakeRunner struct {
	execOut, depOut, buildOut, appOut, meshOut string
	execErr, depErr, buildErr, appErr, meshErr error
	executed                                   *Command
	deployCalled                               *bool
}

func (f fakeRunner) Execute(command Command) (string, error) {
	if f.executed != nil {
		*f.executed = command
	}
	return f.execOut, f.execErr
}
func (f fakeRunner) Deploy(image, name string, a []string, env map[string]string, port int) (string, error) {
	if f.deployCalled != nil {
		*f.deployCalled = true
	}
	return f.depOut, f.depErr
}
func (f fakeRunner) DeployApp(app string, services []Service) (string, error) {
	return f.appOut, f.appErr
}
func (f fakeRunner) MeshShare(name string, port int) (string, error) { return f.meshOut, f.meshErr }
func (f fakeRunner) MeshConnect(name, ticket string, localPort int) (string, error) {
	return f.meshOut, f.meshErr
}
func (f fakeRunner) MeshDrop(name string) (string, error)       { return f.meshOut, f.meshErr }
func (f fakeRunner) Serve(app string, port int) (string, error) { return "registered " + app, nil }
func (f fakeRunner) Build(src BuildSource, reg, tag, hub string) (string, error) {
	return f.buildOut, f.buildErr
}
func (f fakeRunner) ReadSpec(src BuildSource) (string, error) { return f.buildOut, f.buildErr }

func TestRunCmdPing(t *testing.T) {
	r := RunCmd(cmdMsg{Type: "cmd", ID: "1", Cmd: "ping"}, fakeRunner{})
	if !r.OK || r.Output != "pong" || r.ID != "1" || r.Type != "reply" {
		t.Fatalf("ping: %+v", r)
	}
}

func TestRunCmdResolvesTypedOperationAtTheNodeBoundary(t *testing.T) {
	var executed Command
	r := RunCmd(cmdMsg{ID: "2", Cmd: "operate", Operation: Operation{Name: "disk.usage", Args: map[string]string{}}}, fakeRunner{execOut: "disk\n", executed: &executed})
	if !r.OK || r.Output != "disk\n" {
		t.Fatalf("operate: %+v", r)
	}
	if executed.Path != "df" || len(executed.Argv) != 2 || executed.Argv[0] != "df" || executed.Argv[1] != "-h" {
		t.Fatalf("operation was not resolved through the allowlist: %+v", executed)
	}
}

func TestRunCmdOperationErr(t *testing.T) {
	r := RunCmd(cmdMsg{ID: "3", Cmd: "operate", Operation: Operation{Name: "disk.usage"}}, fakeRunner{execErr: errors.New("boom")})
	if r.OK || r.Error != "boom" {
		t.Fatalf("operation err: %+v", r)
	}
}

func TestDecodeCmdRejectsCallerControlledArgv(t *testing.T) {
	_, err := decodeCmd([]byte(`{"type":"cmd","id":"pwn","cmd":"operate","operation":{"name":"disk.usage","args":{}},"argv":["sh","-c","id"]}`))
	if err == nil {
		t.Fatal("raw argv must not be part of the hub-to-node protocol")
	}
}

func TestRunCmdDeploy(t *testing.T) {
	r := RunCmd(cmdMsg{ID: "4", Cmd: "deploy", Image: "busybox", Name: "demo"}, fakeRunner{depOut: "started"})
	if !r.OK || r.Output != "started" {
		t.Fatalf("deploy: %+v", r)
	}
}

func TestRunCmdDeployApp(t *testing.T) {
	m := cmdMsg{ID: "7", Cmd: "deployApp", App: "flight", Services: []Service{{Name: "web", Image: "nginx", Port: 80, Route: "flight"}, {Name: "db", Image: "postgres"}}}
	r := RunCmd(m, fakeRunner{appOut: "up"})
	if !r.OK || r.Output != "up" {
		t.Fatalf("deployApp: %+v", r)
	}
}

func TestRunCmdMesh(t *testing.T) {
	share := RunCmd(cmdMsg{ID: "8", Cmd: "meshShare", Name: "db", Port: 5432}, fakeRunner{meshOut: "TICKET123"})
	if !share.OK || share.Output != "TICKET123" {
		t.Fatalf("meshShare: %+v", share)
	}
	conn := RunCmd(cmdMsg{ID: "9", Cmd: "meshConnect", Name: "db", Ticket: "TICKET123", Port: 15432}, fakeRunner{meshOut: "127.0.0.1:15432"})
	if !conn.OK || conn.Output != "127.0.0.1:15432" {
		t.Fatalf("meshConnect: %+v", conn)
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

func TestContextDirConfined(t *testing.T) {
	root := t.TempDir()
	if _, err := contextDir(root, "../escape"); err == nil {
		t.Fatal("contextDir must reject escaping the source root")
	}
	if p, err := contextDir(root, "sub/dir"); err != nil || p != root+"/sub/dir" {
		t.Fatalf("contextDir sub: %v %s", err, p)
	}
	if p, err := contextDir(root, ""); err != nil || p != root {
		t.Fatalf("contextDir empty: %v %s", err, p)
	}
}
