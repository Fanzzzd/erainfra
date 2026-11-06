//go:build !unix

package testreport

import (
	"errors"
	"fmt"
	"os"
)

// openNoFollow refuses a symbolic link by checking first. Collection only
// runs inside a Linux guest; this keeps the package building elsewhere.
func openNoFollow(file string) (*os.File, error) {
	info, err := os.Lstat(file)
	if err != nil {
		return nil, err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("%s: %w", file, errors.ErrUnsupported)
	}
	return os.Open(file)
}
