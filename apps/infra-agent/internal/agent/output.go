package agent

import (
	"bytes"
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
