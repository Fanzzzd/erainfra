//go:build !linux

package egress

import "syscall"

// listenControl is a no-op off Linux, where there are no guests; tests listen
// on loopback.
func listenControl(_, _ string, _ syscall.RawConn) error { return nil }
