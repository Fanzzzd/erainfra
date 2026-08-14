package firecracker

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"time"
)

const maxConsoleTailBytes int64 = 64 << 10
const warmReadyMarker = "\x1eRUNNER_CENTER_WARM_READY"

func waitForConsoleMarker(ctx context.Context, path, marker string) error {
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		found, err := consoleContainsMarker(path, marker)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("read VM console readiness: %w", err)
		}
		if found {
			return nil
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("wait for guest warm readiness: %w", ctx.Err())
		case <-ticker.C:
		}
	}
}

func consoleContainsMarker(path, marker string) (bool, error) {
	console, err := os.Open(path)
	if err != nil {
		return false, err
	}
	defer console.Close()
	info, err := console.Stat()
	if err != nil {
		return false, err
	}
	start := max(int64(0), info.Size()-maxConsoleTailBytes)
	if _, err := console.Seek(start, io.SeekStart); err != nil {
		return false, err
	}
	payload, err := io.ReadAll(io.LimitReader(console, maxConsoleTailBytes))
	if err != nil {
		return false, err
	}
	return strings.Contains(string(payload), marker), nil
}

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
