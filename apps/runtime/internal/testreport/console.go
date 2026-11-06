package testreport

import (
	"bytes"
	"compress/gzip"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
)

// The guest hands its report to the host on the serial console, the channel
// it already uses for the warm-ready and Experiment-result markers: a microVM
// has no other path to the host that does not go through the job's network.
//
// The report is JSON, gzip-compressed, base64-encoded and cut into numbered
// lines, so a kernel message that lands between two lines cannot corrupt it
// and a line that is lost or mangled fails the gzip checksum instead of
// decoding into something else:
//
//	\x1eRUNNER_CENTER_TESTS:<n>/<total>:<base64 chunk>
//
// Nothing authenticates the lines. Anything that can write them is the job
// itself, writing about its own Attempt, which it could equally do by
// writing a JUnit file; the host attributes the report to the VM the console
// belongs to and validates it like any other untrusted input.
const (
	consoleMarker = "\x1eRUNNER_CENTER_TESTS:"
	chunkBytes    = 2048
	// MaxEncodedBytes bounds what the guest writes to the console. The serial
	// port is slow, and a report past this is cut down before it is sent.
	MaxEncodedBytes = 512 << 10
	// maxConsoleTail is how much of the console's end the host reads. The
	// report is written last, just before the guest resets, so it sits in the
	// tail with only the shutdown messages after it.
	maxConsoleTail = 4 << 20
	// maxDecodedBytes bounds the decompressed JSON, so a small payload cannot
	// expand into a large one on the host.
	maxDecodedBytes = 8 << 20
)

// Encode returns the console lines for a report, each ending in a newline.
// A report too large for MaxEncodedBytes is reduced, in order, by dropping
// its passed ids, then by keeping fewer cases with shorter messages, and is
// marked truncated; Encode fails only when even that does not fit.
func Encode(report *Report) ([]string, error) {
	var encoded string
	_, err := fit(report, func(candidate *Report) (bool, error) {
		var err error
		encoded, err = encodePayload(candidate)
		return err == nil && len(encoded) <= MaxEncodedBytes, err
	})
	if err != nil {
		return nil, fmt.Errorf("test report does not fit on the console: %w", err)
	}
	return chunkLines(encoded), nil
}

// MaxJSONBytes bounds a report as JSON, the form it travels in from the
// runtime service to the Agent and on to the control plane. Validation alone
// does not bound it: escaping can make a valid string several times longer.
const MaxJSONBytes = 1 << 20

// FitJSON returns the report, or a reduced copy marked truncated, whose JSON
// encoding fits MaxJSONBytes.
func FitJSON(report *Report) (*Report, error) {
	return fit(report, func(candidate *Report) (bool, error) {
		payload, err := json.Marshal(candidate)
		return err == nil && len(payload) <= MaxJSONBytes, err
	})
}

// fit reduces a report one step at a time until fits accepts it: first its
// passed ids go, then all but 100 cases with messages cut to 256 bytes, then
// all but 20 with 128. Counts are never reduced.
func fit(report *Report, fits func(*Report) (bool, error)) (*Report, error) {
	candidate := *report
	for step := 0; ; step++ {
		switch step {
		case 0:
		case 1:
			candidate.Passed = ""
			candidate.Truncated = true
		case 2:
			candidate.Cases = shrinkCases(candidate.Cases, 100, 256)
		case 3:
			candidate.Cases = shrinkCases(candidate.Cases, 20, 128)
		default:
			return nil, errors.New("test report is too large even when reduced")
		}
		ok, err := fits(&candidate)
		if err != nil {
			return nil, err
		}
		if ok {
			return &candidate, nil
		}
	}
}

func shrinkCases(cases []Case, limit, messageBytes int) []Case {
	shrunk := make([]Case, 0, min(len(cases), limit))
	for _, testCase := range cases[:min(len(cases), limit)] {
		testCase.Message = truncateUTF8(testCase.Message, messageBytes)
		shrunk = append(shrunk, testCase)
	}
	return shrunk
}

func encodePayload(report *Report) (string, error) {
	payload, err := json.Marshal(report)
	if err != nil {
		return "", fmt.Errorf("encode test report: %w", err)
	}
	return encodeRaw(payload)
}

func encodeRaw(payload []byte) (string, error) {
	var compressed bytes.Buffer
	writer, err := gzip.NewWriterLevel(&compressed, gzip.BestCompression)
	if err != nil {
		return "", err
	}
	if _, err := writer.Write(payload); err != nil {
		return "", fmt.Errorf("compress test report: %w", err)
	}
	if err := writer.Close(); err != nil {
		return "", fmt.Errorf("compress test report: %w", err)
	}
	return base64.StdEncoding.EncodeToString(compressed.Bytes()), nil
}

func chunkLines(encoded string) []string {
	total := (len(encoded) + chunkBytes - 1) / chunkBytes
	lines := make([]string, 0, total)
	for index := range total {
		chunk := encoded[index*chunkBytes : min(len(encoded), (index+1)*chunkBytes)]
		lines = append(lines, fmt.Sprintf("%s%d/%d:%s\n", consoleMarker, index+1, total, chunk))
	}
	return lines
}

// WriteConsole writes a report's lines, one write per line.
func WriteConsole(console io.Writer, report *Report) error {
	lines, err := Encode(report)
	if err != nil {
		return err
	}
	for _, line := range lines {
		if _, err := io.WriteString(console, line); err != nil {
			return fmt.Errorf("write test report to the console: %w", err)
		}
	}
	return nil
}

// ReadConsole finds the last complete report in a console log. It returns
// nil and no error when the console holds none, which is what an image
// without a collector, or a job that wrote no JUnit file, leaves.
func ReadConsole(path string) (*Report, error) {
	console, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open console for the test report: %w", err)
	}
	defer console.Close() //nolint:errcheck // read-only file; a close error loses nothing
	info, err := console.Stat()
	if err != nil {
		return nil, fmt.Errorf("stat console for the test report: %w", err)
	}
	start := max(int64(0), info.Size()-maxConsoleTail)
	if _, err := console.Seek(start, io.SeekStart); err != nil {
		return nil, fmt.Errorf("seek console for the test report: %w", err)
	}
	tail, err := io.ReadAll(io.LimitReader(console, maxConsoleTail))
	if err != nil {
		return nil, fmt.Errorf("read console for the test report: %w", err)
	}
	return Decode(tail)
}

// Decode finds the last complete, numbered run of report lines in console
// output, decodes it and validates it.
func Decode(console []byte) (*Report, error) {
	var (
		building strings.Builder
		expected int
		total    int
		complete string
	)
	for _, line := range strings.Split(string(console), "\n") {
		index := strings.Index(line, consoleMarker)
		if index < 0 {
			continue
		}
		position, chunk, ok := strings.Cut(strings.TrimRight(line[index+len(consoleMarker):], "\r"), ":")
		if !ok {
			expected = 0
			continue
		}
		numberText, totalText, ok := strings.Cut(position, "/")
		number, numberErr := strconv.Atoi(numberText)
		lineTotal, totalErr := strconv.Atoi(totalText)
		if !ok || numberErr != nil || totalErr != nil || lineTotal < 1 || lineTotal > MaxEncodedBytes/chunkBytes+1 {
			expected = 0
			continue
		}
		if number == 1 {
			building.Reset()
			expected, total = 1, lineTotal
		}
		if expected == 0 || number != expected || lineTotal != total {
			expected = 0
			continue
		}
		building.WriteString(chunk)
		expected++
		if number == total {
			complete = building.String()
			expected = 0
		}
	}
	if complete == "" {
		return nil, nil
	}
	return decodePayload(complete)
}

func decodePayload(encoded string) (*Report, error) {
	if len(encoded) > MaxEncodedBytes+chunkBytes {
		return nil, errors.New("test report on the console is larger than the guest may write")
	}
	compressed, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return nil, fmt.Errorf("decode test report: %w", err)
	}
	reader, err := gzip.NewReader(bytes.NewReader(compressed))
	if err != nil {
		return nil, fmt.Errorf("decompress test report: %w", err)
	}
	payload, err := io.ReadAll(io.LimitReader(reader, maxDecodedBytes+1))
	if err != nil {
		return nil, fmt.Errorf("decompress test report: %w", err)
	}
	if len(payload) > maxDecodedBytes {
		return nil, errors.New("test report decompresses past its bound")
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	var report Report
	if err := decoder.Decode(&report); err != nil {
		return nil, fmt.Errorf("decode test report: %w", err)
	}
	if err := report.Validate(); err != nil {
		return nil, err
	}
	return FitJSON(&report)
}
