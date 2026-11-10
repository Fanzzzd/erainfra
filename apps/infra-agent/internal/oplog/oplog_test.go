package oplog

import (
	"bytes"
	"log/slog"
	"strings"
	"testing"
)

func TestLevel(t *testing.T) {
	for _, tc := range []struct {
		msg  string
		want slog.Level
	}{
		{"connect-convex: ERROR: command polling failed (network): refused", slog.LevelError},
		{"connect-convex: WARNING: journal /x: dropped the torn record at line 4", slog.LevelWarn},
		{"connect-convex: published mesh endpoint 3f9a (1 relay, 4 direct addresses)", slog.LevelInfo},
		{"gateway: http: TLS handshake error from 127.0.0.1:1: EOF", slog.LevelInfo},
		{"no prefix ERROR: here", slog.LevelInfo},
		{"connect-convex: journal key k ended in Convex as ERROR: x", slog.LevelInfo},
	} {
		if got := Level(tc.msg); got != tc.want {
			t.Errorf("Level(%q) = %v, want %v", tc.msg, got, tc.want)
		}
	}
}

func TestPrintfKeepsTheMessageText(t *testing.T) {
	var buf bytes.Buffer
	old := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	t.Cleanup(func() { slog.SetDefault(old) })

	Printf("connect-convex: ERROR: Convex refused mesh key %s: this Node is registered as %s", "new", "old")

	line := buf.String()
	if !strings.Contains(line, "level=ERROR") {
		t.Errorf("line %q is not at level ERROR", line)
	}
	if !strings.Contains(line, `msg="connect-convex: ERROR: Convex refused mesh key new: this Node is registered as old"`) {
		t.Errorf("line %q does not carry the formatted message", line)
	}
}
