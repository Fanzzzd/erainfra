package agent

import (
	"context"
	"errors"
	"io"
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
	contexts                                   *[]context.Context
}

func (f fakeRunner) saw(ctx context.Context) {
	if f.contexts != nil {
		*f.contexts = append(*f.contexts, ctx)
	}
}

func (f fakeRunner) Execute(ctx context.Context, command Command) (string, error) {
	f.saw(ctx)
	if f.executed != nil {
		*f.executed = command
	}
	return f.execOut, f.execErr
}
func (f fakeRunner) Deploy(ctx context.Context, image, name string, a []string, env map[string]string, port int) (string, error) {
	f.saw(ctx)
	if f.deployCalled != nil {
		*f.deployCalled = true
	}
	return f.depOut, f.depErr
}
func (f fakeRunner) DeployApp(ctx context.Context, app string, services []Service) (string, error) {
	f.saw(ctx)
	return f.appOut, f.appErr
}
func (f fakeRunner) MeshShare(ctx context.Context, name string, port int) (string, error) {
	return f.meshOut, f.meshErr
}
func (f fakeRunner) MeshConnect(ctx context.Context, name, ticket string, localPort int) (string, error) {
	return f.meshOut, f.meshErr
}
func (f fakeRunner) MeshDrop(name string) (string, error)       { return f.meshOut, f.meshErr }
func (f fakeRunner) Serve(app string, port int) (string, error) { return "registered " + app, nil }
func (f fakeRunner) Build(ctx context.Context, src BuildSource, reg, tag, hub string) (string, error) {
	f.saw(ctx)
	return f.buildOut, f.buildErr
}
func (f fakeRunner) ReadSpec(ctx context.Context, src BuildSource) (string, error) {
	f.saw(ctx)
	return f.buildOut, f.buildErr
}

func TestRunCmdPing(t *testing.T) {
	r := RunCmd(t.Context(), cmdMsg{Type: "cmd", ID: "1", Cmd: "ping"}, fakeRunner{})
	if !r.OK || r.Output != "pong" || r.ID != "1" || r.Type != "reply" {
		t.Fatalf("ping: %+v", r)
	}
}

func TestRunCmdResolvesTypedOperationAtTheNodeBoundary(t *testing.T) {
	var executed Command
	r := RunCmd(t.Context(), cmdMsg{ID: "2", Cmd: "operate", Operation: Operation{Name: "disk.usage", Args: map[string]string{}}}, fakeRunner{execOut: "disk\n", executed: &executed})
	if !r.OK || r.Output != "disk\n" {
		t.Fatalf("operate: %+v", r)
	}
	if executed.Path != "df" || len(executed.Argv) != 2 || executed.Argv[0] != "df" || executed.Argv[1] != "-h" {
		t.Fatalf("operation was not resolved through the allowlist: %+v", executed)
	}
}

func TestRunCmdOperationErr(t *testing.T) {
	r := RunCmd(t.Context(), cmdMsg{ID: "3", Cmd: "operate", Operation: Operation{Name: "disk.usage"}}, fakeRunner{execErr: errors.New("boom")})
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
	r := RunCmd(t.Context(), cmdMsg{ID: "4", Cmd: "deploy", Image: "busybox", Name: "demo"}, fakeRunner{depOut: "started"})
	if !r.OK || r.Output != "started" {
		t.Fatalf("deploy: %+v", r)
	}
}

func TestRunCmdDeployApp(t *testing.T) {
	m := cmdMsg{ID: "7", Cmd: "deployApp", App: "flight", Services: []Service{{Name: "web", Image: "nginx", Port: 80, Route: "flight"}, {Name: "db", Image: "postgres"}}}
	r := RunCmd(t.Context(), m, fakeRunner{appOut: "up"})
	if !r.OK || r.Output != "up" {
		t.Fatalf("deployApp: %+v", r)
	}
}

func TestRunCmdMesh(t *testing.T) {
	share := RunCmd(t.Context(), cmdMsg{ID: "8", Cmd: "meshShare", Name: "db", Port: 5432}, fakeRunner{meshOut: "TICKET123"})
	if !share.OK || share.Output != "TICKET123" {
		t.Fatalf("meshShare: %+v", share)
	}
	conn := RunCmd(t.Context(), cmdMsg{ID: "9", Cmd: "meshConnect", Name: "db", Ticket: "TICKET123", Port: 15432}, fakeRunner{meshOut: "127.0.0.1:15432"})
	if !conn.OK || conn.Output != "127.0.0.1:15432" {
		t.Fatalf("meshConnect: %+v", conn)
	}
}

func TestRunCmdBuild(t *testing.T) {
	r := RunCmd(t.Context(), cmdMsg{ID: "6", Cmd: "build", RepoURL: "https://x@github.com/o/r.git", Ref: "main", Tag: "r:abc"}, fakeRunner{buildOut: "shipped"})
	if !r.OK || r.Output != "shipped" {
		t.Fatalf("build: %+v", r)
	}
}

// Every command that shells out runs under the caller's context, so cancelling it reaches the
// child process instead of stopping at RunCmd.
func TestRunCmdPassesTheCallerContextToTheRunner(t *testing.T) {
	type key struct{}
	ctx := context.WithValue(t.Context(), key{}, "caller")
	var seen []context.Context
	runner := fakeRunner{contexts: &seen}
	for _, m := range []cmdMsg{
		{ID: "a", Cmd: "operate", Operation: Operation{Name: "disk.usage", Args: map[string]string{}}},
		{ID: "b", Cmd: "deploy", Image: "busybox", Name: "demo"},
		{ID: "c", Cmd: "deployApp", App: "flight", Services: []Service{{Name: "web", Image: "nginx"}}},
		{ID: "d", Cmd: "build", RepoURL: "https://github.com/o/r.git", Ref: "main", Tag: "r:abc"},
		{ID: "e", Cmd: "spec", RepoURL: "https://github.com/o/r.git", Ref: "main"},
	} {
		if r := RunCmd(ctx, m, runner); !r.OK {
			t.Fatalf("%s: %+v", m.Cmd, r)
		}
	}
	if len(seen) != 5 {
		t.Fatalf("runner saw %d contexts, want 5", len(seen))
	}
	for i, got := range seen {
		if got.Value(key{}) != "caller" {
			t.Fatalf("call %d ran under a context that is not the caller's", i)
		}
	}
}

// A temp env file or checkout that cannot be removed leaves a secret on disk, so the failure is
// reported instead of dropped.
func TestRemoveSecretPathRemovesTreesAndReportsFailure(t *testing.T) {
	root := t.TempDir()
	checkout := filepath.Join(root, "checkout")
	mustMkdirAll(t, filepath.Join(checkout, ".git"))
	if err := os.WriteFile(filepath.Join(checkout, ".git", "config"), []byte("token"), 0o600); err != nil {
		t.Fatal(err)
	}
	removeSecretPath(checkout)
	if _, err := os.Lstat(checkout); !os.IsNotExist(err) {
		t.Fatalf("checkout still present after removal: %v", err)
	}

	if os.Geteuid() == 0 {
		t.Skip("root ignores directory permissions, so the failure case cannot be staged")
	}
	locked := filepath.Join(root, "locked")
	envFile := filepath.Join(locked, "pl-env-1")
	mustMkdirAll(t, locked)
	if err := os.WriteFile(envFile, []byte("SECRET=1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(locked, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(locked, 0o700) })
	output := captureStdout(t, func() { removeSecretPath(envFile) })
	if !strings.Contains(output, "could not remove "+envFile) {
		t.Fatalf("failure was not reported; stdout = %q", output)
	}
}

func captureStdout(t *testing.T, fn func()) string {
	t.Helper()
	read, write, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	original := os.Stdout
	os.Stdout = write
	fn()
	os.Stdout = original
	if err := write.Close(); err != nil {
		t.Fatal(err)
	}
	out, err := io.ReadAll(read)
	if err != nil {
		t.Fatal(err)
	}
	return string(out)
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
	r := RunCmd(t.Context(), cmdMsg{ID: "5", Cmd: "frob"}, fakeRunner{})
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

// TestReadConfined pins the spec read against the same untrusted checkout contextDir defends.
// os.ReadFile follows symlinks, so `portless.yaml -> /etc/shadow` would otherwise be returned to the
// hub as the app's spec, and the agent reads it as root.
func TestReadConfined(t *testing.T) {
	root := t.TempDir()
	outside := filepath.Join(t.TempDir(), "secret")
	if err := os.WriteFile(outside, []byte("root:$6$hunter2"), 0o600); err != nil {
		t.Fatalf("write outside: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "portless.yaml"), []byte("services: {}\n"), 0o644); err != nil {
		t.Fatalf("write spec: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "shared.yml"), []byte("shared: true\n"), 0o644); err != nil {
		t.Fatalf("write shared: %v", err)
	}
	mustSymlink(t, outside, filepath.Join(root, "escape.yaml"))
	mustSymlink(t, filepath.Join(root, "shared.yml"), filepath.Join(root, "inside.yaml"))
	mustMkdirAll(t, filepath.Join(root, "adir.yaml"))

	for _, tc := range []struct {
		name string
		file string
		want string // expected content, when the read should succeed
		fail bool
	}{
		{name: "a regular spec in the checkout", file: "portless.yaml", want: "services: {}\n"},
		{name: "a symlink to a sibling in the checkout", file: "inside.yaml", want: "shared: true\n"},
		{name: "a symlink out of the checkout", file: "escape.yaml", fail: true},
		{name: "a directory", file: "adir.yaml", fail: true},
		{name: "absent", file: "nope.yaml", fail: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body, err := readConfined(root, tc.file)
			if tc.fail {
				if err == nil {
					t.Fatalf("readConfined(%q) = %q, want an error", tc.file, body)
				}
				if strings.Contains(string(body), "hunter2") {
					t.Fatalf("readConfined(%q) leaked content from outside the checkout", tc.file)
				}
				return
			}
			if err != nil {
				t.Fatalf("readConfined(%q): %v", tc.file, err)
			}
			if string(body) != tc.want {
				t.Fatalf("readConfined(%q) = %q, want %q", tc.file, body, tc.want)
			}
		})
	}
}

// Stage 1 of retiring the "Portless" name (ADR 0004). The app spec lives in a CUSTOMER's repository,
// so it is not ours to rewrite: every repo bound to a Hub today carries portless.yaml and must keep
// deploying byte-for-byte. Ordered search, new names first, old names still sufficient on their own.
func TestReadSpecReadsBothSpecFilenames(t *testing.T) {
	for _, tc := range []struct {
		name  string
		files map[string]string
		want  string
	}{
		{
			name:  "the renamed spec alone",
			files: map[string]string{"erainfra.yaml": "new: {}\n"},
			want:  "new: {}\n",
		},
		{
			// THE property: this is every bound repository in the field today.
			name:  "the retired spec alone is still sufficient",
			files: map[string]string{"portless.yaml": "old: {}\n"},
			want:  "old: {}\n",
		},
		{
			name:  "both present — the renamed one wins",
			files: map[string]string{"erainfra.yaml": "new: {}\n", "portless.yaml": "old: {}\n"},
			want:  "new: {}\n",
		},
		{
			// Neither: unchanged behaviour, the hub falls back to a single-service deploy.
			name:  "neither present",
			files: map[string]string{"README.md": "hello\n"},
			want:  "",
		},
		{
			name:  "the .yml spelling of each is read too",
			files: map[string]string{"portless.yml": "old-yml: {}\n"},
			want:  "old-yml: {}\n",
		},
		{
			// The table said it covered both .yml spellings and only ever wrote the retired one.
			name:  "the renamed .yml is read as well as the retired one",
			files: map[string]string{"erainfra.yml": "new-yml: {}\n"},
			want:  "new-yml: {}\n",
		},
		{
			// A customer mid-migration has both in the repo. Whichever wins has to be the same one
			// every time, or two deploys of an unchanged commit produce different apps.
			name: "both names present: the renamed file wins",
			files: map[string]string{
				"erainfra.yaml": "new: {}\n",
				"portless.yaml": "old: {}\n",
			},
			want: "new: {}\n",
		},
		{
			// .yaml before .yml within each brand, and a renamed .yml still beats a retired .yaml —
			// the ordering is by brand first, which is what makes the migration monotonic.
			name: "the renamed .yml beats the retired .yaml",
			files: map[string]string{
				"erainfra.yml":  "new-yml: {}\n",
				"portless.yaml": "old: {}\n",
			},
			want: "new-yml: {}\n",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			for name, body := range tc.files {
				if err := os.WriteFile(filepath.Join(root, name), []byte(body), 0o644); err != nil {
					t.Fatalf("write %s: %v", name, err)
				}
			}
			// The production search, not a copy of it. ReadSpec only adds fetching the source into
			// a temp dir, which needs a network and a git binary; everything this test is about
			// lives in specFromCheckout, so re-listing the candidates here would assert the test's
			// own opinion of the order rather than the agent's.
			got := specFromCheckout(root)
			if got != tc.want {
				t.Fatalf("spec = %q, want %q", got, tc.want)
			}
		})
	}
}
