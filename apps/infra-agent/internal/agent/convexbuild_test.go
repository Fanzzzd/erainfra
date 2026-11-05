//go:build !windows

package agent

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// fakeDocker records every invocation, one per line, and succeeds.
func fakeDocker(t *testing.T) (string, string) {
	t.Helper()
	dir := t.TempDir()
	log := filepath.Join(dir, "calls.log")
	script := filepath.Join(dir, "docker")
	body := "#!/bin/sh\nprintf '%s\\n' \"$*\" >> " + shellQuote(log) + "\n"
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	return script, log
}

func tarball(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for name, body := range files {
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(body))}); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write([]byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func uploadServer(t *testing.T, body []byte) (*httptest.Server, *[]http.Header) {
	t.Helper()
	var seen []http.Header
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.Header.Clone())
		_, _ = w.Write(body)
	}))
	t.Cleanup(server.Close)
	return server, &seen
}

func TestConvexBuildFromUploadRunsDockerBuildThenPush(t *testing.T) {
	docker, log := fakeDocker(t)
	server, headers := uploadServer(t, tarball(t, map[string]string{
		"erainfra.yaml":  "services: {}\n",
		"web/Dockerfile": "FROM scratch\n",
	}))
	b := ConvexBuilder{AllowLoopbackHTTP: true}
	r := ShellRunner{Docker: docker, OutputLimit: 16 * 1024, Token: "hub-token-must-not-leak"}
	src := ConvexSource{Kind: "upload", URL: server.URL + "/api/storage/abc"}

	spec, err := b.ReadConvexSpec(context.Background(), r, src)
	if err != nil || spec != "services: {}\n" {
		t.Fatalf("spec = %q, %v", spec, err)
	}
	if _, err := b.BuildConvexImage(context.Background(), r, src, "web", "127.0.0.1:5000/shop-web:abc"); err != nil {
		t.Fatal(err)
	}
	calls, err := os.ReadFile(log)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(calls)), "\n")
	if len(lines) != 2 || !strings.HasPrefix(lines[0], "build -t 127.0.0.1:5000/shop-web:abc /") ||
		!strings.HasSuffix(lines[0], "/src/web") || lines[1] != "push 127.0.0.1:5000/shop-web:abc" {
		t.Fatalf("docker calls = %q", lines)
	}
	// The upload URL is a capability URL; no credential goes with it.
	for _, h := range *headers {
		if h.Get("Authorization") != "" {
			t.Fatal("a credential was sent to the upload URL")
		}
	}
}

func TestConvexBuildRefusesWhatTheHubPathRefuses(t *testing.T) {
	docker, _ := fakeDocker(t)
	server, _ := uploadServer(t, tarball(t, map[string]string{"README": "no Dockerfile\n"}))
	r := ShellRunner{Docker: docker, OutputLimit: 16 * 1024}
	src := ConvexSource{Kind: "upload", URL: server.URL}
	ctx := context.Background()
	if _, err := (ConvexBuilder{}).BuildConvexImage(ctx, r, src, "", "127.0.0.1:5000/x:1"); err == nil {
		t.Fatal("plain HTTP upload URL accepted outside tests")
	}
	b := ConvexBuilder{AllowLoopbackHTTP: true, Nixpacks: filepath.Join(t.TempDir(), "absent")}
	if _, err := b.BuildConvexImage(ctx, r, src, "../..", "127.0.0.1:5000/x:1"); err == nil || !strings.Contains(err.Error(), "escapes") {
		t.Fatalf("escaping build dir: %v", err)
	}
	if _, err := b.BuildConvexImage(ctx, r, src, "", "--privileged"); err == nil {
		t.Fatal("an option was accepted as an image reference")
	}
	t.Setenv("PATH", t.TempDir()+string(os.PathListSeparator)+"/usr/bin:/bin")
	if _, err := (ConvexBuilder{AllowLoopbackHTTP: true}).BuildConvexImage(ctx, r, src, "", "127.0.0.1:5000/x:1"); err == nil || !strings.Contains(err.Error(), "nixpacks") {
		t.Fatalf("no Dockerfile and no nixpacks: %v", err)
	}
}

func TestConvexBuildFetchesThePushedCommitWithoutStoringTheToken(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	root := t.TempDir()
	repo := filepath.Join(root, "acme", "shop")
	run := func(dir string, args ...string) string {
		t.Helper()
		cmd := exec.CommandContext(context.Background(), "git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "HOME="+root,
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@x", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@x")
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	if err := os.MkdirAll(repo, 0o755); err != nil {
		t.Fatal(err)
	}
	run(repo, "init", "-q", "-b", "main")
	if err := os.WriteFile(filepath.Join(repo, "portless.yaml"), []byte("first: {}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run(repo, "add", ".")
	run(repo, "commit", "-q", "-m", "first")
	pushed := run(repo, "rev-parse", "HEAD")
	// The branch moves on after the push; the run must still build the pushed commit.
	if err := os.WriteFile(filepath.Join(repo, "portless.yaml"), []byte("second: {}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run(repo, "commit", "-q", "-am", "second")
	run(repo, "config", "uploadpack.allowAnySHA1InWant", "true")
	if err := os.Rename(repo, repo+".git"); err != nil {
		t.Fatal(err)
	}

	b := ConvexBuilder{GitBase: "file://" + root + "/"}
	r := ShellRunner{OutputLimit: 16 * 1024}
	src := ConvexSource{Kind: "git", Repo: "acme/shop", Ref: "main", Sha: pushed, Token: "ghs_secret"}
	spec, err := b.ReadConvexSpec(context.Background(), r, src)
	if err != nil || spec != "first: {}\n" {
		t.Fatalf("spec = %q, %v", spec, err)
	}
	src.Sha = ""
	if spec, err = b.ReadConvexSpec(context.Background(), r, src); err != nil || spec != "second: {}\n" {
		t.Fatalf("branch head spec = %q, %v", spec, err)
	}

	// The checkout itself must not keep the token: fetch into a directory we keep and inspect.
	dir := t.TempDir()
	src.Sha = pushed
	if err := b.checkout(context.Background(), r, dir, src); err != nil {
		t.Fatal(err)
	}
	config, err := os.ReadFile(filepath.Join(dir, "src", ".git", "config"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(config), "ghs_secret") || strings.Contains(string(config), "Authorization") {
		t.Fatal("the GitHub token was written into the checkout")
	}
	for _, bad := range []ConvexSource{
		{Kind: "git", Repo: "acme/shop", Ref: "--upload-pack=sh"},
		{Kind: "git", Repo: "../etc", Ref: "main"},
		{Kind: "git", Repo: "acme/shop", Ref: "main", Sha: "HEAD"},
	} {
		if err := b.checkout(context.Background(), r, t.TempDir(), bad); err == nil {
			t.Fatalf("accepted %+v", bad)
		}
	}
}
