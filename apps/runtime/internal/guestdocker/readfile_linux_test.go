//go:build linux

package guestdocker

import (
	"os"
	"path/filepath"
	"testing"
)

// This process stands in for a container's init: its /proc/<pid>/root is the
// test's own root, so a path written here reads back through it.
func TestReadInContainerReadsThroughTheProcessRoot(t *testing.T) {
	path := filepath.Join(t.TempDir(), CAFileName)
	if err := os.WriteFile(path, []byte("pem"), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := ReadInContainer(os.Getpid(), path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "pem" {
		t.Fatalf("read %q", got)
	}
	if _, err := ReadInContainer(os.Getpid(), "relative/"+CAFileName); err == nil {
		t.Fatal("a relative path was resolved against an unknown working directory")
	}
	if _, err := ReadInContainer(0, path); err == nil {
		t.Fatal("read from a container with no process")
	}
}
