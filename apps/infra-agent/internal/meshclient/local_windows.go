package meshclient

import (
	"context"
	"errors"
	"net"
	"os"
	"path/filepath"

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

func dialLocal(ctx context.Context, path string) (net.Conn, error) {
	return winio.DialPipeContext(ctx, path)
}
func PrivateDir(path string) error {
	if err := os.MkdirAll(path, 0700); err != nil {
		return err
	}
	st, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !st.IsDir() || st.Mode()&os.ModeSymlink != 0 {
		return errors.New("mesh directory must not be a reparse point")
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return err
	}
	sd, err := windows.SecurityDescriptorFromString("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;" + user.User.Sid.String() + ")")
	if err != nil {
		return err
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	return windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil)
}

type Lock struct {
	f          *os.File
	overlapped windows.Overlapped
}

func Acquire(path string) (*Lock, error) {
	if err := PrivateDir(filepath.Dir(path)); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0600)
	if err != nil {
		return nil, err
	}
	l := &Lock{f: f}
	if err := windows.LockFileEx(windows.Handle(f.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &l.overlapped); err != nil {
		_ = f.Close()
		return nil, errors.New("mesh already has a controller")
	}
	return l, nil
}

// AcquireSocket has no Windows equivalent yet: a named pipe has no directory inode to lock, so
// Windows relies on the control-directory lock alone. connect-convex refuses to drive a sidecar on
// Windows for this reason, which leaves Hub mode as the only controller there.
func AcquireSocket(string) (*Lock, error) { return &Lock{}, nil }

func (l *Lock) Close() error {
	if l.f == nil {
		return nil
	}
	return l.f.Close()
}
func privileged() bool              { return windows.GetCurrentProcessToken().IsElevated() }
func terminate(p *os.Process) error { return p.Kill() }
func privateKey(path string) error {
	st, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !st.Mode().IsRegular() {
		return errors.New("mesh key must be a regular file")
	}
	// Key creation inherits the protected, owner-and-SYSTEM-only directory DACL.
	return nil
}
