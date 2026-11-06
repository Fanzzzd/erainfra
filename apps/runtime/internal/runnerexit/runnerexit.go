// Package runnerexit carries why a CI Attempt's GitHub runner exited from the
// guest to the host: its exit code, whether it ever ran a job, and the last
// error line of its diagnostic log.
//
// Without it the host sees only that the guest reset, and a Firecracker guest
// resets cleanly whatever the runner did. A runner GitHub refuses at session
// start ("Runner version v2.336.0 is deprecated and cannot receive messages")
// exits seconds after it starts and its Attempt looked like a clean finish,
// with the reason left in a log inside a VM that no longer exists.
//
// The guest writes one line on its serial console, the channel the warm-ready
// marker, the Experiment result and the test report already take:
//
//	\x1eRUNNER_CENTER_RUNNER_EXIT:<base64 of the JSON Report>
//
// A runtime that predates this package leaves the line in the console log and
// reads nothing from it. A guest that predates it writes none, and the host
// reports no Report, which is how the Attempt was settled before.
//
// Nothing authenticates the line. Whatever could forge it is the job inside
// the same VM, writing about its own Attempt; the control plane acts on a
// Report only for an Attempt GitHub never handed a job, which is not one a
// job is running in. The host validates and sanitizes it like any other
// untrusted input.
package runnerexit

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Report is what the guest says about its runner's exit.
type Report struct {
	// ExitCode is run.sh's exit status, or 128 plus the signal that ended it.
	ExitCode int `json:"exitCode"`
	// RanJob says the runner started a job: it spawns one Runner.Worker per
	// job, and each leaves a Worker_*.log in the diagnostic folder.
	RanJob bool `json:"ranJob"`
	// Diagnostic is the last error line of the runner's newest
	// Runner_*.log, sanitized and at most MaxDiagnosticBytes; empty when the
	// log has none.
	Diagnostic string `json:"diagnostic,omitempty"`
}

const (
	consoleMarker = "\x1eRUNNER_CENTER_RUNNER_EXIT:"
	// MaxDiagnosticBytes bounds the diagnostic line. The control plane keeps
	// an Attempt's error to 500 characters; the reason prefix takes the rest.
	MaxDiagnosticBytes = 300
	// maxEncodedBytes bounds the marker's payload. A Report with a full
	// diagnostic encodes to well under it.
	maxEncodedBytes = 2048
	// maxConsoleTail is how much of the console's end the host reads. The
	// line is the last thing the guest writes before it resets, after the
	// test report (at most 512 KiB), so only shutdown messages follow it.
	maxConsoleTail = 1 << 20
	// maxLogTail is how much of the end of the runner's log the guest reads.
	maxLogTail = 256 << 10
	// MaxExitCode is the largest exit status a process can report, and the
	// largest 128 plus a signal number can be.
	MaxExitCode = 255
)

// Validate checks a Report decoded from untrusted input.
func (r *Report) Validate() error {
	if r.ExitCode < 0 || r.ExitCode > MaxExitCode {
		return fmt.Errorf("runner exit code %d is outside 0 to %d", r.ExitCode, MaxExitCode)
	}
	if len(r.Diagnostic) > MaxDiagnosticBytes {
		return fmt.Errorf("runner diagnostic is longer than %d bytes", MaxDiagnosticBytes)
	}
	if r.Diagnostic != Sanitize(r.Diagnostic) {
		return errors.New("runner diagnostic carries characters a sanitized line cannot")
	}
	return nil
}

// Line returns the console line for a report, ending in a newline.
func Line(report Report) (string, error) {
	report.Diagnostic = Sanitize(report.Diagnostic)
	if err := report.Validate(); err != nil {
		return "", err
	}
	payload, err := json.Marshal(report)
	if err != nil {
		return "", fmt.Errorf("encode runner exit: %w", err)
	}
	return consoleMarker + base64.StdEncoding.EncodeToString(payload) + "\n", nil
}

// Decode returns the last runner-exit report in console output, or nil when
// there is none.
func Decode(console []byte) (*Report, error) {
	index := bytes.LastIndex(console, []byte(consoleMarker))
	if index < 0 {
		return nil, nil
	}
	encoded := console[index+len(consoleMarker):]
	if end := bytes.IndexByte(encoded, '\n'); end >= 0 {
		encoded = encoded[:end]
	}
	encoded = bytes.TrimRight(encoded, "\r")
	if len(encoded) > maxEncodedBytes {
		return nil, errors.New("runner exit line is longer than the guest may write")
	}
	payload, err := base64.StdEncoding.DecodeString(string(encoded))
	if err != nil {
		return nil, fmt.Errorf("decode runner exit: %w", err)
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	var report Report
	if err := decoder.Decode(&report); err != nil {
		return nil, fmt.Errorf("decode runner exit: %w", err)
	}
	if err := report.Validate(); err != nil {
		return nil, err
	}
	return &report, nil
}

// ReadConsole finds the last runner-exit report in a console log.
func ReadConsole(path string) (*Report, error) {
	tail, err := readTail(path, maxConsoleTail)
	if err != nil {
		return nil, fmt.Errorf("read console for the runner exit: %w", err)
	}
	return Decode(tail)
}

// Collect builds the Report for a runner that exited with exitCode, from its
// diagnostic folder. A folder it cannot read leaves the diagnostic empty and
// RanJob false; the exit code is still worth reporting.
func Collect(diagDir string, exitCode int) Report {
	report := Report{ExitCode: min(max(exitCode, 0), MaxExitCode)}
	if workers, _ := filepath.Glob(filepath.Join(diagDir, "Worker_*.log")); len(workers) > 0 {
		report.RanJob = true
	}
	runners, _ := filepath.Glob(filepath.Join(diagDir, "Runner_*.log"))
	if len(runners) == 0 {
		return report
	}
	// The runner names each log after the UTC time it opened it
	// (Runner_20261105-101500-utc.log), so the greatest name is the newest.
	newest := slices.Max(runners)
	tail, err := readTail(newest, maxLogTail)
	if err != nil {
		return report
	}
	report.Diagnostic = LastError(tail)
	return report
}

// LastError returns the message of the last ERR line in a runner diagnostic
// log, sanitized and bounded, or "" when there is none. The runner writes
// "[2026-11-05 10:15:00Z ERR  Runner] message"; the timestamp and source are
// dropped, since the Attempt already says when and which runner.
func LastError(log []byte) string {
	lines := strings.Split(string(log), "\n")
	for index := len(lines) - 1; index >= 0; index-- {
		line := strings.TrimRight(lines[index], "\r")
		if !strings.HasPrefix(line, "[") {
			continue
		}
		header, message, ok := strings.Cut(line[1:], "]")
		if !ok {
			continue
		}
		fields := strings.Fields(header)
		if len(fields) < 3 || fields[2] != "ERR" {
			continue
		}
		if cleaned := Sanitize(message); cleaned != "" {
			return cleaned
		}
	}
	return ""
}

// tokenLike matches a run of 40 or more characters from the base64, base64url
// and hex alphabets with nothing that ends a word in prose: the shape of a
// GitHub token (ghs_ and 36 more), a JWT segment or a key. The runner masks
// the secrets it knows of in its logs, but this line leaves the VM, so the
// guest does not rely on that.
var tokenLike = regexp.MustCompile(`[A-Za-z0-9_+=-]{40,}`)

// Sanitize makes a line safe to carry to the control plane and show an
// operator: valid UTF-8, no control characters, single spaces, anything
// shaped like a credential redacted, and at most MaxDiagnosticBytes.
func Sanitize(line string) string {
	line = strings.ToValidUTF8(line, "�")
	line = strings.Map(func(character rune) rune {
		if unicode.IsControl(character) || unicode.Is(unicode.Cf, character) {
			return ' '
		}
		return character
	}, line)
	line = strings.Join(strings.Fields(line), " ")
	line = tokenLike.ReplaceAllString(line, "[redacted]")
	if len(line) <= MaxDiagnosticBytes {
		return line
	}
	const ellipsis = "…"
	cut := MaxDiagnosticBytes - len(ellipsis)
	for cut > 0 && !utf8.RuneStart(line[cut]) {
		cut--
	}
	return strings.TrimRight(line[:cut], " ") + ellipsis
}

func readTail(path string, limit int64) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close() //nolint:errcheck // read-only file; a close error loses nothing
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("not a regular file")
	}
	start := max(int64(0), info.Size()-limit)
	if _, err := file.Seek(start, io.SeekStart); err != nil {
		return nil, err
	}
	return io.ReadAll(io.LimitReader(file, limit))
}
