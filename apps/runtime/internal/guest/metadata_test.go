package guest

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestMetadataClientUsesMMDSv2WithoutLeakingJIT(t *testing.T) {
	const secret = "single-use-jit"
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/latest/api/token":
			if request.Method != http.MethodPut || request.Header.Get("X-Metadata-Token-TTL-Seconds") == "" {
				http.Error(response, "bad token request", http.StatusBadRequest)
				return
			}
			_, _ = response.Write([]byte("mmds-token"))
		case "/latest/meta-data/runner-center":
			if request.Header.Get("X-Metadata-Token") != "mmds-token" {
				http.Error(response, "unauthorized", http.StatusUnauthorized)
				return
			}
			_ = json.NewEncoder(response).Encode(Metadata{
				RunnerName:     "runner-a",
				JITConfig:      secret,
				ShutdownOnExit: true,
			})
		default:
			http.NotFound(response, request)
		}
	}))
	defer server.Close()

	metadata, err := NewMetadataClient(server.URL, server.Client()).Fetch(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if metadata.RunnerName != "runner-a" || metadata.JITConfig != secret {
		t.Fatalf("metadata = %#v", metadata)
	}
	if strings.Contains(errString(err), secret) {
		t.Fatal("JIT leaked into an error")
	}
}

func TestMetadataClientWaitsForClaimUntilContextEnds(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		http.Error(response, "not claimed", http.StatusNotFound)
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Millisecond)
	defer cancel()
	_, err := NewMetadataClient(server.URL, server.Client()).Fetch(ctx)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Fetch error = %v, want context deadline", err)
	}
}

func TestMetadataValidationNeverEchoesJIT(t *testing.T) {
	metadata := Metadata{JITConfig: "must-not-leak"}
	err := metadata.Validate()
	if err == nil {
		t.Fatal("invalid metadata accepted")
	}
	if strings.Contains(err.Error(), metadata.JITConfig) {
		t.Fatalf("validation leaked JIT: %v", err)
	}
}

func TestMetadataAcceptsExperimentWithoutJIT(t *testing.T) {
	metadata := Metadata{
		Kind:        "experiment",
		RunnerName:  "experiment-a",
		Command:     []string{"node", "--version"},
		ResultToken: "result-token",
	}
	if err := metadata.Validate(); err != nil {
		t.Fatal(err)
	}
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
