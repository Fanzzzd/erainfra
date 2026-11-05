package agent

import (
	"context"
	"os/exec"
	"strings"
	"testing"
)

func TestConvexOutputCaptureIsBoundedAndLegacyUnchanged(t *testing.T) {
	b := &capBuffer{limit: 16}
	for i := 0; i < 1000; i++ {
		n, err := b.Write([]byte(strings.Repeat("x", 1024)))
		if err != nil || n != 1024 {
			t.Fatal(n, err)
		}
	}
	if b.buffer.Len() != 16 {
		t.Fatal(b.buffer.Len())
	}
	for _, limit := range []int{0, 4} {
		r := ShellRunner{OutputLimit: limit}
		output, err := r.combinedOutput(exec.CommandContext(context.Background(), "echo", "0123456789"))
		if err != nil {
			t.Fatal(err)
		}
		if limit == 0 && string(output) != "0123456789\n" {
			t.Fatal("legacy capture changed")
		}
		if limit == 4 && string(output) != "0123" {
			t.Fatal(string(output))
		}
	}
}
