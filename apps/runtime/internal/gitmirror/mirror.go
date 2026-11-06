package gitmirror

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
)

// headsAndTags is what a mirror holds and a seed carries. Pull request refs
// are left out on purpose: a busy repository has thousands of them, and a
// pull request's merge commit is fetched by object when a job wants it, as a
// delta over the branches the mirror already has.
var headsAndTags = []string{"+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*"}

// mirror is a bare repository in the guest, filled from the job's seed and
// then from GitHub. Every git process it runs reads no system or user
// configuration, so the proxy setting the guest writes for the job's git
// (which points at this package's own proxy) can never loop a mirror fetch
// back into itself, and nothing a job puts in ~/.gitconfig reaches it.
type mirror struct {
	git  string
	dir  string
	home string
}

// gitCommand builds one git invocation against the mirror. config is passed
// through GIT_CONFIG_COUNT rather than -c so that a credential in it (the
// client's Authorization header) is never on a command line, where any
// process in the guest could read it from /proc.
func (m *mirror) gitCommand(ctx context.Context, config map[string]string, args ...string) *exec.Cmd {
	command := exec.CommandContext(ctx, m.git, append([]string{"-C", m.dir}, args...)...)
	env := []string{
		"PATH=" + os.Getenv("PATH"),
		"HOME=" + m.home,
		"LC_ALL=C",
		"GIT_CONFIG_NOSYSTEM=1",
		"GIT_CONFIG_GLOBAL=" + os.DevNull,
		"GIT_TERMINAL_PROMPT=0",
	}
	keys := make([]string, 0, len(config))
	for key := range config {
		keys = append(keys, key)
	}
	// Sorted so the environment, and so a test's view of it, is stable.
	slices.Sort(keys)
	env = append(env, "GIT_CONFIG_COUNT="+strconv.Itoa(len(keys)))
	for index, key := range keys {
		env = append(env,
			"GIT_CONFIG_KEY_"+strconv.Itoa(index)+"="+key,
			"GIT_CONFIG_VALUE_"+strconv.Itoa(index)+"="+config[key],
		)
	}
	command.Env = env
	return command
}

func (m *mirror) run(ctx context.Context, config map[string]string, args ...string) error {
	command := m.gitCommand(ctx, config, args...)
	var stderr bytes.Buffer
	command.Stderr = &stderr
	if err := command.Run(); err != nil {
		return fmt.Errorf("git %s: %w: %s", args[0], err, strings.TrimSpace(lastLines(stderr.String(), 3)))
	}
	return nil
}

// create makes the empty bare repository. The upload-pack settings are what
// let it answer a client the way GitHub does: a want by object name (which is
// how actions/checkout asks for a commit), and a partial clone's filter.
// Automatic gc is off because it would compete with the job for CPU and the
// mirror dies with the guest anyway.
func (m *mirror) create(ctx context.Context) error {
	if err := os.MkdirAll(m.dir, 0o700); err != nil {
		return err
	}
	if err := os.MkdirAll(m.home, 0o700); err != nil {
		return err
	}
	if err := m.run(ctx, nil, "init", "--quiet", "--bare"); err != nil {
		return err
	}
	for _, setting := range [][2]string{
		{"uploadpack.allowAnySHA1InWant", "true"},
		{"uploadpack.allowFilter", "true"},
		{"gc.auto", "0"},
		{"core.logAllRefUpdates", "false"},
	} {
		if err := m.run(ctx, nil, "config", setting[0], setting[1]); err != nil {
			return err
		}
	}
	return nil
}

// restore imports a seed bundle. Fetching from a bundle runs index-pack, which
// computes every object's name from its content, and then checks that every
// ref's history is complete. So a seed some earlier job of the same repository
// wrote cannot plant an object under another object's name, and a truncated or
// hostile bundle fails here, leaving the job to fetch from GitHub alone.
func (m *mirror) restore(ctx context.Context, bundle string) error {
	return m.run(ctx, nil, append([]string{"fetch", "--quiet", "--no-write-fetch-head", bundle}, headsAndTags...)...)
}

// upstreamConfig is the configuration every fetch from GitHub runs with: the
// client's own credential, if it sent one, and protocol v2.
func upstreamConfig(authorization string) map[string]string {
	config := map[string]string{"protocol.version": "2"}
	if authorization != "" {
		config["http.extraHeader"] = "Authorization: " + authorization
	}
	return config
}

// fetchObjects fetches the named objects from upstream into the mirror. Git
// sends every ref the mirror holds as a "have", so GitHub sends only what the
// mirror lacks.
//
// depth is the client's own: a depth-1 checkout makes the mirror fetch the
// wanted commit at depth 1 too, so GitHub sends the objects of that one tree
// that the seed lacks, not every commit pushed since the seed. That leaves the
// mirror shallow at the new commit, which serves the client exactly as GitHub
// would. A client that wants whole history (depth 0) on a shallow mirror makes
// the mirror unshallow first, so it never answers with less history than was
// asked for.
func (m *mirror) fetchObjects(ctx context.Context, upstream, authorization string, oids []string, depth int) error {
	args := []string{"fetch", "--quiet", "--no-tags", "--no-write-fetch-head"}
	switch {
	case depth > 0:
		args = append(args, "--depth="+strconv.Itoa(depth))
	case m.shallow():
		args = append(args, "--unshallow")
	}
	args = append(append(args, upstream), oids...)
	return m.run(ctx, upstreamConfig(authorization), args...)
}

// syncTags makes the mirror's tags exactly GitHub's: every tag GitHub has, at
// the object GitHub has it at, and none it has deleted. That is what lets the
// mirror answer "include-tag", which adds whichever annotated tags point at the
// objects sent, as GitHub would. The caller runs it only on a mirror that holds
// whole history, so no tag is refused for needing a new shallow boundary.
func (m *mirror) syncTags(ctx context.Context, upstream, authorization string) error {
	return m.run(ctx, upstreamConfig(authorization),
		"fetch", "--quiet", "--prune", "--no-tags", "--no-write-fetch-head", upstream, "+refs/tags/*:refs/tags/*")
}

// shallow reports whether an earlier depth-limited fetch left commits in the
// mirror whose parents it does not have.
func (m *mirror) shallow() bool {
	info, err := os.Stat(filepath.Join(m.dir, "shallow"))
	return err == nil && info.Size() > 0
}

// refresh brings the mirror's branches and tags up to date with upstream,
// with whole history: a seed is only useful complete, and importing one checks
// that it is.
func (m *mirror) refresh(ctx context.Context, upstream, authorization string) error {
	args := []string{"fetch", "--quiet", "--prune", "--no-write-fetch-head"}
	if m.shallow() {
		args = append(args, "--unshallow")
	}
	args = append(append(args, upstream), headsAndTags...)
	return m.run(ctx, upstreamConfig(authorization), args...)
}

// bundle writes the mirror's branches and tags to a bundle file.
func (m *mirror) bundle(ctx context.Context, path string) error {
	return m.run(ctx, nil, "bundle", "create", path, "--branches", "--tags")
}

// missing returns the objects in oids the mirror does not have.
func (m *mirror) missing(ctx context.Context, oids []string) ([]string, error) {
	command := m.gitCommand(ctx, nil, "cat-file", "--batch-check")
	command.Stdin = strings.NewReader(strings.Join(oids, "\n") + "\n")
	output, err := command.Output()
	if err != nil {
		return nil, fmt.Errorf("git cat-file: %w", err)
	}
	var absent []string
	scanner := bufio.NewScanner(bytes.NewReader(output))
	for scanner.Scan() {
		if oid, ok := strings.CutSuffix(scanner.Text(), " missing"); ok {
			absent = append(absent, oid)
		}
	}
	return absent, scanner.Err()
}

// errNoAnswer is upload-pack failing before it wrote a byte, which leaves the
// whole response free for GitHub to give instead.
var errNoAnswer = errors.New("gitmirror: upload-pack gave no answer")

// uploadPack answers one stateless protocol v2 request from the mirror, the
// way git-http-backend does. begin is called once, with the first output
// already in hand, to commit the response; before that point a failure
// returns errNoAnswer and nothing has been written.
func (m *mirror) uploadPack(ctx context.Context, request []byte, begin func() io.Writer) error {
	command := m.gitCommand(ctx, nil, "upload-pack", "--stateless-rpc", ".")
	command.Env = append(command.Env, "GIT_PROTOCOL=version=2")
	command.Stdin = bytes.NewReader(request)
	var stderr bytes.Buffer
	command.Stderr = &stderr
	stdout, err := command.StdoutPipe()
	if err != nil {
		return err
	}
	if err := command.Start(); err != nil {
		return err
	}
	output := bufio.NewReaderSize(stdout, 64<<10)
	if _, err := output.Peek(1); err != nil {
		waitErr := command.Wait()
		return fmt.Errorf("%w: %v %s", errNoAnswer, waitErr, strings.TrimSpace(lastLines(stderr.String(), 3)))
	}
	_, copyErr := io.Copy(begin(), output)
	waitErr := command.Wait()
	if copyErr != nil {
		return copyErr
	}
	if waitErr != nil {
		return fmt.Errorf("git upload-pack: %w: %s", waitErr, strings.TrimSpace(lastLines(stderr.String(), 3)))
	}
	return nil
}

func lastLines(text string, n int) string {
	lines := strings.Split(strings.TrimSpace(text), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, " | ")
}
