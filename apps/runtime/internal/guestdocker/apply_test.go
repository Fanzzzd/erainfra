package guestdocker

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// mirror answers /v2/ the way distribution's proxy mode does with no auth.
func mirror(t *testing.T, status int) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v2/" {
			http.NotFound(w, r)
			return
		}
		w.WriteHeader(status)
	}))
	t.Cleanup(server.Close)
	return server
}

func TestApplyMirrorWritesDaemonJSONAndReloads(t *testing.T) {
	server := mirror(t, http.StatusOK)
	path := filepath.Join(t.TempDir(), "docker", "daemon.json")
	reloads := 0
	err := ApplyMirror(t.Context(), MirrorSetup{
		URL: server.URL, DaemonJSON: path, Client: server.Client(),
		Reload: func(context.Context) error { reloads++; return nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	if reloads != 1 {
		t.Fatalf("dockerd reloaded %d times, want 1", reloads)
	}
	var parsed struct {
		Mirrors []string `json:"registry-mirrors"`
	}
	content, _ := os.ReadFile(path)
	if err := json.Unmarshal(content, &parsed); err != nil || len(parsed.Mirrors) != 1 || parsed.Mirrors[0] != server.URL+"/" {
		t.Fatalf("daemon.json = %s (%v)", content, err)
	}
}

// A registry that asks for credentials is still a registry.
func TestApplyMirrorAcceptsAnAuthChallenge(t *testing.T) {
	server := mirror(t, http.StatusUnauthorized)
	err := ApplyMirror(t.Context(), MirrorSetup{
		URL: server.URL, DaemonJSON: filepath.Join(t.TempDir(), "daemon.json"), Client: server.Client(),
		Reload: func(context.Context) error { return nil },
	})
	if err != nil {
		t.Fatal(err)
	}
}

// A mirror that does not answer is never written: every pull would otherwise
// wait out dockerd's dial timeout before falling back to Docker Hub.
func TestApplyMirrorSkipsAMirrorThatDoesNotAnswer(t *testing.T) {
	server := mirror(t, http.StatusOK)
	url := server.URL
	server.Close()
	path := filepath.Join(t.TempDir(), "daemon.json")
	err := ApplyMirror(t.Context(), MirrorSetup{
		URL: url, DaemonJSON: path,
		Reload: func(context.Context) error { t.Fatal("reloaded for an unreachable mirror"); return nil },
	})
	if err == nil {
		t.Fatal("an unreachable mirror was applied")
	}
	if _, statErr := os.Stat(path); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatal("daemon.json was written for an unreachable mirror")
	}
}

func TestApplyMirrorRestoresDaemonJSONWhenTheReloadFails(t *testing.T) {
	server := mirror(t, http.StatusOK)
	dir := t.TempDir()
	reloadFails := MirrorSetup{
		URL: server.URL, Client: server.Client(),
		Reload: func(context.Context) error { return errors.New("Job for docker.service failed") },
	}

	existing := filepath.Join(dir, "existing.json")
	original := []byte(`{"log-driver":"local"}`)
	if err := os.WriteFile(existing, original, 0o644); err != nil {
		t.Fatal(err)
	}
	reloadFails.DaemonJSON = existing
	if err := ApplyMirror(t.Context(), reloadFails); err == nil {
		t.Fatal("a failed reload was reported as success")
	}
	if content, _ := os.ReadFile(existing); string(content) != string(original) {
		t.Fatalf("daemon.json not restored: %s", content)
	}

	absent := filepath.Join(dir, "absent.json")
	reloadFails.DaemonJSON = absent
	if err := ApplyMirror(t.Context(), reloadFails); err == nil {
		t.Fatal("a failed reload was reported as success")
	}
	if _, err := os.Stat(absent); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("a daemon.json that did not exist before was left behind")
	}
}

func TestWriteBuildkitdConfigOwnedByTheRunner(t *testing.T) {
	home := t.TempDir()
	uid, gid := os.Getuid(), os.Getgid()
	wrote, err := WriteBuildkitdConfig(home, uid, gid, BuildkitdConfig{MirrorURL: "http://10.20.0.5:5000"})
	if err != nil || !wrote {
		t.Fatalf("wrote %v, err %v", wrote, err)
	}
	content, err := os.ReadFile(filepath.Join(home, BuildkitdDefaultPath))
	if err != nil || !strings.Contains(string(content), `mirrors = ["10.20.0.5:5000"]`) {
		t.Fatalf("buildkitd.default.toml = %s (%v)", content, err)
	}
	info, err := os.Stat(filepath.Join(home, ".docker"))
	if err != nil || info.Mode().Perm() != 0o700 {
		t.Fatalf("~/.docker mode = %v (%v), want 0700", info.Mode().Perm(), err)
	}

	empty := t.TempDir()
	wrote, err = WriteBuildkitdConfig(empty, uid, gid, BuildkitdConfig{})
	if err != nil || wrote {
		t.Fatalf("nothing to configure: wrote %v, err %v", wrote, err)
	}
	if _, err := os.Stat(filepath.Join(empty, ".docker")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("created ~/.docker with nothing to put in it")
	}
}
