package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/Fanzzzd/erainfra/apps/cache-service/cachetoken"
	"github.com/Fanzzzd/erainfra/apps/cache-service/internal/adminapi"
)

// The admin subcommand is an operator's view of the cache: what a repository
// holds, and deleting some or all of it. The verbs and flags are Blacksmith's
// (`blacksmith cache list|delete|clear`), so the commands read the same to
// someone who has used it, and the output defaults to JSON as Blacksmith's does,
// so a script can depend on it.
const adminUsage = `usage: erainfra-cache-service admin <command> [flags]

commands:
  list    --repo owner/name [--prefix p] [--search s] [--ref r] [--version v]
          [--sort-by last_used_at|created_at|size|key|version|ref]
          [--sort-direction desc|asc] [--page n] [--per-page n] [--format json|table]
  delete  --repo owner/name (--key k | --prefix p) [--version v] [--ref r] [--yes] [--format json|table]
  clear   --repo owner/name [--yes] [--format json|table]

every command:
  --url       the cache service (default $ERAINFRA_CACHE_ADMIN_URL, else http://127.0.0.1 on
              the port in $ERAINFRA_CACHE_LISTEN, else http://127.0.0.1:8721)
  --key-file  the signing key (default $ERAINFRA_CACHE_SIGNING_KEY_FILE, else
              $ERAINFRA_CACHE_SIGNING_KEY)

delete and clear ask before deleting when stdin is a terminal, and refuse
without --yes when it is not.
`

// adminEnv is what the subcommand reads from its surroundings, so a test can
// hand it a fake.
type adminEnv struct {
	getenv func(string) string
	stdin  io.Reader
	stdout io.Writer
	stderr io.Writer
	// interactive reports whether stdin is a terminal a human can answer.
	interactive bool
}

func osAdminEnv() adminEnv {
	interactive := false
	if info, err := os.Stdin.Stat(); err == nil {
		interactive = info.Mode()&os.ModeCharDevice != 0
	}
	return adminEnv{
		getenv: os.Getenv, stdin: os.Stdin, stdout: os.Stdout, stderr: os.Stderr,
		interactive: interactive,
	}
}

// errUsage is a mistake in the command line: exit 2, as flag does.
var errUsage = errors.New("usage")

func runAdmin(ctx context.Context, args []string, env adminEnv) int {
	if len(args) == 0 || args[0] == "-h" || args[0] == "--help" || args[0] == "help" {
		say(env.stderr, "%s", adminUsage)
		if len(args) == 0 {
			return 2
		}
		return 0
	}
	var err error
	switch args[0] {
	case "list":
		err = adminList(ctx, args[1:], env)
	case "delete":
		err = adminDelete(ctx, args[1:], env, false)
	case "clear":
		err = adminDelete(ctx, args[1:], env, true)
	default:
		say(env.stderr, "unknown admin command %q\n\n%s", args[0], adminUsage)
		return 2
	}
	switch {
	case err == nil:
		return 0
	case errors.Is(err, errUsage), errors.Is(err, flag.ErrHelp):
		return 2
	default:
		say(env.stderr, "error: %v\n", err)
		return 1
	}
}

type commonFlags struct {
	url     string
	keyFile string
	repo    string
	format  string
}

func newFlagSet(name string, env adminEnv, common *commonFlags) *flag.FlagSet {
	set := flag.NewFlagSet("admin "+name, flag.ContinueOnError)
	set.SetOutput(env.stderr)
	set.Usage = func() { say(env.stderr, "%s", adminUsage) }
	set.StringVar(&common.url, "url", "", "cache service base URL")
	set.StringVar(&common.keyFile, "key-file", "", "file holding the signing key")
	set.StringVar(&common.repo, "repo", "", "repository, owner/name")
	set.StringVar(&common.format, "format", "json", "json or table")
	return set
}

func (c commonFlags) validate(env adminEnv) error {
	if err := cachetoken.ValidateRepository(c.repo); err != nil {
		say(env.stderr, "--repo is required and must be owner/name\n")
		return errUsage
	}
	if c.format != "json" && c.format != "table" {
		say(env.stderr, "--format must be json or table\n")
		return errUsage
	}
	return nil
}

func (c commonFlags) client(env adminEnv) (*adminapi.Client, error) {
	base := c.url
	if base == "" {
		base = env.getenv("ERAINFRA_CACHE_ADMIN_URL")
	}
	if base == "" {
		base = "http://127.0.0.1:8721"
		if listen := strings.TrimSpace(env.getenv("ERAINFRA_CACHE_LISTEN")); listen != "" {
			if at := strings.LastIndex(listen, ":"); at >= 0 && at < len(listen)-1 {
				port := listen[at+1:]
				base = "http://127.0.0.1:" + port
			}
		}
	}
	key, err := c.signingKey(env)
	if err != nil {
		return nil, err
	}
	return &adminapi.Client{BaseURL: base, SigningKey: key}, nil
}

func (c commonFlags) signingKey(env adminEnv) ([]byte, error) {
	path := c.keyFile
	if path == "" {
		path = strings.TrimSpace(env.getenv("ERAINFRA_CACHE_SIGNING_KEY_FILE"))
	}
	var key []byte
	switch {
	case path != "":
		body, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("read the signing key: %w", err)
		}
		key = []byte(strings.TrimSpace(string(body)))
	case strings.TrimSpace(env.getenv("ERAINFRA_CACHE_SIGNING_KEY")) != "":
		key = []byte(strings.TrimSpace(env.getenv("ERAINFRA_CACHE_SIGNING_KEY")))
	default:
		return nil, errors.New("no signing key: pass --key-file or set ERAINFRA_CACHE_SIGNING_KEY_FILE")
	}
	if len(key) < adminapi.MinSigningKeyLen {
		return nil, fmt.Errorf("the signing key is shorter than %d bytes", adminapi.MinSigningKeyLen)
	}
	return key, nil
}

func adminList(ctx context.Context, args []string, env adminEnv) error {
	var common commonFlags
	var query adminapi.ListQuery
	set := newFlagSet("list", env, &common)
	set.StringVar(&query.Prefix, "prefix", "", "only keys that start with this")
	set.StringVar(&query.Search, "search", "", "only keys that contain this")
	set.StringVar(&query.Ref, "ref", "", "only entries saved under this ref, such as refs/heads/main")
	set.StringVar(&query.Ref, "scope", "", "the same as --ref")
	set.StringVar(&query.Version, "version", "", "only entries with this version")
	set.StringVar(&query.SortBy, "sort-by", "last_used_at", "sort column")
	set.StringVar(&query.SortDirection, "sort-direction", "desc", "desc or asc")
	set.IntVar(&query.Page, "page", 1, "page, from 1")
	set.IntVar(&query.PerPage, "per-page", 50, "entries per page, 1 to 100")
	if err := parseFlags(set, args); err != nil {
		return err
	}
	if err := extraArgs(set, env); err != nil {
		return err
	}
	if err := common.validate(env); err != nil {
		return err
	}
	query.Repository = common.repo
	client, err := common.client(env)
	if err != nil {
		return err
	}
	response, err := client.List(ctx, query)
	if err != nil {
		return err
	}
	if common.format == "json" {
		return writeJSONOut(env.stdout, response)
	}
	table := tabwriter.NewWriter(env.stdout, 0, 4, 2, ' ', 0)
	say(table, "KEY\tVERSION\tREF\tSIZE\tLAST USED\tCREATED\n")
	for _, entry := range response.Entries {
		say(table, "%s\t%s\t%s\t%s\t%s\t%s\n", entry.Key, shortVersion(entry.Version), entry.Ref,
			humanBytes(entry.SizeInBytes), entry.LastAccessedAt.Format(time.RFC3339),
			entry.CreatedAt.Format(time.RFC3339))
	}
	if err := table.Flush(); err != nil {
		return err
	}
	say(env.stdout, "\n%d of %d entries (page %d), %s in total\n",
		len(response.Entries), response.TotalCount, response.Page, humanBytes(response.TotalBytes))
	return nil
}

func adminDelete(ctx context.Context, args []string, env adminEnv, clear bool) error {
	var common commonFlags
	var query adminapi.DeleteQuery
	var yes bool
	name := "delete"
	if clear {
		name = "clear"
	}
	set := newFlagSet(name, env, &common)
	set.BoolVar(&yes, "yes", false, "do not ask before deleting")
	if !clear {
		set.StringVar(&query.Key, "key", "", "exact cache key to delete")
		set.StringVar(&query.Prefix, "prefix", "", "delete every key that starts with this")
		set.StringVar(&query.Version, "version", "", "only this version")
		set.StringVar(&query.Ref, "ref", "", "only entries saved under this ref")
		set.StringVar(&query.Ref, "scope", "", "the same as --ref")
	}
	if err := parseFlags(set, args); err != nil {
		return err
	}
	if err := extraArgs(set, env); err != nil {
		return err
	}
	if err := common.validate(env); err != nil {
		return err
	}
	query.Repository = common.repo
	query.All = clear
	if !clear && (query.Key == "") == (query.Prefix == "") {
		say(env.stderr, "delete needs exactly one of --key or --prefix; use clear for everything\n")
		return errUsage
	}

	what := "every cache entry in " + common.repo
	switch {
	case query.Key != "":
		what = fmt.Sprintf("cache entries with key %q in %s", query.Key, common.repo)
	case query.Prefix != "":
		what = fmt.Sprintf("cache entries with keys starting %q in %s", query.Prefix, common.repo)
	}
	if query.Version != "" {
		what += ", version " + query.Version
	}
	if query.Ref != "" {
		what += ", ref " + query.Ref
	}
	if !yes {
		if !env.interactive {
			say(env.stderr, "refusing to delete %s without --yes: stdin is not a terminal\n", what)
			return errUsage
		}
		say(env.stderr, "Delete %s? [y/N] ", what)
		answer, _ := bufio.NewReader(env.stdin).ReadString('\n')
		if a := strings.ToLower(strings.TrimSpace(answer)); a != "y" && a != "yes" {
			say(env.stderr, "nothing deleted\n")
			return nil
		}
	}

	client, err := common.client(env)
	if err != nil {
		return err
	}
	response, err := client.Delete(ctx, query)
	if err != nil {
		return err
	}
	if common.format == "json" {
		return writeJSONOut(env.stdout, response)
	}
	say(env.stdout, "deleted %d entries (%s) from %s\n",
		response.DeletedCount, humanBytes(response.DeletedBytes), response.Repository)
	return nil
}

// say writes human-facing text. A terminal or pipe that cannot take it has no
// better place to report that, so the write error is dropped deliberately.
func say(w io.Writer, format string, args ...any) {
	_, _ = fmt.Fprintf(w, format, args...)
}

func extraArgs(set *flag.FlagSet, env adminEnv) error {
	if set.NArg() > 0 {
		say(env.stderr, "unexpected argument %q; every value is a flag\n", set.Arg(0))
		return errUsage
	}
	return nil
}

// parseFlags turns any flag error into a usage error. flag has already printed
// the reason and the usage text.
func parseFlags(set *flag.FlagSet, args []string) error {
	if err := set.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return err
		}
		return errUsage
	}
	return nil
}

func writeJSONOut(w io.Writer, value any) error {
	encoder := json.NewEncoder(w)
	encoder.SetIndent("", "  ")
	return encoder.Encode(value)
}

// shortVersion keeps a table readable: versions are 64-character hashes.
func shortVersion(version string) string {
	if len(version) > 12 {
		return version[:12]
	}
	return version
}

func humanBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	value, suffix := float64(n), ""
	for _, s := range []string{"KiB", "MiB", "GiB", "TiB"} {
		value /= unit
		suffix = s
		if value < unit {
			break
		}
	}
	return fmt.Sprintf("%.1f %s", value, suffix)
}
