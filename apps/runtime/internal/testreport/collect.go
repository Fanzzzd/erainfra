package testreport

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"time"
)

// Bounds on collection inside the guest. They keep a workspace built to stall
// the VM's teardown from doing so: the walk, the reads and the parse all stop
// at a bound and the report says it was truncated.
const (
	// MaxFiles is how many JUnit files one Attempt's report is built from.
	MaxFiles = 200
	// MaxFileBytes is the largest file parsed; a bigger one is skipped.
	MaxFileBytes = 16 << 20
	// MaxTotalBytes bounds the bytes parsed across every file.
	MaxTotalBytes = 128 << 20
	// MaxWalkEntries bounds how many directory entries the walk visits.
	MaxWalkEntries = 200_000
	// MaxParsedCases bounds the cases parsed across every file, before they
	// are merged by id.
	MaxParsedCases = 200_000
	// MaxPatterns and MaxPatternBytes bound a repository's own globs.
	MaxPatterns     = 32
	MaxPatternBytes = 256
	// DefaultBudget is how long collection may take before it reports what
	// it has.
	DefaultBudget = 20 * time.Second
)

// DefaultPatterns are the paths test runners write JUnit XML to by default
// or by the convention their documentation shows, relative to a workspace.
var DefaultPatterns = []string{
	"**/junit*.xml",             // jest-junit's default, and the name most docs use
	"**/TEST-*.xml",             // Maven Surefire and Failsafe, Gradle, Ant
	"**/test-results/**/*.xml",  // Gradle's build/test-results and common CI layouts
	"**/test-reports/**/*.xml",  // the other common directory name
	"**/*.junit.xml",            // explicit names such as report.junit.xml
	"**/surefire-reports/*.xml", // Surefire with a custom file name
	"**/failsafe-reports/*.xml", // Failsafe with a custom file name
}

// ConfigFile is where a repository lists more globs, one per line, relative
// to its workspace. Lines starting with # are comments. The globs add to
// DefaultPatterns; they never replace them.
const ConfigFile = ".github/erainfra-test-reports"

// skippedDirectories are never walked. Each holds files a repository did not
// produce by running its tests: version control, dependencies, and test
// fixtures, which in a repository that tests a JUnit parser are JUnit files.
var skippedDirectories = map[string]bool{
	".git":             true,
	"node_modules":     true,
	"testdata":         true,
	"__fixtures__":     true,
	"vendor":           true,
	".venv":            true,
	".pnpm-store":      true,
	".gradle":          true,
	".m2":              true,
	"bower_components": true,
}

// Collector builds an Attempt's report from the runner's work directory.
type Collector struct {
	// WorkDir is the runner's _work directory. Every workspace is two levels
	// below it (_work/<repository>/<repository>); the runner's own
	// directories start with an underscore and are not searched.
	WorkDir string
	// Budget bounds the whole collection; zero means DefaultBudget.
	Budget time.Duration
}

type collection struct {
	ctx        context.Context
	files      []string
	entries    int
	bytes      int64
	parsed     int
	truncated  bool
	commit     string
	parsedCase []parsedCase
}

// Collect walks every workspace, parses the JUnit files it finds and returns
// the report, or nil when there were none. An error means the walk itself
// could not start; a file that will not parse is skipped.
func (c Collector) Collect(ctx context.Context) (*Report, error) {
	budget := c.Budget
	if budget <= 0 {
		budget = DefaultBudget
	}
	ctx, cancel := context.WithTimeout(ctx, budget)
	defer cancel()
	workspaces, err := workspaces(c.WorkDir)
	if err != nil {
		return nil, err
	}
	state := &collection{ctx: ctx}
	for _, workspace := range workspaces {
		patterns := append(slices.Clone(DefaultPatterns), repositoryPatterns(workspace)...)
		before := len(state.files)
		state.walk(workspace, patterns)
		if len(state.files) > before && state.commit == "" {
			state.commit = readCommit(workspace)
		}
	}
	sort.Strings(state.files)
	parsedFiles := 0
	for _, file := range state.files {
		if ctx.Err() != nil {
			state.truncated = true
			break
		}
		if state.parseFile(file) {
			parsedFiles++
		}
	}
	if parsedFiles == 0 {
		return nil, nil
	}
	report := Build(state.parsedCase)
	report.CommitSHA = state.commit
	report.Files = parsedFiles
	report.Truncated = report.Truncated || state.truncated
	return report, nil
}

func workspaces(workDir string) ([]string, error) {
	repositories, err := os.ReadDir(workDir)
	if err != nil {
		return nil, fmt.Errorf("read runner work directory: %w", err)
	}
	var found []string
	for _, repository := range repositories {
		if !repository.IsDir() || strings.HasPrefix(repository.Name(), "_") {
			continue
		}
		parent := filepath.Join(workDir, repository.Name())
		checkouts, err := os.ReadDir(parent)
		if err != nil {
			continue
		}
		for _, checkout := range checkouts {
			if checkout.IsDir() {
				found = append(found, filepath.Join(parent, checkout.Name()))
			}
		}
	}
	return found, nil
}

// repositoryPatterns reads ConfigFile from a workspace. Bad lines are
// dropped rather than failing collection.
func repositoryPatterns(workspace string) []string {
	file, err := openRegular(filepath.Join(workspace, ConfigFile))
	if err != nil {
		return nil
	}
	defer file.Close() //nolint:errcheck // read-only file; a close error loses nothing
	scanner := bufio.NewScanner(io.LimitReader(file, 64<<10))
	var patterns []string
	for scanner.Scan() && len(patterns) < MaxPatterns {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") || len(line) > MaxPatternBytes {
			continue
		}
		if validPattern(line) {
			patterns = append(patterns, line)
		}
	}
	return patterns
}

// validPattern accepts a relative slash-separated glob that path.Match can
// read, that cannot climb out of the workspace, and that has at most four **
// (each one multiplies the matcher's work by the path depth).
func validPattern(pattern string) bool {
	if strings.HasPrefix(pattern, "/") || strings.Contains(pattern, "\\") {
		return false
	}
	stars := 0
	for _, segment := range strings.Split(pattern, "/") {
		if segment == ".." || segment == "" {
			return false
		}
		if segment == "**" {
			if stars++; stars > 4 {
				return false
			}
		} else {
			if _, err := path.Match(segment, ""); err != nil {
				return false
			}
		}
	}
	return true
}

func (state *collection) walk(workspace string, patterns []string) {
	_ = filepath.WalkDir(workspace, func(file string, entry fs.DirEntry, err error) error {
		if state.ctx.Err() != nil || state.entries >= MaxWalkEntries {
			state.truncated = true
			return fs.SkipAll
		}
		state.entries++
		if err != nil {
			if entry != nil && entry.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if entry.IsDir() {
			if file != workspace && skippedDirectories[entry.Name()] {
				return fs.SkipDir
			}
			return nil
		}
		// WalkDir never follows a symbolic link to a directory; a link to a
		// file is not followed either, so nothing outside the workspace is read.
		if !entry.Type().IsRegular() {
			return nil
		}
		relative, err := filepath.Rel(workspace, file)
		if err != nil {
			return nil
		}
		relative = filepath.ToSlash(relative)
		for _, pattern := range patterns {
			if MatchPattern(pattern, relative) {
				if len(state.files) >= MaxFiles {
					state.truncated = true
					return fs.SkipAll
				}
				state.files = append(state.files, file)
				break
			}
		}
		return nil
	})
}

// parseFile reports whether the file was a JUnit document.
func (state *collection) parseFile(file string) bool {
	handle, err := openRegular(file)
	if err != nil {
		return false
	}
	defer handle.Close() //nolint:errcheck // read-only file; a close error loses nothing
	info, err := handle.Stat()
	if err != nil || info.Size() > MaxFileBytes {
		state.truncated = state.truncated || err == nil
		return false
	}
	if state.bytes+info.Size() > MaxTotalBytes {
		state.truncated = true
		return false
	}
	state.bytes += info.Size()
	remaining := MaxParsedCases - state.parsed
	if remaining <= 0 {
		state.truncated = true
		return false
	}
	cases, cut, err := ParseJUnit(io.LimitReader(handle, MaxFileBytes), remaining)
	if err != nil {
		return false
	}
	state.truncated = state.truncated || cut
	state.parsed += len(cases)
	state.parsedCase = append(state.parsedCase, cases...)
	return true
}

// MatchPattern reports whether a slash-separated relative path matches a glob
// in which ** stands for any number of directories, including none, and every
// other segment is a path.Match pattern.
func MatchPattern(pattern, name string) bool {
	return matchSegments(strings.Split(pattern, "/"), strings.Split(name, "/"))
}

func matchSegments(pattern, name []string) bool {
	for len(pattern) > 0 {
		if pattern[0] == "**" {
			// Collapse repeated ** and try every split point.
			for len(pattern) > 0 && pattern[0] == "**" {
				pattern = pattern[1:]
			}
			if len(pattern) == 0 {
				return true
			}
			for skip := 0; skip <= len(name); skip++ {
				if matchSegments(pattern, name[skip:]) {
					return true
				}
			}
			return false
		}
		if len(name) == 0 {
			return false
		}
		matched, err := path.Match(pattern[0], name[0])
		if err != nil || !matched {
			return false
		}
		pattern, name = pattern[1:], name[1:]
	}
	return len(name) == 0
}

// readCommit reads the commit a workspace has checked out from its .git
// directory, or returns empty. actions/checkout leaves either a detached HEAD
// holding the id or a symbolic ref to a branch file or packed-refs line.
func readCommit(workspace string) string {
	gitDir := filepath.Join(workspace, ".git")
	head, err := readSmall(filepath.Join(gitDir, "HEAD"), 4<<10)
	if err != nil {
		return ""
	}
	value := strings.TrimSpace(head)
	if commitPattern.MatchString(value) {
		return value
	}
	ref, ok := strings.CutPrefix(value, "ref: ")
	if !ok || !strings.HasPrefix(ref, "refs/") || strings.Contains(ref, "..") {
		return ""
	}
	if loose, err := readSmall(filepath.Join(gitDir, filepath.FromSlash(ref)), 4<<10); err == nil {
		if id := strings.TrimSpace(loose); commitPattern.MatchString(id) {
			return id
		}
	}
	packed, err := readSmall(filepath.Join(gitDir, "packed-refs"), 4<<20)
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(packed, "\n") {
		id, name, found := strings.Cut(strings.TrimSpace(line), " ")
		if found && name == ref && commitPattern.MatchString(id) {
			return id
		}
	}
	return ""
}

func readSmall(file string, limit int64) (string, error) {
	handle, err := openRegular(file)
	if err != nil {
		return "", err
	}
	defer handle.Close() //nolint:errcheck // read-only file; a close error loses nothing
	payload, err := io.ReadAll(io.LimitReader(handle, limit+1))
	if err != nil {
		return "", err
	}
	if int64(len(payload)) > limit {
		return "", errors.New("file is larger than expected")
	}
	return string(payload), nil
}

// openRegular opens a file for reading without following a final symbolic
// link and refuses anything that is not a regular file, so a FIFO or device
// planted under a report path cannot block or feed the collector.
func openRegular(file string) (*os.File, error) {
	handle, err := openNoFollow(file)
	if err != nil {
		return nil, err
	}
	info, err := handle.Stat()
	if err != nil {
		_ = handle.Close()
		return nil, err
	}
	if !info.Mode().IsRegular() {
		_ = handle.Close()
		return nil, fmt.Errorf("%s is not a regular file", file)
	}
	return handle, nil
}
