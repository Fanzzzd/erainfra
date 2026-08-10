//go:build linux

package main

import "testing"

func TestResolverConfigKeepsOnlyResolverDirectives(t *testing.T) {
	// The exact shape a Firecracker guest sees: the kernel's own comment line
	// first, then the nameservers the Profile's network policy named.
	published := "#MANUAL\nnameserver 1.1.1.1\nnameserver 9.9.9.9\n"
	config, err := resolverConfig([]byte(published))
	if err != nil {
		t.Fatalf("resolverConfig returned %v", err)
	}
	want := "nameserver 1.1.1.1\nnameserver 9.9.9.9\n"
	if config != want {
		t.Fatalf("resolverConfig produced %q, want %q", config, want)
	}
}

func TestResolverConfigKeepsSearchAndDomain(t *testing.T) {
	config, err := resolverConfig([]byte("domain example.test\nsearch a.test b.test\nnameserver 10.0.0.53\n"))
	if err != nil {
		t.Fatalf("resolverConfig returned %v", err)
	}
	want := "domain example.test\nsearch a.test b.test\nnameserver 10.0.0.53\n"
	if config != want {
		t.Fatalf("resolverConfig produced %q, want %q", config, want)
	}
}

// A guest with no resolver cannot reach GitHub, a registry or a package mirror.
// Failing here is how that surfaces as an error instead of as a job that dies
// much later with an unexplained name resolution failure.
func TestResolverConfigRejectsAnEmptyPublication(t *testing.T) {
	if _, err := resolverConfig([]byte("#MANUAL\n")); err == nil {
		t.Fatal("resolverConfig accepted a publication with no resolver")
	}
}
