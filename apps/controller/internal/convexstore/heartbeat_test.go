package convexstore

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/Fanzzzd/erainfra/apps/controller/internal/fleet"
)

func TestSendHeartbeatPostsTheReportWithTheControllerToken(t *testing.T) {
	var body map[string]any
	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost || request.URL.Path != "/controller/heartbeat" {
			http.Error(response, "not found", http.StatusNotFound)
			return
		}
		if request.Header.Get("Authorization") != "Bearer controller-secret" {
			http.Error(response, "unauthorized", http.StatusUnauthorized)
			return
		}
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		response.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	store, err := New(server.URL, "controller-secret", server.Client())
	if err != nil {
		t.Fatal(err)
	}

	started := time.UnixMilli(1_786_300_000_000)
	err = store.SendHeartbeat(t.Context(), fleet.ControllerHeartbeat{
		Profile:       "erainfra-4vcpu-ubuntu-2404",
		Hostname:      "oracle-singapore-1",
		Version:       "0.2.0-rc.11",
		ScaleSetID:    42,
		SessionState:  fleet.SessionListening,
		LastMessageAt: started.Add(time.Minute),
		AssignedJobs:  3,
		RunningJobs:   2,
		StartedAt:     started,
	})
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]any{
		"profile":       "erainfra-4vcpu-ubuntu-2404",
		"hostname":      "oracle-singapore-1",
		"version":       "0.2.0-rc.11",
		"scaleSetId":    float64(42),
		"sessionState":  "listening",
		"lastMessageAt": float64(1_786_300_060_000),
		"assignedJobs":  float64(3),
		"runningJobs":   float64(2),
		"startedAt":     float64(1_786_300_000_000),
	}
	for key, value := range want {
		if body[key] != value {
			t.Errorf("%s = %#v, want %#v", key, body[key], value)
		}
	}
	if _, present := body["lastError"]; present {
		t.Errorf("an empty error must be omitted, got %#v", body["lastError"])
	}
}

func TestSendHeartbeatOmitsWhatIsNotKnownYetAndCapsTheError(t *testing.T) {
	var body map[string]any
	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		response.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	store, err := New(server.URL, "controller-secret", server.Client())
	if err != nil {
		t.Fatal(err)
	}

	err = store.SendHeartbeat(t.Context(), fleet.ControllerHeartbeat{
		Profile:      "erainfra-4vcpu-ubuntu-2404",
		Hostname:     "host",
		Version:      "dev",
		SessionState: fleet.SessionConflict,
		LastError:    strings.Repeat("é", 2_000),
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"lastMessageAt", "scaleSetId", "startedAt"} {
		if _, present := body[key]; present {
			t.Errorf("%s must be omitted before it is known, got %#v", key, body[key])
		}
	}
	lastError, _ := body["lastError"].(string)
	if count := utf8.RuneCountInString(lastError); count != maxHeartbeatErrorRunes {
		t.Fatalf("lastError has %d characters, want %d", count, maxHeartbeatErrorRunes)
	}
}
