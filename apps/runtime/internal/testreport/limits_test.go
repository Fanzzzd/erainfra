package testreport

import (
	"encoding/json"
	"os"
	"testing"
)

// The control plane enforces the same bounds in TypeScript. Both suites read
// this file, so a bound changed on one side alone turns one of them red.
func TestLimitsMatchTheControlPlanesCases(t *testing.T) {
	contents, err := os.ReadFile("../../../../testdata/test-report-limits.json")
	if err != nil {
		t.Fatalf("read shared limits: %v", err)
	}
	var shared struct {
		Limits map[string]int64 `json:"limits"`
	}
	if err := json.Unmarshal(contents, &shared); err != nil {
		t.Fatalf("decode shared limits: %v", err)
	}
	ours := map[string]int64{
		"cases":            MaxCases,
		"passed":           MaxPassed,
		"files":            MaxFiles,
		"idBytes":          MaxIDBytes,
		"nameBytes":        MaxNameBytes,
		"messageBytes":     MaxMessageBytes,
		"total":            MaxTotal,
		"durationMs":       MaxDurationMs,
		"passedHashLength": PassedHashLength,
	}
	for name, want := range shared.Limits {
		got, ok := ours[name]
		if !ok {
			t.Errorf("%s: the shared file has a bound this package does not map", name)
			continue
		}
		if got != want {
			t.Errorf("%s = %d, the shared file says %d", name, got, want)
		}
	}
	for name := range ours {
		if _, ok := shared.Limits[name]; !ok {
			t.Errorf("%s: this package maps a bound the shared file does not have", name)
		}
	}
}
