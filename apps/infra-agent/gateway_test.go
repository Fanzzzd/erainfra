package main

import (
	"path/filepath"
	"testing"
)

func TestGatewayRoutesFileMustBeAnAbsolutePathInAnExistingDirectory(t *testing.T) {
	dir := t.TempDir()
	for value, ok := range map[string]bool{
		"":                                  true,
		filepath.Join(dir, "routes.json"):   true,
		"routes.json":                       false,
		filepath.Join(dir, "no", "rt.json"): false,
	} {
		t.Setenv("ERAINFRA_GATEWAY_ROUTES_FILE", value)
		got, err := gatewayRoutesFile()
		if ok && (err != nil || got != value) {
			t.Errorf("%q: %q %v", value, got, err)
		}
		if !ok && err == nil {
			t.Errorf("%q accepted", value)
		}
	}
}

func TestGatewayCommandRefusesBadConfiguration(t *testing.T) {
	routes := filepath.Join(t.TempDir(), "routes.json")
	for name, args := range map[string][]string{
		"relative routes file": {"--zone", "example.test", "--routes-file", "routes.json"},
		"public listen":        {"--zone", "example.test", "--routes-file", routes, "--listen", "0.0.0.0:61090"},
		"no zone":              {"--routes-file", routes, "--listen", "127.0.0.1:0"},
	} {
		t.Setenv("ERAINFRA_ZONE", "")
		if err := runGateway(t.Context(), append(args, "--allow-root")); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}
