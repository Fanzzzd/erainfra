package testreport

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"syscall"
	"testing"
)

func sampleReport(t *testing.T) *Report {
	t.Helper()
	return Build(parseFixture(t, "gotestsum.xml"))
}

func TestConsoleRoundTripSurvivesInterleavedKernelLines(t *testing.T) {
	report := sampleReport(t)
	report.CommitSHA = commit
	report.Files = 1
	var console bytes.Buffer
	console.WriteString("[    1.000] boot noise\r\n")
	lines, err := Encode(report)
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range lines {
		console.WriteString(strings.Replace(line, "\n", "\r\n", 1))
		console.WriteString("[    2.000] systemd[1]: Stopping something...\r\n")
	}
	decoded, err := Decode(console.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(decoded, report) {
		t.Fatalf("decoded = %+v, want %+v", decoded, report)
	}
}

func TestConsoleKeepsTheLastCompleteReport(t *testing.T) {
	first := sampleReport(t)
	second := sampleReport(t)
	second.Files = 2
	var console bytes.Buffer
	for _, report := range []*Report{first, second} {
		lines, err := Encode(report)
		if err != nil {
			t.Fatal(err)
		}
		console.WriteString(strings.Join(lines, ""))
	}
	// A later run that never finished does not displace the complete one.
	console.WriteString(consoleMarker + "1/3:AAAA\n")
	decoded, err := Decode(console.Bytes())
	if err != nil || decoded.Files != 2 {
		t.Fatalf("decoded = %+v, err = %v", decoded, err)
	}
}

func TestConsoleRefusesACorruptedOrIncompleteReport(t *testing.T) {
	lines, err := Encode(sampleReport(t))
	if err != nil {
		t.Fatal(err)
	}
	if decoded, err := Decode([]byte("no markers at all\n")); decoded != nil || err != nil {
		t.Fatalf("no report: %+v, %v", decoded, err)
	}
	payloadStart := strings.LastIndex(lines[0], ":") + 1
	corrupted := lines[0][:payloadStart+20] + "A" + lines[0][payloadStart+21:]
	if corrupted == lines[0] {
		corrupted = lines[0][:payloadStart+20] + "B" + lines[0][payloadStart+21:]
	}
	if decoded, err := Decode([]byte(corrupted + strings.Join(lines[1:], ""))); err == nil {
		t.Fatalf("a corrupted chunk decoded into %+v", decoded)
	}
	// Valid gzip of JSON that breaks a bound is refused by validation.
	bad := sampleReport(t)
	bad.Totals.Tests++
	encoded, err := encodePayload(bad)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Decode([]byte(strings.Join(chunkLines(encoded), ""))); err == nil {
		t.Fatal("a report whose counts do not add up was accepted")
	}
	// Unknown fields mean another format, not this one.
	if _, err := decodePayload(mustEncodeJSON(t, `{"version":1,"files":0,"truncated":false,"totals":{"tests":0,"passed":0,"failed":0,"errored":0,"skipped":0,"flaky":0,"durationMs":0},"cases":[],"passed":"","extra":1}`)); err == nil {
		t.Fatal("an unknown field was accepted")
	}
}

func mustEncodeJSON(t *testing.T, payload string) string {
	t.Helper()
	encoded, err := encodeRaw([]byte(payload))
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func TestEncodeShrinksAReportTooLargeForTheConsole(t *testing.T) {
	report := &Report{Version: Version, Files: 1, Cases: []Case{}}
	random := func(size int) string {
		// Random text does not compress, which is the worst case.
		noise := make([]byte, size/2)
		_, _ = rand.Read(noise)
		return hex.EncodeToString(noise)
	}
	for index := range MaxCases {
		name := fmt.Sprintf("%04d-%s", index, random(400))
		report.Cases = append(report.Cases, Case{
			ID: CaseID(random(MaxNameBytes), name), Suite: random(MaxNameBytes), Name: name,
			File: random(MaxNameBytes), Status: StatusFailed, Message: random(MaxMessageBytes),
		})
	}
	report.Totals = Totals{Tests: MaxCases + MaxPassed, Failed: MaxCases, Passed: MaxPassed}
	hashes := make([]string, 0, MaxPassed)
	for index := range MaxPassed {
		hashes = append(hashes, PassedHash(fmt.Sprint(index)))
	}
	sort.Strings(hashes)
	report.Passed = strings.Join(hashes, "")
	lines, err := Encode(report)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := Decode([]byte(strings.Join(lines, "")))
	if err != nil {
		t.Fatal(err)
	}
	if !decoded.Truncated || len(decoded.Passed) != 0 || len(decoded.Cases) > 100 {
		t.Fatalf("shrunk report: truncated = %v, passed = %d, cases = %d", decoded.Truncated, len(decoded.Passed), len(decoded.Cases))
	}
	if decoded.Totals != report.Totals {
		t.Fatal("shrinking must keep the counts")
	}
	total := 0
	for _, line := range lines {
		total += len(line)
	}
	if total > MaxEncodedBytes+len(lines)*32 {
		t.Fatalf("wrote %d bytes to the console", total)
	}
}

func TestFitJSONBoundsAReportThatEscapingInflates(t *testing.T) {
	// Every '<' becomes < in Go's JSON, six bytes for one, so a report
	// inside every string bound can still be megabytes on the wire.
	markup := strings.Repeat("<", MaxMessageBytes)
	report := &Report{Version: Version, Files: 1, Cases: []Case{}}
	for index := range MaxCases {
		name := fmt.Sprintf("%04d%s", index, strings.Repeat("<", MaxNameBytes-4))
		report.Cases = append(report.Cases, Case{
			ID: CaseID("", name), Name: name, Suite: markup[:MaxNameBytes], File: markup[:MaxNameBytes],
			Status: StatusFailed, Message: markup,
		})
	}
	report.Totals = Totals{Tests: MaxCases, Failed: MaxCases}
	if err := report.Validate(); err != nil {
		t.Fatal(err)
	}
	fitted, err := FitJSON(report)
	if err != nil {
		t.Fatal(err)
	}
	payload, _ := json.Marshal(fitted)
	if len(payload) > MaxJSONBytes || !fitted.Truncated || fitted.Totals != report.Totals {
		t.Fatalf("fitted report is %d bytes, truncated = %v", len(payload), fitted.Truncated)
	}
}

func TestReadConsoleReadsTheLogTail(t *testing.T) {
	path := filepath.Join(t.TempDir(), "console.log")
	report := sampleReport(t)
	lines, err := Encode(report)
	if err != nil {
		t.Fatal(err)
	}
	contents := strings.Repeat("kernel noise line\n", 1000) + strings.Join(lines, "") + "reboot: Restarting system\n"
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
	decoded, err := ReadConsole(path)
	if err != nil || decoded == nil || decoded.Totals != report.Totals {
		t.Fatalf("decoded = %+v, err = %v", decoded, err)
	}
}

func TestOpenRegularRefusesAFIFOWithoutBlocking(t *testing.T) {
	fifo := filepath.Join(t.TempDir(), "junit.xml")
	if err := syscall.Mkfifo(fifo, 0o644); err != nil {
		t.Skip(err)
	}
	if file, err := openRegular(fifo); err == nil {
		_ = file.Close()
		t.Fatal("a FIFO was opened as a report")
	}
	target := filepath.Join(t.TempDir(), "target.xml")
	writeFile(t, target, "x")
	link := filepath.Join(t.TempDir(), "link.xml")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if file, err := openRegular(link); err == nil {
		_ = file.Close()
		t.Fatal("a symbolic link was followed")
	}
}

// The control plane validates this exact file against its own copy of the
// report's shape (packages/backend/tests/testReports.test.ts), so a field
// renamed on one side fails a test on the other. Regenerate it with
// ERAINFRA_UPDATE_GOLDEN=1 go test ./apps/runtime/internal/testreport/.
func TestReportJSONMatchesTheGoldenFileTheControlPlaneReads(t *testing.T) {
	report := Build(append(parseFixture(t, "gotestsum.xml"), parseFixture(t, "TEST-com.example.CalculatorTest.xml")...))
	report.CommitSHA = commit
	report.Files = 2
	encoded, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	encoded = append(encoded, '\n')
	golden := filepath.Join("testdata", "report.golden.json")
	if os.Getenv("ERAINFRA_UPDATE_GOLDEN") == "1" {
		if err := os.WriteFile(golden, encoded, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(golden)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(encoded, want) {
		t.Fatalf("report JSON changed; regenerate %s and check the control plane still accepts it:\n%s", golden, encoded)
	}
}
