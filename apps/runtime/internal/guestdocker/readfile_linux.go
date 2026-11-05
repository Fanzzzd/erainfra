//go:build linux

package guestdocker

import (
	"fmt"
	"io"
	"os"
	"path"
	"strings"

	"golang.org/x/sys/unix"
)

// maxContainerFile bounds what is read from a container to check its trust
// store. A CA bundle is a few hundred KiB; anything larger is not one.
const maxContainerFile = 1 << 20

// ReadInContainer reads path as the container whose init process is pid sees
// it. Resolution is confined to the container's root with RESOLVE_IN_ROOT, so
// an absolute symlink inside the image resolves inside the image, never to the
// guest file of the same name.
func ReadInContainer(pid int, name string) ([]byte, error) {
	if pid <= 0 {
		return nil, fmt.Errorf("container has no process")
	}
	if !path.IsAbs(name) {
		return nil, fmt.Errorf("%q is not an absolute path", name)
	}
	root, err := unix.Open(fmt.Sprintf("/proc/%d/root", pid), unix.O_PATH|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, fmt.Errorf("open container root: %w", err)
	}
	defer unix.Close(root) //nolint:errcheck // an O_PATH descriptor; close reports nothing useful
	fd, err := unix.Openat2(root, strings.TrimPrefix(path.Clean(name), "/"), &unix.OpenHow{
		Flags:   unix.O_RDONLY | unix.O_CLOEXEC,
		Resolve: unix.RESOLVE_IN_ROOT | unix.RESOLVE_NO_MAGICLINKS,
	})
	if err != nil {
		return nil, fmt.Errorf("open %s in container: %w", name, err)
	}
	file := os.NewFile(uintptr(fd), name)
	defer file.Close() //nolint:errcheck // read-only
	return io.ReadAll(io.LimitReader(file, maxContainerFile))
}
