package cli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const migrateWorkflow = `name: CI
on: push
jobs:
  test:
    runs-on: ubuntu-latest # GitHub-hosted for now
    steps:
      - run: make test
  matrix:
    strategy:
      matrix:
        os: [ubuntu-latest, windows-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - run: make test
`

func migrateRepo(t *testing.T, mode os.FileMode) (string, string) {
	t.Helper()
	repo := t.TempDir()
	dir := filepath.Join(repo, ".github", "workflows")
	if err := os.MkdirAll(filepath.Join(dir, "nested"), 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "ci.yml")
	if err := os.WriteFile(path, []byte(migrateWorkflow), mode); err != nil {
		t.Fatal(err)
	}
	// GitHub reads only the top level of .github/workflows, and only YAML.
	for _, other := range []string{filepath.Join(dir, "nested", "ignored.yml"), filepath.Join(dir, "notes.txt")} {
		if err := os.WriteFile(other, []byte("jobs:\n  x:\n    runs-on: ubuntu-latest\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return repo, path
}

func TestMigrateRunsOnPrintsADiffAndWritesNothing(t *testing.T) {
	h := newHarness(t)
	repo, path := migrateRepo(t, 0o644)
	h.expect(ExitOK, "migrate", "runs-on", "--repo", repo)

	want := `--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -2,7 +2,7 @@
 on: push
 jobs:
   test:
-    runs-on: ubuntu-latest # GitHub-hosted for now
+    runs-on: erainfra-4vcpu-ubuntu-2404 # GitHub-hosted for now
     steps:
       - run: make test
   matrix:
`
	if h.stdout.String() != want {
		t.Errorf("stdout:\n%s\nwant:\n%s", h.stdout.String(), want)
	}
	for _, fragment := range []string{
		"Not logged in",
		"ci.yml:12 (job matrix): runs-on is the matrix expression ${{ matrix.os }}",
		"1 labels in 1 files would change",
	} {
		if !strings.Contains(h.stderr.String(), fragment) {
			t.Errorf("stderr lacks %q:\n%s", fragment, h.stderr.String())
		}
	}
	if got, _ := os.ReadFile(path); string(got) != migrateWorkflow {
		t.Errorf("a dry run changed the file:\n%s", got)
	}
}

func TestMigrateRunsOnWritesInPlaceKeepingTheMode(t *testing.T) {
	h := newHarness(t)
	repo, path := migrateRepo(t, 0o600)
	h.expect(ExitOK, "migrate", "runs-on", "--repo", repo, "--write", "--map", "windows-latest=erainfra-4vcpu-windows-2025", "--map", "UBUNTU-LATEST=erainfra-8vcpu-ubuntu-2404")
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	want := strings.Replace(migrateWorkflow, "runs-on: ubuntu-latest #", "runs-on: erainfra-8vcpu-ubuntu-2404 #", 1)
	if string(got) != want {
		t.Errorf("file after --write:\n%s", got)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("mode = %v, want 0600", info.Mode().Perm())
	}
	if h.stdout.String() != "rewrote .github/workflows/ci.yml (1)\n" || !strings.Contains(h.stderr.String(), "Rewrote 1 labels in 1 files.") {
		t.Errorf("stdout %q stderr %q", h.stdout.String(), h.stderr.String())
	}
	// The matrix note names what each matrix value would become under --map.
	if !strings.Contains(h.stderr.String(), "windows-latest -> erainfra-4vcpu-windows-2025") {
		t.Errorf("stderr lacks the mapped matrix value:\n%s", h.stderr.String())
	}
	entries, _ := os.ReadDir(filepath.Dir(path))
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".") {
			t.Errorf("--write left %s behind", e.Name())
		}
	}

	h.expect(ExitOK, "migrate", "runs-on", "--repo", repo, "--write")
	if !strings.Contains(h.stderr.String(), "Nothing to rewrite") {
		t.Errorf("a second run should find nothing, stderr %q", h.stderr.String())
	}
}

func TestMigrateRunsOnUsesTheRegisteredProfiles(t *testing.T) {
	h := newHarness(t).loggedIn()
	h.api.on("GET /api/v1/profiles", 200, `{"profiles":[
		{"name":"erainfra-8vcpu-ubuntu-2404","state":"active"},
		{"name":"erainfra-2vcpu-ubuntu-2404","state":"active"},
		{"name":"erainfra-4vcpu-ubuntu-2404","state":"paused"}]}`)
	repo, _ := migrateRepo(t, 0o644)
	h.expect(ExitOK, "migrate", "runs-on", "--repo", repo, "--json")

	var report struct {
		Repo     string `json:"repo"`
		Written  bool   `json:"written"`
		Profiles struct {
			Source     string   `json:"source"`
			Registered []string `json:"registered"`
		} `json:"profiles"`
		Files []struct {
			Path    string `json:"path"`
			Diff    string `json:"diff"`
			Changes []struct {
				Line   int    `json:"line"`
				Column int    `json:"column"`
				Job    string `json:"job"`
				Field  string `json:"field"`
				From   string `json:"from"`
				To     string `json:"to"`
				Source string `json:"source"`
				Reason string `json:"reason"`
			} `json:"changes"`
			Notes []struct {
				Line    int    `json:"line"`
				Job     string `json:"job"`
				Kind    string `json:"kind"`
				Message string `json:"message"`
			} `json:"notes"`
		} `json:"files"`
	}
	if err := json.Unmarshal(h.stdout.Bytes(), &report); err != nil {
		t.Fatalf("--json is not JSON: %v\n%s", err, h.stdout.String())
	}
	if report.Profiles.Source != "control-plane" || len(report.Profiles.Registered) != 3 || report.Written {
		t.Errorf("report header = %+v", report)
	}
	if len(report.Files) != 1 || len(report.Files[0].Changes) != 1 || len(report.Files[0].Notes) != 1 {
		t.Fatalf("files = %+v", report.Files)
	}
	change := report.Files[0].Changes[0]
	// The paused 4 vCPU Profile is not offered; the smallest active one with
	// at least the hosted runner's 4 vCPU is.
	if change.From != "ubuntu-latest" || change.To != "erainfra-8vcpu-ubuntu-2404" || change.Source != "control-plane" ||
		change.Line != 5 || change.Column != 14 || change.Job != "test" || change.Field != "runs-on" {
		t.Errorf("change = %+v", change)
	}
	if note := report.Files[0].Notes[0]; note.Kind != "matrix" || note.Line != 12 {
		t.Errorf("note = %+v", note)
	}
	if !strings.Contains(report.Files[0].Diff, "+    runs-on: erainfra-8vcpu-ubuntu-2404") {
		t.Errorf("diff = %q", report.Files[0].Diff)
	}
}

func TestMigrateRunsOnRefusesToGuessWhenTheControlPlaneFails(t *testing.T) {
	h := newHarness(t).loggedIn()
	h.api.on("GET /api/v1/profiles", 500, `{"error":{"code":"internal","message":"boom"}}`)
	repo, path := migrateRepo(t, 0o644)
	h.expect(ExitError, "migrate", "runs-on", "--repo", repo, "--write")
	if !strings.Contains(h.stderr.String(), "--offline") {
		t.Errorf("stderr should offer --offline: %q", h.stderr.String())
	}
	if got, _ := os.ReadFile(path); string(got) != migrateWorkflow {
		t.Error("a failed run changed the file")
	}

	h.expect(ExitOK, "migrate", "runs-on", "--repo", repo, "--offline")
	if !strings.Contains(h.stdout.String(), "erainfra-4vcpu-ubuntu-2404") {
		t.Errorf("--offline should use the built-in names: %q", h.stdout.String())
	}
}

func TestMigrateRunsOnUsageErrors(t *testing.T) {
	h := newHarness(t).loggedIn()
	repo, _ := migrateRepo(t, 0o644)
	for _, args := range [][]string{
		{"migrate", "runs-on", "--repo", repo, "--map", "ubuntu-latest"},
		{"migrate", "runs-on", "--repo", repo, "--map", "ubuntu-latest=two words"},
		{"migrate", "runs-on", "--repo", repo, "--map", "ubuntu-latest=a\nb"},
		{"migrate", "runs-on", "--repo", repo, "--map", "a=x", "--map", "A=y"},
		{"migrate", "runs-on", "--repo", t.TempDir()},
		{"migrate", "runs-on", "extra", "--repo", repo},
	} {
		h.expect(ExitUsage, args...)
	}
	if len(h.api.requests) != 0 {
		t.Errorf("usage errors sent %d requests", len(h.api.requests))
	}
	h.expect(ExitOK, "migrate", "runs-on", "--help")
	for _, want := range []string{"--write", "--map label=profile", "--offline", "--repo path", "repeatable"} {
		if !strings.Contains(h.stdout.String(), want) {
			t.Errorf("help lacks %q", want)
		}
	}
}
