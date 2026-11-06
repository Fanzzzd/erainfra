// Package testreport turns the JUnit XML files a CI job leaves in its
// workspace into one bounded, per-Attempt test report.
//
// Everything this package reads is written by the job, so all of it is
// untrusted: the XML, the file tree around it, and the report the guest hands
// the host. The guest parses (a hostile file can only hurt the VM that made
// it), and every reader after it -- the runtime on the host, then the control
// plane -- validates the decoded report against the same bounds instead of
// trusting the producer.
package testreport

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"
)

// Version is the report format. A reader refuses any other value.
const Version = 1

// Bounds on one report. The control plane enforces the same numbers
// (packages/backend/convex/testReportsModel.ts); change both together.
const (
	// MaxCases is how many individual cases a report carries: every failed,
	// errored and flaky case first, then the slowest passes.
	MaxCases = 500
	// MaxSlowest is how many passing cases are kept for their duration.
	MaxSlowest = 50
	// MaxPassed is how many passing test ids are carried as hashes, which is
	// what lets a later Attempt of the same commit say "this passed before".
	MaxPassed = 20_000
	// MaxIDBytes, MaxNameBytes and MaxMessageBytes bound each string.
	MaxIDBytes      = 512
	MaxNameBytes    = 512
	MaxMessageBytes = 1024
	// MaxTotal bounds every counter so a sum of them cannot overflow anywhere.
	MaxTotal = 10_000_000
	// MaxDurationMs is one week; a longer time attribute is a broken file.
	MaxDurationMs = 7 * 24 * 60 * 60 * 1000
)

// PassedHashLength is the number of hex characters of SHA-256 kept per
// passing test id. 48 bits put the chance of any collision among 20,000 ids
// near one in a billion, and a collision can only hide one flaky signal.
const PassedHashLength = 12

// Status is one test case's outcome in an Attempt.
type Status string

const (
	StatusPassed  Status = "passed"
	StatusFailed  Status = "failed"
	StatusErrored Status = "errored"
	StatusSkipped Status = "skipped"
	// StatusFlaky is a case that failed and then passed inside the same
	// Attempt: a retry the test runner itself made (Maven Surefire's
	// flakyFailure, gotestsum --rerun-fails, a repeated testcase).
	StatusFlaky Status = "flaky"
)

func (s Status) valid() bool {
	switch s {
	case StatusPassed, StatusFailed, StatusErrored, StatusSkipped, StatusFlaky:
		return true
	}
	return false
}

// Case is one test case as the report carries it.
type Case struct {
	ID         string `json:"id"`
	Suite      string `json:"suite,omitempty"`
	Name       string `json:"name"`
	File       string `json:"file,omitempty"`
	Status     Status `json:"status"`
	DurationMs int64  `json:"durationMs"`
	Message    string `json:"message,omitempty"`
	// Retries counts the failed runs a flaky case needed before it passed.
	Retries int `json:"retries,omitempty"`
}

// Totals counts every case found, including the ones the report does not
// list individually.
type Totals struct {
	Tests      int   `json:"tests"`
	Passed     int   `json:"passed"`
	Failed     int   `json:"failed"`
	Errored    int   `json:"errored"`
	Skipped    int   `json:"skipped"`
	Flaky      int   `json:"flaky"`
	DurationMs int64 `json:"durationMs"`
}

// Report is one Attempt's test results.
type Report struct {
	Version int `json:"version"`
	// CommitSHA is the commit the workspace had checked out, read from its
	// .git directory, or empty. It is what joins two Attempts of one commit.
	CommitSHA string `json:"commitSha,omitempty"`
	// Files is how many JUnit files were parsed.
	Files int `json:"files"`
	// Truncated says a bound cut something: files, cases or passed ids.
	Truncated bool   `json:"truncated"`
	Totals    Totals `json:"totals"`
	Cases     []Case `json:"cases"`
	// Passed is PassedHash of every passing test id, sorted, unique and
	// concatenated, PassedHashLength hex characters each. One string rather
	// than an array: the control plane stores values whose arrays hold at
	// most 8192 elements, and a large suite has more passing tests than that.
	Passed string `json:"passed"`
}

var (
	commitPattern = regexp.MustCompile(`^[0-9a-f]{40}([0-9a-f]{24})?$`)
	lowerHex      = regexp.MustCompile(`^[0-9a-f]*$`)
)

// PassedHash is the short id hash a report carries for a passing test. The
// control plane computes the same value from a case id to compare Attempts.
func PassedHash(id string) string {
	sum := sha256.Sum256([]byte(id))
	return hex.EncodeToString(sum[:])[:PassedHashLength]
}

// CaseID joins a suite and a name into the id a test is tracked by across
// Attempts. An id longer than MaxIDBytes keeps a prefix and a hash of the
// whole, so two long ids that share a prefix stay distinct.
func CaseID(suite, name string) string {
	id := name
	if suite != "" {
		id = suite + "::" + name
	}
	if len(id) <= MaxIDBytes {
		return id
	}
	sum := sha256.Sum256([]byte(id))
	return truncateUTF8(id, MaxIDBytes-17) + "#" + hex.EncodeToString(sum[:8])
}

// cleanText makes a string from an XML file safe to carry: valid UTF-8, no
// control characters other than newline and tab, at most limit bytes.
// Rendering safety (HTML escaping) is the reader's job; this only keeps the
// bytes well-formed and bounded.
func cleanText(value string, limit int) string {
	value = strings.ToValidUTF8(value, "�")
	value = strings.Map(func(r rune) rune {
		if r == '\n' || r == '\t' {
			return r
		}
		if r < 0x20 || r == 0x7f || (r >= 0x80 && r < 0xa0) {
			return -1
		}
		return r
	}, value)
	return truncateUTF8(strings.TrimSpace(value), limit)
}

func truncateUTF8(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	cut := limit
	for cut > 0 && !utf8.RuneStart(value[cut]) {
		cut--
	}
	return value[:cut]
}

func validText(field, value string, limit int, required bool) error {
	if required && value == "" {
		return fmt.Errorf("%s is empty", field)
	}
	if len(value) > limit {
		return fmt.Errorf("%s is longer than %d bytes", field, limit)
	}
	if !utf8.ValidString(value) {
		return fmt.Errorf("%s is not UTF-8", field)
	}
	return nil
}

// Validate checks a report against every bound. A reader calls it on any
// report it did not build itself.
func (r *Report) Validate() error {
	if r == nil {
		return errors.New("test report is empty")
	}
	if r.Version != Version {
		return fmt.Errorf("test report version %d is not %d", r.Version, Version)
	}
	if r.CommitSHA != "" && !commitPattern.MatchString(r.CommitSHA) {
		return errors.New("test report commit is not a hex object id")
	}
	if r.Files < 0 || r.Files > MaxFiles {
		return fmt.Errorf("test report names %d files; at most %d", r.Files, MaxFiles)
	}
	totals := r.Totals
	for _, count := range []int{totals.Tests, totals.Passed, totals.Failed, totals.Errored, totals.Skipped, totals.Flaky} {
		if count < 0 || count > MaxTotal {
			return errors.New("test report counts are out of range")
		}
	}
	if totals.Passed+totals.Failed+totals.Errored+totals.Skipped+totals.Flaky != totals.Tests {
		return errors.New("test report counts do not add up to its total")
	}
	if totals.DurationMs < 0 || totals.DurationMs > int64(MaxTotal)*1000 {
		return errors.New("test report duration is out of range")
	}
	if len(r.Cases) > MaxCases {
		return fmt.Errorf("test report lists %d cases; at most %d", len(r.Cases), MaxCases)
	}
	if len(r.Cases) > totals.Tests {
		return errors.New("test report lists more cases than it counts")
	}
	for index, testCase := range r.Cases {
		if err := testCase.validate(); err != nil {
			return fmt.Errorf("test report case %d: %w", index, err)
		}
	}
	if len(r.Passed)%PassedHashLength != 0 || !lowerHex.MatchString(r.Passed) {
		return fmt.Errorf("test report passed ids are not %d-character hex hashes", PassedHashLength)
	}
	hashes := r.PassedHashes()
	if len(hashes) > MaxPassed || len(hashes) > totals.Passed {
		return errors.New("test report carries more passed ids than it may")
	}
	for index := 1; index < len(hashes); index++ {
		if hashes[index-1] >= hashes[index] {
			return errors.New("test report passed ids are not sorted and unique")
		}
	}
	return nil
}

// PassedHashes splits Passed into its hashes.
func (r *Report) PassedHashes() []string {
	hashes := make([]string, 0, len(r.Passed)/PassedHashLength)
	for start := 0; start+PassedHashLength <= len(r.Passed); start += PassedHashLength {
		hashes = append(hashes, r.Passed[start:start+PassedHashLength])
	}
	return hashes
}

func (c Case) validate() error {
	if err := validText("id", c.ID, MaxIDBytes, true); err != nil {
		return err
	}
	if err := validText("name", c.Name, MaxNameBytes, true); err != nil {
		return err
	}
	if err := validText("suite", c.Suite, MaxNameBytes, false); err != nil {
		return err
	}
	if err := validText("file", c.File, MaxNameBytes, false); err != nil {
		return err
	}
	if err := validText("message", c.Message, MaxMessageBytes, false); err != nil {
		return err
	}
	if !c.Status.valid() {
		return fmt.Errorf("status %q is not one this report knows", c.Status)
	}
	if c.DurationMs < 0 || c.DurationMs > MaxDurationMs {
		return errors.New("duration is out of range")
	}
	if c.Retries < 0 || c.Retries > 1000 {
		return errors.New("retries are out of range")
	}
	return nil
}
