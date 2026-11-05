package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os/exec"
	"path/filepath"
	"strings"
)

// `erainfra worker <command>` runs the Worker-local tool, `rc`, from the path the
// Worker installer wrote it to, with the same arguments, standard streams and exit
// code. It is the EraInfra name for that tool, published beside `rc` by the
// dual-name release (docs/runbooks/rename-phase-2.md, section 1).
//
// ADR 0011 gives the `erainfra` name to this binary alone and reserves `worker`
// for exactly this, so the Worker-side verbs are dispatched from here rather than
// installed as a second program that also answers to `erainfra`. Dispatching
// rather than reimplementing keeps one implementation: `rc` is generated per
// Worker by convex/installScript.ts and carries that machine's paths, service
// manager and update pin, none of which an operator CLI built once for every
// platform can know. `rc` itself is unchanged and stays the stable path.
//
// The path is the installer's, never a PATH lookup. ~/.runner-center is frozen
// (CONTEXT.md rule 4), and a bare `rc` on PATH can be another program entirely:
// Plan 9's rc shell is packaged under that name on most Linux distributions.

const workerHelp = `erainfra worker runs this machine's Worker tool, the same program as rc.

Usage:
  erainfra worker <command> [arguments]

Every command and argument is passed to rc unchanged, so these are the same:
  erainfra worker status        rc status
  erainfra worker logs -f       rc logs -f
  erainfra worker update        rc update

Run it on the Worker, as the account that installed it. rc is at
~/.runner-center/bin/rc (%USERPROFILE%\.runner-center\bin\rc.ps1 on Windows).
`

// workerCommand is the program and argv that run the Worker tool for one
// platform and home directory.
func workerCommand(goos, home string, args []string) (tool, program string, argv []string) {
	bin := filepath.Join(home, ".runner-center", "bin")
	if goos == "windows" {
		tool = filepath.Join(bin, "rc.ps1")
		// Bypass for the same reason the Agent launches provisioners with it: the
		// default policy on a client SKU refuses an unsigned local script.
		return tool, "powershell.exe", append(
			[]string{"-NoProfile", "-ExecutionPolicy", "Bypass", "-File", tool}, args...)
	}
	tool = filepath.Join(bin, "rc")
	return tool, tool, args
}

func (a *App) runWorker(ctx context.Context, args []string) int {
	if len(args) == 1 && (args[0] == "-h" || args[0] == "--help") {
		_, _ = io.WriteString(a.Stdout, workerHelp)
		return ExitOK
	}
	home, err := a.HomeDir()
	if err != nil {
		_, _ = fmt.Fprintf(a.Stderr, "erainfra worker: cannot find the home directory: %v\n", err)
		return ExitError
	}
	tool, program, argv := workerCommand(a.OS, home, args)
	if _, err := a.Stat(tool); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			_, _ = fmt.Fprintf(a.Stderr,
				"erainfra worker: no Worker is installed for this account (%s does not exist).\n"+
					"Install one from the dashboard's Add Worker page, or run this as the account that installed it.\n",
				tool)
		} else {
			_, _ = fmt.Fprintf(a.Stderr, "erainfra worker: %v\n", err)
		}
		return ExitError
	}
	code, err := a.RunLocal(ctx, program, argv, a.Stdin, a.Stdout, a.Stderr)
	if err != nil {
		_, _ = fmt.Fprintf(a.Stderr, "erainfra worker: %s: %v\n", strings.Join(append([]string{program}, argv...), " "), err)
		return ExitError
	}
	return code
}

// runLocal runs a program in the foreground and returns its exit code. The
// context does not kill it: Ctrl-C reaches the child from the terminal on its
// own, and `rc update` must be allowed to run its own cleanup rather than be
// killed halfway through replacing the Agent.
func runLocal(ctx context.Context, program string, args []string, stdin io.Reader, stdout, stderr io.Writer) (int, error) {
	cmd := exec.CommandContext(ctx, program, args...)
	cmd.Cancel = func() error { return nil }
	cmd.Stdin, cmd.Stdout, cmd.Stderr = stdin, stdout, stderr
	err := cmd.Run()
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		if code := exit.ExitCode(); code >= 0 {
			return code, nil
		}
		// Killed by a signal: there is no exit status to pass on.
		return ExitError, nil
	}
	if err != nil {
		return 0, err
	}
	return ExitOK, nil
}
