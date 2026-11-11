//go:build !windows

package convexnode

import (
	"os"

	"golang.org/x/sys/unix"
)

func lockJournal(f *os.File) error { return unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB) }
func syncJournalDirectory(dir string) error {
	f, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()
	return f.Sync()
}
