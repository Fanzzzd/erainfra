//go:build !linux

package guestdocker

import "errors"

// ReadInContainer is only meaningful in a Linux guest.
func ReadInContainer(int, string) ([]byte, error) {
	return nil, errors.New("reading a container's filesystem needs Linux")
}
