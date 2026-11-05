package main

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/Fanzzzd/erainfra/apps/controller/internal/config"
	"github.com/Fanzzzd/erainfra/apps/controller/internal/convexstore"
)

// Drive the executable's holder wiring, not just the Reporter in isolation:
// even a failed initial GitHub-token fetch must leave a fenced stopped report.
func TestHolderReportsLeaseAndInitializationFailure(t *testing.T) {
	var mu sync.Mutex
	var reports []map[string]any
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-EraInfra-Lease-Epoch") != "7" {
			t.Error("holder request was not fenced")
		}
		if r.URL.Path == "/controller/github-token" {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		if r.URL.Path != "/controller/heartbeat" {
			t.Errorf("unexpected request %s", r.URL.Path)
			w.WriteHeader(404)
			return
		}
		var report map[string]any
		if err := json.NewDecoder(r.Body).Decode(&report); err != nil {
			t.Error(err)
		}
		mu.Lock()
		reports = append(reports, report)
		mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	store, err := convexstore.New(server.URL, "0123456789abcdef0123456789abcdef", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	cfg := config.Config{Profile: "rc-linux-js", MachineToken: "0123456789abcdef0123456789abcdef"}
	if err := runHolder(t.Context(), cfg, store.WithLease(7, nil), "worker", 7, slog.New(slog.NewTextHandler(io.Discard, nil))); err == nil {
		t.Fatal("missing credentials should fail holder initialization")
	}
	mu.Lock()
	defer mu.Unlock()
	if len(reports) == 0 {
		t.Fatal("initialization failure left no heartbeat")
	}
	final := reports[len(reports)-1]
	if final["sessionState"] != "stopped" {
		t.Fatalf("final state = %v", final)
	}
	lease, ok := final["lease"].(map[string]any)
	if !ok || lease["role"] != "holder" || lease["epoch"] != float64(7) {
		t.Fatalf("lease state = %v", final["lease"])
	}
}
