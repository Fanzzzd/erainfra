package convexstore

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/Fanzzzd/erainfra/apps/controller/internal/fleet"
)

func TestLeaseTransportFencesEveryRouteAndCancelsHolderOnStaleEpoch(t *testing.T) {
	current := int64(7)
	calls := 0
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Header.Get("X-EraInfra-Lease-Epoch") != "7" {
			w.WriteHeader(http.StatusPreconditionFailed)
			return
		}
		switch r.URL.Path {
		case "/controller/attempts":
			if r.Method == http.MethodGet {
				_, _ = w.Write([]byte(`{"attempts":[]}`))
				return
			}
		case "/controller/runner-cleanups":
			_, _ = w.Write([]byte(`{"cleanups":[]}`))
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	store, err := New(server.URL, "machine-token", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	holder, stop := context.WithCancel(t.Context())
	defer stop()
	leased := store.WithLease(current, stop)
	routes := []func(context.Context) error{
		func(ctx context.Context) error { return leased.RegisterProfile(ctx, fleet.ProfileSpec{Name: "p"}) },
		func(ctx context.Context) error { _, err := leased.PauseProfile(ctx, "p"); return err },
		func(ctx context.Context) error { _, err := leased.ListActiveAttempts(ctx, "p"); return err },
		func(ctx context.Context) error { _, err := leased.ListRunnerCleanups(ctx, "p"); return err },
		func(ctx context.Context) error { return leased.CompleteRunnerCleanup(ctx, "p", fleet.RunnerCleanup{}) },
		func(ctx context.Context) error { return leased.CreateAttempt(ctx, fleet.NewAttempt{Profile: "p"}) },
		func(ctx context.Context) error { return leased.CancelAttempt(ctx, "p", "r", "reason") },
		func(ctx context.Context) error { return leased.MarkJobStarted(ctx, fleet.JobStarted{Profile: "p"}) },
		func(ctx context.Context) error { return leased.MarkJobCompleted(ctx, fleet.JobCompleted{Profile: "p"}) },
		func(ctx context.Context) error {
			return leased.SendHeartbeat(ctx, fleet.ControllerHeartbeat{Profile: "p", LeaseRole: "holder", LeaseEpoch: 7})
		},
	}
	for i, route := range routes {
		if err := route(holder); err != nil {
			t.Fatalf("route %d: %v", i, err)
		}
	}
	if calls != len(routes) {
		t.Fatal(calls)
	}
	// A different Store for a future epoch does not update this old client's
	// authority; its write is refused and cancels its holder immediately.
	stale := store.WithLease(6, stop)
	if err := stale.CreateAttempt(holder, fleet.NewAttempt{Profile: "p"}); !errors.Is(err, fleet.ErrLeaseLost) {
		t.Fatal(err)
	}
	if holder.Err() == nil {
		t.Fatal("stale refusal did not stop holder")
	}
}

func TestAcquireRenewReleaseAndInstallationTokenProtocol(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer machine-token" {
			t.Error("credential missing")
		}
		switch r.URL.Path {
		case "/controller/lease/acquire":
			var body leaseRequest
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
			}
			if body.Instance != "instance-12345678" {
				t.Error(body)
			}
			_, _ = w.Write([]byte(`{"granted":true,"epoch":3,"ttlMs":30000,"renewIntervalMs":10000,"profile":{"name":"p","githubConfigUrl":"https://github.com/acme/repo"}}`))
		case "/controller/lease/renew":
			if r.Header.Get("X-EraInfra-Lease-Epoch") != "3" {
				t.Error("renew not fenced")
			}
			_, _ = w.Write([]byte(`{"epoch":3,"ttlMs":30000,"renewIntervalMs":10000}`))
		case "/controller/lease/release":
			if r.Header.Get("X-EraInfra-Lease-Epoch") != "3" {
				t.Error("release not fenced")
			}
			w.WriteHeader(204)
		case "/controller/github-token":
			if r.Header.Get("X-EraInfra-Lease-Epoch") != "3" {
				t.Error("token mint not fenced")
			}
			_, _ = w.Write([]byte(`{"token":"installation-token","expiresAt":1800000000000}`))
		default:
			t.Error(r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	store, err := New(server.URL, "machine-token", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	grant, err := store.AcquireLease(t.Context(), "p", "host", "instance-12345678")
	if err != nil || grant.Epoch != 3 || grant.Profile.RegistrationURL != "https://github.com/acme/repo" {
		t.Fatalf("%+v %v", grant, err)
	}
	if _, err := store.RenewLease(t.Context(), "p", "host", "instance-12345678", 3); err != nil {
		t.Fatal(err)
	}
	token, until, err := store.WithLease(3, nil).GitHubToken(t.Context(), "p", false)
	if err != nil || token != "installation-token" || !until.Equal(time.UnixMilli(1800000000000)) {
		t.Fatalf("%s %v %v", token, until, err)
	}
	if err := store.ReleaseLease(t.Context(), "p", "host", "instance-12345678", 3); err != nil {
		t.Fatal(err)
	}
}
