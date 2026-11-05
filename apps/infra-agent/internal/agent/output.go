package agent

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
)

// capBuffer consumes all output without back-pressuring the child, retaining only the prefix.
// It is used only for opt-in Convex execution; that transport never uploads the retained bytes.
type capBuffer struct {
	buffer bytes.Buffer
	limit  int
}

func (b *capBuffer) Write(p []byte) (int, error) {
	n := len(p)
	if remaining := b.limit - b.buffer.Len(); remaining > 0 {
		if len(p) > remaining {
			p = p[:remaining]
		}
		_, _ = b.buffer.Write(p)
	}
	return n, nil
}

// tailBuffer consumes all output and keeps only the last `limit` bytes. A log tail wants the end
// of the output, the newest lines, where capBuffer keeps the start.
type tailBuffer struct {
	data      []byte
	limit     int
	truncated bool
}

func (b *tailBuffer) Write(p []byte) (int, error) {
	n := len(p)
	if len(p) >= b.limit {
		b.truncated = b.truncated || len(p) > b.limit || len(b.data) > 0
		b.data = append(b.data[:0], p[len(p)-b.limit:]...)
		return n, nil
	}
	if over := len(b.data) + len(p) - b.limit; over > 0 {
		b.truncated = true
		b.data = append(b.data[:0], b.data[over:]...)
	}
	b.data = append(b.data, p...)
	return n, nil
}

// ExecuteTail runs a resolved command and returns the last `limit` bytes of its combined output,
// and whether anything before them was dropped. It is the log-tail path of the Convex transport,
// the one place that transport uploads output (to a row only the requester can read).
func (r ShellRunner) ExecuteTail(ctx context.Context, command Command, limit int) ([]byte, bool, error) {
	if command.Path == "" || len(command.Argv) == 0 || command.Argv[0] != command.Path || limit <= 0 {
		return nil, false, fmt.Errorf("invalid resolved command")
	}
	cmd := exec.CommandContext(ctx, command.Path, command.Argv[1:]...)
	b := &tailBuffer{limit: limit}
	cmd.Stdout = b
	cmd.Stderr = b
	err := cmd.Run()
	return b.data, b.truncated, err
}

func (r ShellRunner) combinedOutput(cmd *exec.Cmd) ([]byte, error) {
	if r.OutputLimit <= 0 {
		return cmd.CombinedOutput()
	}
	b := &capBuffer{limit: r.OutputLimit}
	cmd.Stdout = b
	cmd.Stderr = b
	err := cmd.Run()
	return b.buffer.Bytes(), err
}
