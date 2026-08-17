package agent

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
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

// mustMkdirAll and mustSymlink build the checkout shape a contextDir case needs.
func mustMkdirAll(t *testing.T, path string) string {
	t.Helper()
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", path, err)
	}
	return path
}

func mustSymlink(t *testing.T, target, link string) string {
	t.Helper()
	if err := os.Symlink(target, link); err != nil {
		t.Fatalf("symlink %s -> %s: %v", link, target, err)
	}
	return link
}

func mustEvalSymlinks(t *testing.T, path string) string {
	t.Helper()
	p, err := filepath.EvalSymlinks(path)
	if err != nil {
		t.Fatalf("eval %s: %v", path, err)
	}
	return p
}

// TestContextDirConfined pins the confinement against a checkout an untrusted source produced: the
// root is filled by a tarball fetch or a `git clone`, so it can contain symlinks as easily as `..`.
func TestContextDirConfined(t *testing.T) {
	root := t.TempDir()
	mustMkdirAll(t, filepath.Join(root, "sub", "dir"))
	mustMkdirAll(t, filepath.Join(root, "svc"))
	mustSymlink(t, t.TempDir(), filepath.Join(root, "escape"))                // ctx -> somewhere else entirely
	mustSymlink(t, filepath.Join(root, "svc"), filepath.Join(root, "inside")) // ctx -> a sibling in the checkout

	// Every expectation is against the evaluated root: t.TempDir() hands back a path under /var on
	// macOS, which is itself a symlink to /private/var, and contextDir returns the path it validated.
	realRoot := mustEvalSymlinks(t, root)

	for _, tc := range []struct {
		name    string
		sub     string
		want    string // expected return, when the call should succeed
		wantErr string // substring the error must contain, when it should fail
	}{
		{name: "a plain subdirectory", sub: "sub/dir", want: filepath.Join(realRoot, "sub", "dir")},
		{name: "an empty subdir is the root", sub: "", want: realRoot},
		{name: "a dot subdir is the root", sub: ".", want: realRoot},
		{name: "parent traversal out of the root", sub: "../../etc", wantErr: "escapes the source root"},
		{name: "a symlink pointing out of the root", sub: "escape", wantErr: "escapes the source root"},
		{name: "a symlink pointing inside the root", sub: "inside", want: filepath.Join(realRoot, "svc")},
		{name: "a subdir that does not exist", sub: "nope", wantErr: "no such build dir"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := contextDir(root, tc.sub)
			if tc.wantErr != "" {
				if err == nil {
					t.Fatalf("contextDir(%q) = %q, want error %q", tc.sub, got, tc.wantErr)
				}
				if !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("contextDir(%q) error = %v, want it to mention %q", tc.sub, err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("contextDir(%q): %v", tc.sub, err)
			}
			if got != tc.want {
				t.Fatalf("contextDir(%q) = %q, want %q", tc.sub, got, tc.want)
			}
		})
	}
}

// TestContextDirAcceptsASymlinkedRoot covers the shape os.MkdirTemp itself produces on macOS: the
// root arrives unevaluated, so a resolved child is never lexically prefixed by it.
func TestContextDirAcceptsASymlinkedRoot(t *testing.T) {
	base := t.TempDir()
	target := mustMkdirAll(t, filepath.Join(base, "checkout"))
	mustMkdirAll(t, filepath.Join(target, "app"))
	root := mustSymlink(t, target, filepath.Join(base, "link"))

	got, err := contextDir(root, "app")
	if err != nil {
		t.Fatalf("contextDir through a symlinked root: %v", err)
	}
	if want := filepath.Join(mustEvalSymlinks(t, target), "app"); got != want {
		t.Fatalf("contextDir through a symlinked root = %q, want %q", got, want)
	}
}
