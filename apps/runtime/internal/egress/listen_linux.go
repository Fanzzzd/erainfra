//go:build linux

package egress

import (
	"syscall"

	"golang.org/x/sys/unix"
)

// listenControl sets IP_FREEBIND. The resolver listens on the guest gateway
// address, which ptp puts on the host side of each guest's link, so it exists
// only while a guest is up. Freebind lets the daemon bind it at startup and
// keep the socket across guests, instead of listening on every host address,
// which would offer the resolver to the Worker's LAN.
func listenControl(_, _ string, raw syscall.RawConn) error {
	var optionErr error
	if err := raw.Control(func(fd uintptr) {
		optionErr = unix.SetsockoptInt(int(fd), unix.SOL_IP, unix.IP_FREEBIND, 1)
	}); err != nil {
		return err
	}
	return optionErr
}
