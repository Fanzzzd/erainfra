// Package cli is the `erainfra` command: an operator's view of an EraInfra
// fleet through the control plane's operator API (/api/v1).
package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os/exec"
	"strings"
	"time"
)

// Exit codes. 4 for authentication follows gh, so a script can tell "log in
// again" from "the request failed".
const (
	ExitOK    = 0
	ExitError = 1
	ExitUsage = 2
	ExitAuth  = 4
)

// App holds everything a command touches outside its own memory, so tests run
// commands against a fake server and a temporary config directory.
type App struct {
	Version  string
	Stdin    io.Reader
	Stdout   io.Writer
	Stderr   io.Writer
	Getenv   func(string) string
	HTTP     *http.Client
	Now      func() time.Time
	LookPath func(string) (string, error)
	// RunGH runs the GitHub CLI and returns its standard output.
	RunGH func(ctx context.Context, path string, args []string, stderr io.Writer) ([]byte, error)
}

// NewApp wires App to the real process.
func NewApp(version string, stdin io.Reader, stdout, stderr io.Writer, getenv func(string) string) *App {
	return &App{
		Version:  version,
		Stdin:    stdin,
		Stdout:   stdout,
		Stderr:   stderr,
		Getenv:   getenv,
		HTTP:     &http.Client{Timeout: 30 * time.Second},
		Now:      time.Now,
		LookPath: exec.LookPath,
		RunGH: func(ctx context.Context, path string, args []string, stderr io.Writer) ([]byte, error) {
			cmd := exec.CommandContext(ctx, path, args...)
			cmd.Stderr = stderr
			return cmd.Output()
		},
	}
}

type invocation struct {
	parsedArgs
	format outputFormat
}

type command struct {
	path    string
	args    string
	minArgs int
	maxArgs int
	summary string
	long    string
	flags   []flagSpec
	run     func(ctx context.Context, a *App, in invocation) error
}

var commands []command

func init() {
	commands = []command{
		authLoginCommand,
		authStatusCommand,
		authLogoutCommand,
		profilesListCommand,
		workersListCommand,
		workersAddCommand,
		jobsListCommand,
		jobsViewCommand,
		jobsLogsCommand,
		versionCommand,
	}
}

// Read "jobs" as what an operator calls them; each row is one Attempt, an
// execution of one GitHub job in one disposable boundary. `attempts` is
// accepted for the domain term.
var groupAliases = map[string]string{"attempts": "jobs"}

const topHelp = `erainfra reads an EraInfra fleet through the control plane's operator API.

Usage:
  erainfra <command> <subcommand> [flags]

Commands:
%s
Global flags:
  --format table|json   output format (default table); json is a stable shape for scripts
  --json                same as --format json
  -h, --help            show help for any command

Environment:
  ERAINFRA_URL, ERAINFRA_TOKEN   use these instead of the stored login (set both or neither)
  XDG_CONFIG_HOME                where the login is stored (default ~/.config/erainfra/config.json)

Exit codes:
  0 success, 1 the request failed, 2 usage error, 4 not logged in or token refused

Create an API token in the dashboard (Machines, API tokens), then:
  erainfra auth login --url https://<deployment>.convex.site --token <token>
`

func commandList() string {
	var b strings.Builder
	tw := newTable(&b)
	for _, c := range commands {
		usage := c.path
		if c.args != "" {
			usage += " " + c.args
		}
		row(tw, "  "+usage, c.summary)
	}
	_ = tw.Flush()
	return b.String()
}

func (c command) help() string {
	var b strings.Builder
	usage := "erainfra " + c.path
	if c.args != "" {
		usage += " " + c.args
	}
	fmt.Fprintf(&b, "%s\n\nUsage:\n  %s [flags]\n", c.summary, usage)
	if c.long != "" {
		fmt.Fprintf(&b, "\n%s\n", strings.TrimSpace(c.long))
	}
	b.WriteString("\nFlags:\n")
	tw := newTable(&b)
	for _, spec := range append(append([]flagSpec{}, c.flags...), globalFlags...) {
		name := "  --" + spec.name
		if spec.metavar != "" {
			name += " " + spec.metavar
		}
		row(tw, name, spec.usage)
	}
	_ = tw.Flush()
	return b.String()
}

// Run executes one command line and returns the process exit code.
func (a *App) Run(ctx context.Context, argv []string) int {
	if len(argv) == 0 {
		_, _ = fmt.Fprintf(a.Stderr, topHelp, commandList())
		return ExitUsage
	}
	switch argv[0] {
	case "-h", "--help", "help":
		_, _ = fmt.Fprintf(a.Stdout, topHelp, commandList())
		return ExitOK
	case "--version":
		argv = []string{"version"}
	}
	if argv[0] == "worker" {
		// Reserved for the Worker-local tool's rename (ADR 0011), so it cannot
		// quietly come to mean something else here first.
		_, _ = fmt.Fprintln(a.Stderr, "erainfra: `erainfra worker` is reserved for Worker-local commands, "+
			"which are `rc <command>` on the Worker for now. For the fleet, use `erainfra workers list`.")
		return ExitUsage
	}
	if alias, ok := groupAliases[argv[0]]; ok {
		argv = append([]string{alias}, argv[1:]...)
	}

	cmd, rest, found := findCommand(argv)
	if !found {
		group := groupCommands(argv[0])
		if len(group) == 0 {
			_, _ = fmt.Fprintf(a.Stderr, "erainfra: unknown command %q\n\n", argv[0])
			_, _ = fmt.Fprintf(a.Stderr, topHelp, commandList())
			return ExitUsage
		}
		wantsHelp := len(argv) > 1 && (argv[1] == "-h" || argv[1] == "--help")
		out, code := a.Stderr, ExitUsage
		if wantsHelp {
			out, code = a.Stdout, ExitOK
		} else if len(argv) > 1 {
			_, _ = fmt.Fprintf(a.Stderr, "erainfra: unknown command %q\n\n", argv[0]+" "+argv[1])
		}
		_, _ = fmt.Fprintf(out, "Usage: erainfra %s <subcommand>\n\nSubcommands:\n", argv[0])
		tw := newTable(out)
		for _, c := range group {
			row(tw, "  "+strings.TrimPrefix(c.path, argv[0]+" ")+" "+c.args, c.summary)
		}
		_ = tw.Flush()
		return code
	}

	parsed, err := parseArgs(rest, cmd.flags)
	if err == nil && parsed.bools["help"] {
		_, _ = fmt.Fprint(a.Stdout, cmd.help())
		return ExitOK
	}
	var format outputFormat
	if err == nil {
		format, err = resolveFormat(parsed)
	}
	if err == nil && (len(parsed.args) < cmd.minArgs || len(parsed.args) > cmd.maxArgs) {
		if cmd.args == "" {
			err = usagef("erainfra %s takes no arguments", cmd.path)
		} else {
			err = usagef("usage: erainfra %s %s", cmd.path, cmd.args)
		}
	}
	if err == nil {
		err = cmd.run(ctx, a, invocation{parsed, format})
	}
	return a.report(err, cmd)
}

func (a *App) report(err error, cmd command) int {
	if err == nil {
		return ExitOK
	}
	var usage *usageError
	var failure *apiError
	switch {
	case errors.As(err, &usage):
		_, _ = fmt.Fprintf(a.Stderr, "erainfra: %s\nRun `erainfra %s --help` for usage.\n", usage.message, cmd.path)
		return ExitUsage
	case isAuthFailure(err):
		_, _ = fmt.Fprintf(a.Stderr, "erainfra: %s\n", err)
		return ExitAuth
	case errors.As(err, &failure) && failure.Status == http.StatusBadRequest:
		// The server validates filters; its refusal is a usage error too.
		_, _ = fmt.Fprintf(a.Stderr, "erainfra: %s\n", err)
		return ExitUsage
	}
	_, _ = fmt.Fprintf(a.Stderr, "erainfra: %s\n", err)
	return ExitError
}

func findCommand(argv []string) (command, []string, bool) {
	for _, c := range commands {
		words := strings.Fields(c.path)
		if len(argv) >= len(words) && strings.Join(argv[:len(words)], " ") == c.path {
			return c, argv[len(words):], true
		}
	}
	return command{}, nil, false
}

func groupCommands(group string) []command {
	var out []command
	for _, c := range commands {
		if strings.HasPrefix(c.path, group+" ") {
			out = append(out, c)
		}
	}
	return out
}

// connect loads the stored login (or the environment) and returns a client.
func (a *App) connect() (*client, credentials, error) {
	creds, err := loadCredentials(a.Getenv)
	if err != nil {
		return nil, creds, err
	}
	return a.clientFor(creds.Config), creds, nil
}

func (a *App) clientFor(cfg Config) *client {
	return &client{http: a.HTTP, base: cfg.URL, token: cfg.Token, userAgent: "erainfra-cli/" + a.Version}
}

var versionCommand = command{
	path:    "version",
	summary: "Print the CLI version",
	run: func(_ context.Context, a *App, in invocation) error {
		if in.format == formatJSON {
			return writeJSON(a.Stdout, map[string]string{"version": a.Version})
		}
		_, err := fmt.Fprintf(a.Stdout, "erainfra %s\n", a.Version)
		return err
	},
}
