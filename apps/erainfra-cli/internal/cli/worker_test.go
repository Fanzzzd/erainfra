package cli

import (
	"bytes"
	"context"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
)

type localCall struct {
	program string
	args    []string
	stdin   string
}

// workerApp is an App whose Worker tool is faked: home is the home directory,
// installed says whether the tool exists there, and every run is recorded and
// answered with exit code 3.
func workerApp(t *testing.T, goos, home string, installed bool) (*App, *[]localCall, *bytes.Buffer, *bytes.Buffer) {
	t.Helper()
	var calls []localCall
	var stdout, stderr bytes.Buffer
	app := &App{
		Version: "test",
		Stdin:   strings.NewReader("typed by the operator"),
		Stdout:  &stdout,
		Stderr:  &stderr,
		Getenv:  func(string) string { return "" },
		OS:      goos,
		HomeDir: func() (string, error) { return home, nil },
		Stat: func(path string) (fs.FileInfo, error) {
			if !installed {
				return nil, &fs.PathError{Op: "stat", Path: path, Err: fs.ErrNotExist}
			}
			return nil, nil
		},
		RunLocal: func(_ context.Context, program string, args []string, stdin io.Reader, out, _ io.Writer) (int, error) {
			typed, _ := io.ReadAll(stdin)
			calls = append(calls, localCall{program: program, args: args, stdin: string(typed)})
			_, _ = io.WriteString(out, "rc ran\n")
			return 3, nil
		},
	}
	return app, &calls, &stdout, &stderr
}

func TestWorkerRunsTheInstalledRcWithTheSameArguments(t *testing.T) {
	home := filepath.Join(string(filepath.Separator), "home", "worker")
	app, calls, stdout, _ := workerApp(t, "linux", home, true)
	// rc's exit code is the command's exit code: `rc doctor` failing must fail a script.
	if code := app.Run(context.Background(), []string{"worker", "logs", "-f", "--json"}); code != 3 {
		t.Fatalf("exit %d, want rc's 3", code)
	}
	want := filepath.Join(home, ".runner-center", "bin", "rc")
	if len(*calls) != 1 || (*calls)[0].program != want ||
		!slices.Equal((*calls)[0].args, []string{"logs", "-f", "--json"}) {
		t.Fatalf("ran %+v, want %s logs -f --json", *calls, want)
	}
	// Flags belong to rc, not to this CLI: --json above was not taken as the
	// global output flag, and stdin reaches rc for its own prompts.
	if (*calls)[0].stdin != "typed by the operator" || stdout.String() != "rc ran\n" {
		t.Fatalf("streams were not passed through: stdin %q, stdout %q", (*calls)[0].stdin, stdout.String())
	}
}

func TestWorkerOnWindowsRunsRcPs1ThroughPowerShell(t *testing.T) {
	home := `C:\Users\worker`
	app, calls, _, _ := workerApp(t, "windows", home, true)
	app.Run(context.Background(), []string{"worker", "status"})
	script := filepath.Join(home, ".runner-center", "bin", "rc.ps1")
	want := []string{"-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "status"}
	if len(*calls) != 1 || (*calls)[0].program != "powershell.exe" || !slices.Equal((*calls)[0].args, want) {
		t.Fatalf("ran %+v, want powershell.exe %v", *calls, want)
	}
}

func TestWorkerWithNoInstalledWorkerSaysWhereItLooked(t *testing.T) {
	home := filepath.Join(string(filepath.Separator), "home", "operator")
	app, calls, _, stderr := workerApp(t, "linux", home, false)
	if code := app.Run(context.Background(), []string{"worker", "status"}); code != ExitError {
		t.Fatalf("exit %d, want %d", code, ExitError)
	}
	if len(*calls) != 0 {
		t.Fatalf("ran %+v with no Worker installed", *calls)
	}
	if !strings.Contains(stderr.String(), filepath.Join(home, ".runner-center", "bin", "rc")) {
		t.Fatalf("stderr %q does not name the path it looked at", stderr.String())
	}
}

// The real runLocal against a real script standing in for rc: arguments,
// output and exit status all cross the process boundary unchanged.
func TestWorkerExecutesTheRealTool(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the stand-in rc is a POSIX shell script")
	}
	home := t.TempDir()
	bin := filepath.Join(home, ".runner-center", "bin")
	if err := os.MkdirAll(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	script := "#!/bin/sh\nprintf 'rc'; for a in \"$@\"; do printf ' [%s]' \"$a\"; done; printf '\\n'; exit 5\n"
	if err := os.WriteFile(filepath.Join(bin, "rc"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	var stdout, stderr bytes.Buffer
	app := &App{
		Stdin: strings.NewReader(""), Stdout: &stdout, Stderr: &stderr,
		Getenv:  func(string) string { return "" },
		OS:      runtime.GOOS,
		HomeDir: func() (string, error) { return home, nil },
		Stat:    os.Stat, RunLocal: runLocal,
	}
	code := app.Run(context.Background(), []string{"worker", "update", "--version", "v1.2.3", "two words"})
	if code != 5 {
		t.Fatalf("exit %d, want the tool's 5; stderr %q", code, stderr.String())
	}
	if got := stdout.String(); got != "rc [update] [--version] [v1.2.3] [two words]\n" {
		t.Fatalf("stdout %q", got)
	}
}
