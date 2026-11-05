//go:build !windows

package meshclient

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"syscall"
)

func dialLocal(ctx context.Context, path string) (net.Conn, error) {
	info, err := os.Stat(filepath.Dir(path))
	if err != nil {
		return nil, err
	}
	if !info.IsDir() || info.Mode().Perm()&0022 != 0 {
		return nil, errors.New("mesh socket directory must not be writable by group or others")
	}
	return (&net.Dialer{}).DialContext(ctx, "unix", path)
}
func PrivateDir(path string) error {
	if err := os.MkdirAll(path, 0700); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("mesh directory must not be a symlink")
	}
	if st, ok := info.Sys().(*syscall.Stat_t); !ok || st.Uid != uint32(os.Geteuid()) {
		return errors.New("mesh directory has another owner")
	}
	return os.Chmod(path, 0700)
}

// Lock is held for the controller's lifetime, across reconnects. Kernel locks disappear on crash;
// PID files do not. Separate Hub and Convex modes use the same path and cannot both drive a daemon.
type Lock struct{ f *os.File }

func Acquire(path string) (*Lock, error) {
	if err := PrivateDir(filepath.Dir(path)); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = f.Close()
		return nil, fmt.Errorf("mesh already has a controller: %w", err)
	}
	return &Lock{f: f}, nil
}
func (l *Lock) Close() error        { return l.f.Close() }
func privileged() bool              { return os.Geteuid() == 0 }
func terminate(p *os.Process) error { return p.Signal(os.Interrupt) }
func privateKey(path string) error {
	st, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !st.Mode().IsRegular() || st.Mode().Perm() != 0600 {
		return errors.New("mesh key must be a regular owner-only file (0600)")
	}
	return nil
}
