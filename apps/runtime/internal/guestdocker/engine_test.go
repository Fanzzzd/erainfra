package guestdocker

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

// The daemon's own response shapes, trimmed to the fields the client reads
// plus a few it must ignore.
func fakeDaemon(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/events":
			var filters map[string][]string
			if err := json.Unmarshal([]byte(r.URL.Query().Get("filters")), &filters); err != nil {
				http.Error(w, "bad filters", http.StatusBadRequest)
				return
			}
			if filters["type"][0] != "container" || filters["event"][0] != "start" {
				http.Error(w, "unexpected filters", http.StatusBadRequest)
				return
			}
			w.WriteHeader(http.StatusOK)
			// An event the filter should have excluded, then a real start.
			_, _ = fmt.Fprintln(w, `{"Type":"network","Action":"connect","Actor":{"ID":"net1"}}`)
			_, _ = fmt.Fprintln(w, `{"status":"start","id":"abc","Type":"container","Action":"start","Actor":{"ID":"abc","Attributes":{"image":"moby/buildkit"}},"scope":"local"}`)
		case "/containers/json":
			_, _ = fmt.Fprint(w, `[{"Id":"abc","Names":["/buildx_buildkit_builder0"]},{"Id":"def"}]`)
		case "/containers/abc/json":
			_, _ = fmt.Fprint(w, `{"Id":"abc","State":{"Status":"running","Running":true,"Pid":4242},"Config":{"Env":["SSL_CERT_DIR=/etc/ssl/certs"]},"HostConfig":{"NetworkMode":"host"},"HostsPath":"/var/lib/docker/containers/abc/hosts"}`)
		default:
			http.Error(w, `{"message":"No such container"}`, http.StatusNotFound)
		}
	}))
}

func TestClientReadsTheDaemonsShapes(t *testing.T) {
	server := fakeDaemon(t)
	defer server.Close()
	client := newClientForURL(server.URL, server.Client())

	stream, err := client.Subscribe(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	id, err := stream.Next()
	if err != nil || id != "abc" {
		t.Fatalf("Next = %q, %v; want the container start, not the network event", id, err)
	}
	if _, err := stream.Next(); err == nil {
		t.Fatal("an ended stream did not report it")
	}
	_ = stream.Close()

	ids, err := client.Running(t.Context())
	if err != nil || len(ids) != 2 || ids[0] != "abc" {
		t.Fatalf("Running = %v, %v", ids, err)
	}

	container, err := client.Inspect(t.Context(), "abc")
	if err != nil {
		t.Fatal(err)
	}
	if !container.Running || container.Pid != 4242 || container.HostsPath != "/var/lib/docker/containers/abc/hosts" ||
		len(container.Env) != 1 || container.Env[0] != "SSL_CERT_DIR=/etc/ssl/certs" {
		t.Fatalf("Inspect = %+v", container)
	}

	if _, err := client.Inspect(t.Context(), "gone"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Inspect of a removed container = %v, want ErrNotFound", err)
	}
}
