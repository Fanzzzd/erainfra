package testreport

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"
)

const commit = "0123456789abcdef0123456789abcdef01234567"

func writeFile(t *testing.T, file, contents string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte(contents), 0o644); err != nil {
		t.Fatal(err)
	}
}

func suite(name string, cases ...string) string {
	return `<?xml version="1.0"?><testsuite name="` + name + `">` + strings.Join(cases, "") + `</testsuite>`
}

func passing(name string) string { return `<testcase name="` + name + `" time="0.5"/>` }
func failing(name string) string {
	return `<testcase name="` + name + `"><failure message="broken here"/></testcase>`
}

func TestCollectorFindsReportsInEveryWorkspaceAndNowhereElse(t *testing.T) {
	work := t.TempDir()
	workspace := filepath.Join(work, "app", "app")
	outside := t.TempDir()
	writeFile(t, filepath.Join(workspace, "junit.xml"), suite("root", passing("a")))
	writeFile(t, filepath.Join(workspace, "build", "test-results", "test", "TEST-x.xml"), suite("gradle", failing("b")))
	writeFile(t, filepath.Join(workspace, "pkg", "report.junit.xml"), suite("named", passing("c")))
	// Configured by the repository, in addition to the defaults.
	writeFile(t, filepath.Join(workspace, ConfigFile), "# extra reports\nout/*.xml\n../escape/*.xml\n/abs/*.xml\n")
	writeFile(t, filepath.Join(workspace, "out", "custom.xml"), suite("custom", passing("d")))
	// Matches a default glob but is not JUnit.
	writeFile(t, filepath.Join(workspace, "test-results", "playwright.xml"), `<config><a/></config>`)
	// Never walked: dependencies, fixtures and the runner's own directories.
	writeFile(t, filepath.Join(workspace, "node_modules", "dep", "junit.xml"), suite("dep", failing("x")))
	writeFile(t, filepath.Join(workspace, "testdata", "junit.xml"), suite("fixture", failing("x")))
	writeFile(t, filepath.Join(work, "_temp", "app", "junit.xml"), suite("temp", failing("x")))
	writeFile(t, filepath.Join(work, "_actions", "a", "b", "junit.xml"), suite("action", failing("x")))
	// A link to a file outside the workspace is not followed.
	writeFile(t, filepath.Join(outside, "secret.xml"), suite("secret", failing("x")))
	if err := os.Symlink(filepath.Join(outside, "secret.xml"), filepath.Join(workspace, "junit-link.xml")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(workspace, "linked-dir")); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(workspace, ".git", "HEAD"), "ref: refs/heads/main\n")
	writeFile(t, filepath.Join(workspace, ".git", "packed-refs"), "# pack-refs with: peeled\n"+commit+" refs/heads/main\n")

	report, err := Collector{WorkDir: work}.Collect(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if err := report.Validate(); err != nil {
		t.Fatal(err)
	}
	if report.Files != 4 || report.Totals.Tests != 4 || report.Totals.Failed != 1 {
		t.Fatalf("files = %d, totals = %+v, cases = %+v", report.Files, report.Totals, report.Cases)
	}
	if report.Cases[0].ID != "gradle::b" {
		t.Fatalf("the failure leads: %+v", report.Cases)
	}
	if report.CommitSHA != commit {
		t.Fatalf("commit = %q", report.CommitSHA)
	}
	if report.Truncated {
		t.Fatal("nothing was cut")
	}
}

func TestCollectorReturnsNothingWithoutReports(t *testing.T) {
	work := t.TempDir()
	writeFile(t, filepath.Join(work, "app", "app", "README.md"), "hello")
	report, err := Collector{WorkDir: work}.Collect(context.Background())
	if err != nil || report != nil {
		t.Fatalf("report = %+v, err = %v", report, err)
	}
	if _, err := (Collector{WorkDir: filepath.Join(work, "missing")}).Collect(context.Background()); err == nil {
		t.Fatal("a missing work directory is an error")
	}
}

func TestCollectorSkipsFIFOsAndOversizedFiles(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("no FIFOs")
	}
	work := t.TempDir()
	workspace := filepath.Join(work, "app", "app")
	writeFile(t, filepath.Join(workspace, "junit.xml"), suite("ok", passing("a")))
	if err := syscall.Mkfifo(filepath.Join(workspace, "junit-fifo.xml"), 0o644); err != nil {
		t.Fatal(err)
	}
	big := suite("big", strings.Repeat(passing("same"), MaxFileBytes/len(passing("same"))+1))
	writeFile(t, filepath.Join(workspace, "junit-big.xml"), big)

	done := make(chan *Report, 1)
	go func() {
		report, _ := Collector{WorkDir: work}.Collect(context.Background())
		done <- report
	}()
	select {
	case report := <-done:
		if report == nil || report.Files != 1 || !report.Truncated {
			t.Fatalf("report = %+v", report)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("a FIFO blocked the collector")
	}
}

func TestCollectorStopsAtTheFileBound(t *testing.T) {
	work := t.TempDir()
	for index := range MaxFiles + 5 {
		writeFile(t, filepath.Join(work, "app", "app", fmt.Sprintf("junit-%03d.xml", index)), suite("s", passing(fmt.Sprint(index))))
	}
	report, err := Collector{WorkDir: work}.Collect(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if report.Files != MaxFiles || !report.Truncated {
		t.Fatalf("files = %d, truncated = %v", report.Files, report.Truncated)
	}
}

func TestCollectorHonoursItsBudget(t *testing.T) {
	work := t.TempDir()
	writeFile(t, filepath.Join(work, "app", "app", "junit.xml"), suite("s", passing("a")))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	report, err := Collector{WorkDir: work}.Collect(ctx)
	if err != nil || report != nil {
		t.Fatalf("an expired budget parses nothing: %+v, %v", report, err)
	}
}

func TestReadCommitFromALooseRefAndADetachedHead(t *testing.T) {
	workspace := t.TempDir()
	writeFile(t, filepath.Join(workspace, ".git", "HEAD"), "ref: refs/heads/feature/x\n")
	writeFile(t, filepath.Join(workspace, ".git", "refs", "heads", "feature", "x"), commit+"\n")
	if got := readCommit(workspace); got != commit {
		t.Fatalf("loose ref = %q", got)
	}
	writeFile(t, filepath.Join(workspace, ".git", "HEAD"), strings.ToUpper(commit))
	if got := readCommit(workspace); got != "" {
		t.Fatalf("an id that is not lowercase hex is refused, got %q", got)
	}
	writeFile(t, filepath.Join(workspace, ".git", "HEAD"), "ref: refs/../../etc/passwd\n")
	if got := readCommit(workspace); got != "" {
		t.Fatalf("a ref that climbs out is refused, got %q", got)
	}
	writeFile(t, filepath.Join(workspace, ".git", "HEAD"), commit+"\n")
	if got := readCommit(workspace); got != commit {
		t.Fatalf("detached head = %q", got)
	}
}

func TestMatchPattern(t *testing.T) {
	for _, test := range []struct {
		pattern, name string
		want          bool
	}{
		{"**/junit*.xml", "junit.xml", true},
		{"**/junit*.xml", "a/b/junit-unit.xml", true},
		{"**/junit*.xml", "a/b/xjunit.xml", false},
		{"**/TEST-*.xml", "target/surefire-reports/TEST-com.x.FooTest.xml", true},
		{"**/test-results/**/*.xml", "test-results/a.xml", true},
		{"**/test-results/**/*.xml", "app/build/test-results/test/TEST-a.xml", true},
		{"**/test-results/**/*.xml", "app/build/test-results.xml", false},
		{"out/*.xml", "out/a.xml", true},
		{"out/*.xml", "out/deeper/a.xml", false},
		{"**", "anything/at/all.xml", true},
	} {
		if got := MatchPattern(test.pattern, test.name); got != test.want {
			t.Errorf("MatchPattern(%q, %q) = %v, want %v", test.pattern, test.name, got, test.want)
		}
	}
	for _, pattern := range []string{"../x/*.xml", "/abs/*.xml", "a//b.xml", "a\\b.xml", "[.xml", "**/**/**/**/**/x.xml"} {
		if validPattern(pattern) {
			t.Errorf("validPattern(%q) = true", pattern)
		}
	}
}

func TestBuildBoundsWhatAReportCarries(t *testing.T) {
	var parsed []parsedCase
	for index := range MaxCases + 10 {
		parsed = append(parsed, parsedCase{Suite: "s", Name: fmt.Sprintf("fail-%04d", index), Status: StatusFailed, Message: "m"})
	}
	for index := range MaxPassed + 10 {
		parsed = append(parsed, parsedCase{Suite: "s", Name: fmt.Sprintf("pass-%05d", index), Status: StatusPassed, DurationMs: int64(index)})
	}
	report := Build(parsed)
	if err := report.Validate(); err != nil {
		t.Fatal(err)
	}
	if len(report.Cases) != MaxCases || !report.Truncated || len(report.PassedHashes()) != MaxPassed {
		t.Fatalf("cases = %d, passed = %d, truncated = %v", len(report.Cases), len(report.PassedHashes()), report.Truncated)
	}
	if report.Totals.Tests != MaxCases+10+MaxPassed+10 {
		t.Fatalf("totals count everything even when cases are cut: %+v", report.Totals)
	}

	few := Build(append(parsed[:3:3], parsed[MaxCases+10:]...))
	slowest := 0
	for _, testCase := range few.Cases {
		if testCase.Status == StatusPassed {
			slowest++
		}
	}
	if slowest != MaxSlowest || few.Cases[3].DurationMs != int64(MaxPassed+9) {
		t.Fatalf("slowest passes = %d, first = %+v", slowest, few.Cases[3])
	}
}

func TestValidateRefusesMalformedReports(t *testing.T) {
	valid := func() *Report {
		return &Report{
			Version: Version, Files: 1,
			Totals: Totals{Tests: 2, Passed: 1, Failed: 1},
			Cases:  []Case{{ID: "s::a", Name: "a", Status: StatusFailed}},
			Passed: PassedHash("s::b"),
		}
	}
	if err := valid().Validate(); err != nil {
		t.Fatal(err)
	}
	for name, mutate := range map[string]func(*Report){
		"version":        func(r *Report) { r.Version = 2 },
		"counts":         func(r *Report) { r.Totals.Failed = 5 },
		"negative":       func(r *Report) { r.Totals.Tests, r.Totals.Passed, r.Totals.Failed = 0, 1, -1 },
		"status":         func(r *Report) { r.Cases[0].Status = "exploded" },
		"empty id":       func(r *Report) { r.Cases[0].ID = "" },
		"long message":   func(r *Report) { r.Cases[0].Message = strings.Repeat("m", MaxMessageBytes+1) },
		"invalid utf8":   func(r *Report) { r.Cases[0].Name = "\xff" },
		"hash":           func(r *Report) { r.Passed = "not-a-hash!!" },
		"hash length":    func(r *Report) { r.Passed += "abc" },
		"duplicate hash": func(r *Report) { r.Totals.Passed, r.Totals.Tests = 2, 3; r.Passed += r.Passed },
		"commit":         func(r *Report) { r.CommitSHA = "main" },
		"duration":       func(r *Report) { r.Cases[0].DurationMs = -1 },
	} {
		report := valid()
		mutate(report)
		if err := report.Validate(); err == nil {
			t.Errorf("%s: a malformed report validated", name)
		}
	}
}

// A guest from after the work-folder change still runs under controllers that
// issue the old `_work` folder until they are upgraded, so collection follows
// whichever folder the runner actually used.
func TestFirstExistingDirPrefersTheHostedLayoutAndFallsBack(t *testing.T) {
	root := t.TempDir()
	hosted := filepath.Join(root, "home", "runner", "work")
	legacy := filepath.Join(root, "opt", "runner", "_work")
	if got := FirstExistingDir(hosted, legacy); got != hosted {
		t.Fatalf("neither exists: got %q, want the preferred %q", got, hosted)
	}
	if err := os.MkdirAll(legacy, 0o755); err != nil {
		t.Fatal(err)
	}
	if got := FirstExistingDir(hosted, legacy); got != legacy {
		t.Fatalf("only legacy exists: got %q, want %q", got, legacy)
	}
	if err := os.MkdirAll(hosted, 0o755); err != nil {
		t.Fatal(err)
	}
	if got := FirstExistingDir(hosted, legacy); got != hosted {
		t.Fatalf("both exist: got %q, want %q", got, hosted)
	}
	file := filepath.Join(root, "file")
	writeFile(t, file, "")
	if got := FirstExistingDir(file, legacy); got != legacy {
		t.Fatalf("a regular file is not a work folder: got %q", got)
	}
}
