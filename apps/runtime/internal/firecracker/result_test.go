package firecracker

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestParseExperimentResultUsesAuthenticatedFinalMarker(t *testing.T) {
	path := filepath.Join(t.TempDir(), "console.log")
	payload := "job output\n\x1eRUNNER_CENTER_RESULT:wrong:0\n\x1eRUNNER_CENTER_RESULT:secret-token:17\n"
	if err := os.WriteFile(path, []byte(payload), 0o600); err != nil {
		t.Fatal(err)
	}
	exitCode, err := parseExperimentResult(path, "secret-token")
	if err != nil {
		t.Fatal(err)
	}
	if exitCode != 17 {
		t.Fatalf("exit code = %d, want 17", exitCode)
	}
}

func TestWaitForConsoleMarker(t *testing.T) {
	path := filepath.Join(t.TempDir(), "console.log")
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	go func() {
		time.Sleep(10 * time.Millisecond)
		_ = os.WriteFile(path, []byte("booting\n"+warmReadyMarker+"\n"), 0o600)
	}()
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	if err := waitForConsoleMarker(ctx, path, warmReadyMarker); err != nil {
		t.Fatal(err)
	}
}

func TestParseExperimentResultRejectsMissingOrOversizedTail(t *testing.T) {
	path := filepath.Join(t.TempDir(), "console.log")
	if err := os.WriteFile(path, []byte("ordinary output\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := parseExperimentResult(path, "secret-token"); err == nil {
		t.Fatal("missing marker accepted")
	}

	payload := "\x1eRUNNER_CENTER_RESULT:secret-token:0\n" + strings.Repeat("x", int(maxConsoleTailBytes))
	if err := os.WriteFile(path, []byte(payload), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := parseExperimentResult(path, "secret-token"); err == nil {
		t.Fatal("marker outside bounded tail accepted")
	}
}
