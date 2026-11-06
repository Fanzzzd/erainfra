package cli

import (
	"encoding/json"
	"strings"
	"testing"
)

const rightsizeJSON = `{
  "window": {"start": "2026-10-22T12:00:00.000Z", "end": "2026-11-05T12:00:00.000Z"},
  "scanned": 40,
  "truncated": false,
  "policy": {"minAttempts": 5},
  "recommendations": [
    {"repo": "acme/web", "job": "test", "profile": "erainfra-4vcpu-ubuntu-2404", "verdict": "upsize",
     "recommendedProfile": "erainfra-8vcpu-ubuntu-2404", "suggestedProfile": null,
     "current": {"vcpus": 4, "memoryMiB": 16384}, "target": {"vcpus": 8, "memoryMiB": 32768},
     "attempts": 12, "excludedAttempts": 0, "lastSeenAt": "2026-11-05T11:00:00.000Z",
     "cpu": {"p95Vcpus": 3.92, "maxVcpus": 4, "saturatedAttempts": 10},
     "memory": {"peakBytes": 3435973837, "measure": "host-resident", "oomAttempts": 0},
     "explanation": "10 of 12 runs held CPU at 90% or more."},
    {"repo": "acme/web", "job": "lint", "profile": "erainfra-4vcpu-ubuntu-2404", "verdict": "downsize",
     "recommendedProfile": null, "suggestedProfile": "erainfra-1vcpu-ubuntu-2404",
     "current": {"vcpus": 4, "memoryMiB": 16384}, "target": {"vcpus": 1, "memoryMiB": 4096},
     "attempts": 7, "excludedAttempts": 1, "lastSeenAt": "2026-11-05T10:00:00.000Z",
     "cpu": {"p95Vcpus": 0.31, "maxVcpus": 1.2, "saturatedAttempts": 0},
     "memory": {"peakBytes": 1073741824, "measure": "working-set", "oomAttempts": 2},
     "explanation": "Lint barely uses its Profile."},
    {"repo": "acme/api", "job": "build", "profile": "erainfra-4vcpu-ubuntu-2404", "verdict": "insufficient_data",
     "recommendedProfile": null, "suggestedProfile": null,
     "current": {"vcpus": 4, "memoryMiB": 16384}, "target": null,
     "attempts": 2, "excludedAttempts": 0, "lastSeenAt": null,
     "cpu": {"p95Vcpus": 1, "maxVcpus": 1, "saturatedAttempts": 0},
     "memory": {"peakBytes": 0, "measure": "working-set", "oomAttempts": 0},
     "explanation": "Only 2 measured runs."}
  ],
  "map": {"acme/web": {"test": {"erainfra-4vcpu-ubuntu-2404": "erainfra-8vcpu-ubuntu-2404"}}}
}`

func TestRightsizeSendsFiltersAndRendersATable(t *testing.T) {
	h := newHarness(t).loggedIn()
	h.api.on("GET /api/v1/rightsize", 200, rightsizeJSON)
	h.expect(ExitOK, "rightsize", "--repo", "acme/web", "--since", "7d")
	query := h.api.requests[0].URL.Query()
	if query.Get("repo") != "acme/web" || query.Get("since") != "7d" {
		t.Errorf("query = %v", query)
	}
	want := "" +
		"VERDICT          REPO      JOB    PROFILE                     MOVE TO                              CPU P95  PEAK MEM               RUNS\n" +
		"larger           acme/web  test   erainfra-4vcpu-ubuntu-2404  erainfra-8vcpu-ubuntu-2404           3.9/4    3.2 GiB (host)/16 GiB  12\n" +
		"smaller          acme/web  lint   erainfra-4vcpu-ubuntu-2404  register erainfra-1vcpu-ubuntu-2404  0.3/4    1.0 GiB/16 GiB         7 (2 OOM)\n" +
		"not enough data  acme/api  build  erainfra-4vcpu-ubuntu-2404  -                                    1.0/4    0.0 GiB/16 GiB         2\n" +
		"\nacme/web test: 10 of 12 runs held CPU at 90% or more.\n" +
		"\nacme/web lint: Lint barely uses its Profile.\n"
	if h.stdout.String() != want {
		t.Errorf("table:\n%s\nwant:\n%s", h.stdout.String(), want)
	}
}

func TestRightsizeJSONPassesTheBodyThrough(t *testing.T) {
	h := newHarness(t).loggedIn()
	h.api.on("GET /api/v1/rightsize", 200, rightsizeJSON)
	h.expect(ExitOK, "rightsize", "--json")
	var body map[string]any
	if err := json.Unmarshal(h.stdout.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if _, ok := body["policy"]; !ok {
		t.Errorf("--json dropped a field the CLI does not decode: %v", body)
	}
}

func TestRightsizeMapPrintsTheRunsOnRewrite(t *testing.T) {
	h := newHarness(t).loggedIn()
	h.api.on("GET /api/v1/rightsize", 200, rightsizeJSON)
	h.expect(ExitOK, "rightsize", "--map")
	var mapping map[string]map[string]map[string]string
	if err := json.Unmarshal(h.stdout.Bytes(), &mapping); err != nil {
		t.Fatalf("--map is not the documented shape: %v\n%s", err, h.stdout.String())
	}
	if got := mapping["acme/web"]["test"]["erainfra-4vcpu-ubuntu-2404"]; got != "erainfra-8vcpu-ubuntu-2404" {
		t.Errorf("map = %v", mapping)
	}
	if len(mapping) != 1 || len(mapping["acme/web"]) != 1 {
		t.Errorf("map holds entries without a registered Profile: %v", mapping)
	}

	h.api.on("GET /api/v1/rightsize", 200, `{"recommendations":[],"map":{}}`)
	h.expect(ExitOK, "rightsize", "--map")
	if strings.TrimSpace(h.stdout.String()) != "{}" {
		t.Errorf("empty map = %q", h.stdout.String())
	}
}

func TestRightsizeEmptyAndRefused(t *testing.T) {
	h := newHarness(t).loggedIn()
	h.api.on("GET /api/v1/rightsize", 200, `{"truncated":true,"recommendations":[],"map":{}}`)
	h.expect(ExitOK, "rightsize")
	if h.stdout.Len() != 0 || !strings.Contains(h.stderr.String(), "No measured runs in the window.") ||
		!strings.Contains(h.stderr.String(), "narrow the list") {
		t.Errorf("stdout = %q stderr = %q", h.stdout.String(), h.stderr.String())
	}

	h.api.on("GET /api/v1/rightsize", 400,
		`{"error":{"code":"invalid_request","message":"since must be a span such as 24h or 7d, or an RFC 3339 time"}}`)
	h.expect(ExitUsage, "rightsize", "--since", "soon")
	h.expect(ExitUsage, "rightsize", "extra")
}
