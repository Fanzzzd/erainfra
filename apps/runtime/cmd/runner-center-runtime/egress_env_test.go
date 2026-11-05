package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/Fanzzzd/erainfra/apps/runtime/internal/executor"
	"github.com/Fanzzzd/erainfra/apps/runtime/internal/netpolicy"
)

func TestProfileEgressEnvDefaultsToPublicOnlyWhenUnset(t *testing.T) {
	t.Setenv(profileEgressVariable, "")
	egress, err := profileEgressEnv()
	if err != nil || egress.Normalized().Mode != netpolicy.EgressPublic {
		t.Fatalf("an unset policy is public, got %+v %v", egress, err)
	}

	t.Setenv(profileEgressVariable, `{"mode":"allowlist","presets":["GitHub"],"domains":["Registry.npmjs.org."]}`)
	egress, err = profileEgressEnv()
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if egress.Mode != netpolicy.EgressAllowlist || !slices.Equal(egress.Presets, []string{"github"}) ||
		!slices.Equal(egress.Domains, []string{"registry.npmjs.org"}) {
		t.Fatalf("policy = %+v, want the normalized allowlist", egress)
	}

	// Falling back to public for a policy the runtime cannot read would be
	// failing open, so every one of these is an error.
	for _, broken := range []string{
		`{"mode":"allowlist"}`,
		`{"mode":"allowlist","presets":["github"],"extra":true}`,
		`not json`,
		`{"mode":"block"}`,
	} {
		t.Setenv(profileEgressVariable, broken)
		if _, err := profileEgressEnv(); err == nil {
			t.Fatalf("%s must be rejected", broken)
		}
	}
}

func TestWriteEgressRecordWritesAnOwnerOnlyFileOnce(t *testing.T) {
	path := filepath.Join(t.TempDir(), "egress.json")
	t.Setenv(egressRecordVariable, path)
	record := &executor.EgressRecord{
		Mode:  "audit",
		Names: []executor.EgressNameSeen{{Name: "github.com", Verdict: executor.EgressAllowed, Queries: 1}},
	}
	if err := writeEgressRecord(record); err != nil {
		t.Fatalf("write: %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("record mode = %v, want 0600", info.Mode().Perm())
	}
	var decoded executor.EgressRecord
	contents, _ := os.ReadFile(path)
	if err := json.Unmarshal(contents, &decoded); err != nil || decoded.Names[0].Name != "github.com" {
		t.Fatalf("decoded = %+v, %v", decoded, err)
	}
	if err := writeEgressRecord(record); err == nil {
		t.Fatal("an existing file must not be overwritten")
	}
	t.Setenv(egressRecordVariable, "relative.json")
	if err := writeEgressRecord(record); err == nil {
		t.Fatal("a relative path must be refused")
	}
	t.Setenv(egressRecordVariable, "")
	if err := writeEgressRecord(record); err != nil {
		t.Fatal("no path configured means nothing to write")
	}
}
