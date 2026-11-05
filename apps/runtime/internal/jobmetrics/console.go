package jobmetrics

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
)

// The kernel's out-of-memory report. The global killer writes "Out of
// memory: Killed process N (comm) ..." and a memory cgroup's writes "Memory
// cgroup out of memory: Killed process N ...", so this one fragment matches
// both: a job whose own container hit its limit inside the guest is as much an
// OOM as the guest running dry.
var oomMarker = []byte("ut of memory: Killed process ")

const (
	// maxConsoleReadPerScan bounds one scan's work. A console that grows
	// faster than this is read over several scans; nothing is skipped.
	maxConsoleReadPerScan = 4 << 20
	// maxConsoleCarry bounds the unterminated tail kept between scans. A
	// kernel line is far shorter; a longer run without a newline is not one.
	maxConsoleCarry = 4 << 10
)

// ConsoleOOMScanner counts out-of-memory kills on a microVM's serial console.
//
// This is the one number on the dashboard that the guest writes: the host
// captures the console, but the guest kernel prints the line. It is reported
// because the alternative is not knowing why a job died, and a job that forges
// an OOM line misleads only its own Attempt's page. Nothing schedules on it.
type ConsoleOOMScanner struct {
	Path   string
	offset int64
	carry  []byte
	kills  uint64
}

// Scan reads what the console gained since the last call and returns the
// total kills seen so far.
func (s *ConsoleOOMScanner) Scan() (uint64, error) {
	file, err := os.Open(s.Path)
	if err != nil {
		return s.kills, fmt.Errorf("open console: %w", err)
	}
	defer file.Close() //nolint:errcheck // read-only file; a close error loses nothing
	info, err := file.Stat()
	if err != nil {
		return s.kills, fmt.Errorf("stat console: %w", err)
	}
	if info.Size() < s.offset {
		// Truncated underneath us. Start over rather than read past the end.
		s.offset, s.carry = 0, nil
	}
	remaining := info.Size() - s.offset
	if remaining <= 0 {
		return s.kills, nil
	}
	if remaining > maxConsoleReadPerScan {
		remaining = maxConsoleReadPerScan
	}
	chunk := make([]byte, remaining)
	read, err := file.ReadAt(chunk, s.offset)
	if err != nil && !errors.Is(err, io.EOF) {
		return s.kills, fmt.Errorf("read console: %w", err)
	}
	s.offset += int64(read)
	data := append(s.carry, chunk[:read]...)
	last := bytes.LastIndexByte(data, '\n')
	complete := data[:last+1]
	s.kills += uint64(bytes.Count(complete, oomMarker))
	tail := data[last+1:]
	if len(tail) > maxConsoleCarry {
		tail = tail[len(tail)-maxConsoleCarry:]
	}
	s.carry = append([]byte(nil), tail...)
	return s.kills, nil
}
