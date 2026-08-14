package convexstore

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Fanzzzd/EraInfra/apps/controller/internal/fleet"
)

func TestStoreUsesAuthenticatedFleetProtocol(t *testing.T) {
	var created fleet.NewAttempt
	var registered fleet.ProfileSpec
	var completedCleanup fleet.RunnerCleanup
	var started map[string]any
	var completed map[string]any
	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer controller-secret" {
			http.Error(response, "unauthorized", http.StatusUnauthorized)
			return
		}
		switch request.URL.Path {
		case "/controller/profiles":
			if err := json.NewDecoder(request.Body).Decode(&registered); err != nil {
				t.Fatal(err)
			}
			response.WriteHeader(http.StatusNoContent)
		case "/controller/attempts":
			if request.Method == http.MethodGet {
				if request.URL.Query().Get("profile") != "rc linux/js" {
					t.Errorf("profile query = %q", request.URL.Query().Get("profile"))
				}
				_ = json.NewEncoder(response).Encode(map[string]any{"attempts": []map[string]any{{
					"runnerName": "runner-a",
					"runnerId":   7,
					"state":      "ready",
					"createdAt":  1_786_300_000_000,
				}}})
				return
			}
			if err := json.NewDecoder(request.Body).Decode(&created); err != nil {
				t.Fatal(err)
			}
			response.WriteHeader(http.StatusNoContent)
		case "/controller/attempts/cancel":
			response.WriteHeader(http.StatusNoContent)
		case "/controller/jobs/started":
			if err := json.NewDecoder(request.Body).Decode(&started); err != nil {
				t.Fatal(err)
			}
			response.WriteHeader(http.StatusNoContent)
		case "/controller/jobs/completed":
			if err := json.NewDecoder(request.Body).Decode(&completed); err != nil {
				t.Fatal(err)
			}
			response.WriteHeader(http.StatusNoContent)
		case "/controller/runner-cleanups":
			_ = json.NewEncoder(response).Encode(map[string]any{"cleanups": []map[string]any{{
				"runnerName": "orphan-a",
				"runnerId":   19,
			}}})
		case "/controller/runner-cleanups/complete":
			var payload struct {
				Profile string `json:"profile"`
				fleet.RunnerCleanup
			}
			if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
				t.Fatal(err)
			}
			completedCleanup = payload.RunnerCleanup
			response.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(response, request)
		}
	}))
	defer server.Close()

	store, err := New(server.URL, "controller-secret", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	profile := fleet.ProfileSpec{
		Name:         "rc-linux-js",
		ScaleSetName: "rc-linux-js",
		Executor:     "firecracker",
		ImageRelease: "image@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		VCPUs:        2,
		MemoryMiB:    4096,
		MaxRunners:   2,
	}
	if err := store.RegisterProfile(t.Context(), profile); err != nil {
		t.Fatal(err)
	}
	if registered != profile {
		t.Fatalf("registered = %#v, want %#v", registered, profile)
	}
	attempts, err := store.ListActiveAttempts(t.Context(), "rc linux/js")
	if err != nil {
		t.Fatal(err)
	}
	if len(attempts) != 1 || attempts[0].RunnerName != "runner-a" {
		t.Fatalf("attempts = %#v", attempts)
	}

	input := fleet.NewAttempt{
		Profile:          "rc-linux-js",
		Executor:         "firecracker",
		ImageRelease:     "ghcr.io/fanzzzd/runner@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		VCPUs:            2,
		MemoryMiB:        4096,
		RunnerName:       "runner-b",
		RunnerID:         8,
		EncodedJITConfig: "single-use-secret",
	}
	if err := store.CreateAttempt(t.Context(), input); err != nil {
		t.Fatal(err)
	}
	if created != input {
		t.Fatalf("created = %#v, want %#v", created, input)
	}
	if err := store.CancelAttempt(t.Context(), input.Profile, input.RunnerName, "scale down"); err != nil {
		t.Fatal(err)
	}
	cleanups, err := store.ListRunnerCleanups(t.Context(), input.Profile)
	if err != nil {
		t.Fatal(err)
	}
	if len(cleanups) != 1 || cleanups[0].RunnerID != 19 {
		t.Fatalf("cleanups = %#v", cleanups)
	}
	if err := store.CompleteRunnerCleanup(t.Context(), input.Profile, cleanups[0]); err != nil {
		t.Fatal(err)
	}
	if completedCleanup != cleanups[0] {
		t.Fatalf("completed cleanup = %#v", completedCleanup)
	}

	const opaqueRequestID = int64(9_007_199_254_740_993)
	if err := store.MarkJobStarted(t.Context(), fleet.JobStarted{
		Profile:         input.Profile,
		RunnerName:      input.RunnerName,
		RunnerRequestID: opaqueRequestID,
		Repository:      "runner-center",
		Owner:           "Fanzzzd",
		JobID:           "job-1",
		DisplayName:     "check",
		WorkflowRunID:   99,
		EventName:       "pull_request",
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.MarkJobCompleted(t.Context(), fleet.JobCompleted{
		Profile:         input.Profile,
		RunnerName:      input.RunnerName,
		RunnerRequestID: opaqueRequestID,
		JobID:           "job-1",
		Result:          "succeeded",
	}); err != nil {
		t.Fatal(err)
	}
	for name, payload := range map[string]map[string]any{"started": started, "completed": completed} {
		if payload["runnerRequestId"] != "9007199254740993" {
			t.Fatalf("%s runnerRequestId = %#v", name, payload["runnerRequestId"])
		}
	}
}

func TestStoreDoesNotReflectJITOnFailure(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		var payload map[string]any
		_ = json.NewDecoder(request.Body).Decode(&payload)
		http.Error(response, "rejected "+payload["encodedJITConfig"].(string), http.StatusBadRequest)
	}))
	defer server.Close()

	store, err := New(server.URL, "token", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	err = store.CreateAttempt(t.Context(), fleet.NewAttempt{
		Profile:          "rc-linux-js",
		Executor:         "firecracker",
		ImageRelease:     "ghcr.io/fanzzzd/runner@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		VCPUs:            2,
		MemoryMiB:        4096,
		RunnerName:       "runner-a",
		RunnerID:         9,
		EncodedJITConfig: "must-not-leak",
	})
	if err == nil {
		t.Fatal("CreateAttempt succeeded")
	}
	if strings.Contains(err.Error(), "must-not-leak") {
		t.Fatalf("error leaked JIT: %v", err)
	}
}

func TestStoreRequiresHTTPSAndToken(t *testing.T) {
	if _, err := New("http://runner-center.example", "token", nil); err == nil {
		t.Fatal("HTTP URL accepted")
	}
	if _, err := New("https://runner-center.example", "", nil); err == nil {
		t.Fatal("empty token accepted")
	}
}

func TestOptionalInt64OmitsUnavailableGitHubRequestID(t *testing.T) {
	if actual := optionalInt64(0); actual != "" {
		t.Fatalf("optionalInt64(0) = %q", actual)
	}
	if actual := optionalInt64(9_007_199_254_740_993); actual != "9007199254740993" {
		t.Fatalf("optionalInt64(unsafe JS integer) = %q", actual)
	}
}
