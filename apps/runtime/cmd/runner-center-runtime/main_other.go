//go:build !linux

package main

import (
	"fmt"
	"os"
)

var version = "dev"

func main() {
	if len(os.Args) == 2 && os.Args[1] == "version" {
		fmt.Printf("runner-center-runtime %s\n", version)
		return
	}
	fmt.Fprintln(os.Stderr, "runner-center-runtime requires Linux with KVM")
	os.Exit(1)
}
