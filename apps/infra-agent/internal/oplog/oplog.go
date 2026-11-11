// Package oplog routes the Infra Agent's printf-style operator messages through log/slog.
//
// The messages keep their exact text, because operators and the runbooks grep journalctl for
// them ("published mesh endpoint", "connect-convex: ERROR: ..."). Only the level is new: each
// message already names its severity after the component prefix, and Printf logs at that level.
package oplog

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
)

// Printf formats a message and logs it with slog.Default(), which the Infra Agent leaves at the
// standard library's default handler: one line on stderr, which systemd keeps.
func Printf(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	slog.Log(context.Background(), Level(msg), msg)
}

// Level reads the severity marker that follows a message's component prefix:
// "connect-convex: ERROR: ..." is slog.LevelError, "connect-convex: WARNING: ..." is
// slog.LevelWarn, and any other message is slog.LevelInfo.
func Level(msg string) slog.Level {
	_, rest, ok := strings.Cut(msg, ": ")
	switch {
	case !ok:
		return slog.LevelInfo
	case strings.HasPrefix(rest, "ERROR: "):
		return slog.LevelError
	case strings.HasPrefix(rest, "WARNING: "):
		return slog.LevelWarn
	default:
		return slog.LevelInfo
	}
}
