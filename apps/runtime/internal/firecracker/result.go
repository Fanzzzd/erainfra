package firecracker

import (
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
)

const maxConsoleTailBytes int64 = 64 << 10

func parseExperimentResult(path string, token string) (int, error) {
	console, err := os.Open(path)
	if err != nil {
		return 1, fmt.Errorf("open Experiment console result: %w", err)
	}
	defer console.Close()
	info, err := console.Stat()
	if err != nil {
		return 1, fmt.Errorf("stat Experiment console result: %w", err)
	}
	start := max(int64(0), info.Size()-maxConsoleTailBytes)
	if _, err := console.Seek(start, io.SeekStart); err != nil {
		return 1, fmt.Errorf("seek Experiment console result: %w", err)
	}
	payload, err := io.ReadAll(io.LimitReader(console, maxConsoleTailBytes))
	if err != nil {
		return 1, fmt.Errorf("read Experiment console result: %w", err)
	}
	marker := "\x1eRUNNER_CENTER_RESULT:" + token + ":"
	index := strings.LastIndex(string(payload), marker)
	if index < 0 {
		return 1, errors.New("Experiment exited without an authenticated result marker")
	}
	value := string(payload[index+len(marker):])
	if lineEnd := strings.IndexByte(value, '\n'); lineEnd >= 0 {
		value = value[:lineEnd]
	}
	parsed, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || parsed < 0 || parsed > 255 {
		return 1, errors.New("Experiment returned an invalid exit code marker")
	}
	return parsed, nil
}
