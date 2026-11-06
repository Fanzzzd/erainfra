//go:build unix

package testreport

import (
	"os"
	"syscall"
)

// openNoFollow refuses a final symbolic link (O_NOFOLLOW) and never blocks on
// a FIFO (O_NONBLOCK); openRegular then refuses anything that is not regular.
func openNoFollow(file string) (*os.File, error) {
	return os.OpenFile(file, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
}
