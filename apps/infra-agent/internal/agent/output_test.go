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

func TestTailBufferKeepsTheNewestBytes(t *testing.T) {
	b := &tailBuffer{limit: 8}
	for _, chunk := range []string{"abc", "def"} {
		_, _ = b.Write([]byte(chunk))
	}
	if string(b.data) != "abcdef" || b.truncated {
		t.Fatalf("under the limit: %q truncated=%v", b.data, b.truncated)
	}
	_, _ = b.Write([]byte("ghij"))
	if string(b.data) != "cdefghij" || !b.truncated {
		t.Fatalf("over the limit: %q truncated=%v", b.data, b.truncated)
	}
	_, _ = b.Write([]byte("0123456789"))
	if string(b.data) != "23456789" || !b.truncated {
		t.Fatalf("one large write: %q", b.data)
	}
	exact := &tailBuffer{limit: 4}
	_, _ = exact.Write([]byte("wxyz"))
	if string(exact.data) != "wxyz" || exact.truncated {
		t.Fatalf("an exact fit is not truncated: %q %v", exact.data, exact.truncated)
	}
}

func TestExecuteTailReturnsTheEndOfTheOutput(t *testing.T) {
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("no sh")
	}
	script := `i=0; while [ $i -lt 2000 ]; do echo "line $i"; i=$((i+1)); done; echo done >&2`
	out, truncated, err := ShellRunner{}.ExecuteTail(context.Background(), Command{Path: sh, Argv: []string{sh, "-c", script}}, 64)
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 64 || !truncated || !strings.HasSuffix(string(out), "line 1999\ndone\n") {
		t.Fatalf("tail = %q truncated=%v", out, truncated)
	}
	if _, _, err := (ShellRunner{}).ExecuteTail(context.Background(), Command{Path: sh, Argv: []string{"other"}}, 64); err == nil {
		t.Fatal("a command whose argv[0] is not its path must be refused")
	}
}
