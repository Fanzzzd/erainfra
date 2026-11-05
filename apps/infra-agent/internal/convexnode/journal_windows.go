//go:build windows

package convexnode

import (
	"golang.org/x/sys/windows"
	"os"
)

func lockJournal(f *os.File) error {
	return windows.LockFileEx(windows.Handle(f.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &windows.Overlapped{})
}

// File contents are flushed by Sync. Windows has no portable directory-fsync equivalent in Go.
func syncJournalDirectory(_ string) error { return nil }
