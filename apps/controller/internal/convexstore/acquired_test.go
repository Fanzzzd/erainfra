package convexstore

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"

	"github.com/Fanzzzd/erainfra/apps/controller/internal/fleet"
)

func TestRecordJobsAcquiredPostsTheRunOfEachJob(t *testing.T) {
	var got map[string]any
	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/controller/jobs/acquired" || request.Header.Get("Authorization") != "Bearer controller-secret" {
			http.Error(response, "not found", http.StatusNotFound)
			return
		}
		if err := json.NewDecoder(request.Body).Decode(&got); err != nil {
			t.Error(err)
		}
		response.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	store, err := New(server.URL, "controller-secret", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	queued := time.UnixMilli(1_763_000_000_000)
	err = store.RecordJobsAcquired(t.Context(), "rc-linux-js", []fleet.AcquiredJob{{
		RunnerRequestID: 9_007_199_254_740_993, Repository: "payable", Owner: "example-org",
		JobID: "job-1", DisplayName: "e2e", WorkflowRunID: 4242, QueueTime: queued,
	}})
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]any{
		"profile": "rc-linux-js",
		"jobs": []any{map[string]any{
			// A decimal string: the id can exceed what a JavaScript number holds exactly.
			"runnerRequestId": "9007199254740993",
			"repository":      "payable",
			"owner":           "example-org",
			"jobId":           "job-1",
			"displayName":     "e2e",
			"workflowRunId":   float64(4242),
			"queueTime":       float64(1_763_000_000_000),
		}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("body = %#v\nwant %#v", got, want)
	}
}

func TestRecordJobsAcquiredReportsAnOlderControlPlane(t *testing.T) {
	server := httptest.NewTLSServer(http.NotFoundHandler())
	defer server.Close()
	store, err := New(server.URL, "controller-secret", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	if err := store.RecordJobsAcquired(t.Context(), "rc-linux-js", []fleet.AcquiredJob{{RunnerRequestID: 1}}); err == nil {
		t.Fatal("a 404 from a control plane without the route must be an error")
	}
}
