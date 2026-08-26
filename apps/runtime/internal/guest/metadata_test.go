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

func TestMetadataCarriesTheRunnerBearer(t *testing.T) {
	const bearer = "erainfra-cache-runner-v1.payload.signature"
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/latest/api/token":
			_, _ = response.Write([]byte("mmds-token"))
		case "/latest/meta-data/runner-center":
			_ = json.NewEncoder(response).Encode(Metadata{
				RunnerName:       "runner-a",
				JITConfig:        "jit",
				CacheRunnerToken: bearer,
				ShutdownOnExit:   true,
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
	if metadata.CacheRunnerToken != bearer {
		t.Fatalf("cache_runner_token = %q, want %q", metadata.CacheRunnerToken, bearer)
	}
	if err := metadata.Validate(); err != nil {
		t.Fatalf("a bearer-carrying metadata failed validation: %v", err)
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

func TestMetadataCacheEndpointIsCheckedAtTheReadingEdge(t *testing.T) {
	valid := Metadata{RunnerName: "rc-a", JITConfig: "secret"}
	valid.CacheURL = "https://cache.internal:8080/v1"
	valid.CacheServiceV2 = "false"
	if err := valid.Validate(); err != nil {
		t.Fatal(err)
	}

	// The host validated these already; the reading edge re-checks so a
	// confused MMDS value still cannot put whitespace into the runner's
	// environment.
	for _, tweak := range []func(*Metadata){
		func(m *Metadata) { m.CacheURL = "cache.internal" },
		func(m *Metadata) { m.CacheURL = "https://cache.internal/a b" },
		func(m *Metadata) { m.CacheURL = "https://" },
		func(m *Metadata) { m.CacheURL = "http://" },
		func(m *Metadata) { m.CacheURL = "https:///v1" },
		func(m *Metadata) { m.CacheServiceV2 = "True" },
	} {
		metadata := valid
		tweak(&metadata)
		if err := metadata.Validate(); err == nil {
			t.Fatalf("invalid cache endpoint accepted: %+v", metadata)
		}
	}
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
