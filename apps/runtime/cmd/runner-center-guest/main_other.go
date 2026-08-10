//go:build !linux

package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Fprintln(os.Stderr, "runner-center-guest is only supported inside a Linux Firecracker image")
	os.Exit(1)
}
