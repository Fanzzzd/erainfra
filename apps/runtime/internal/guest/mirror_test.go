package guest

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestMetadataCarriesTheRegistryMirror(t *testing.T) {
	const mirror = "http://10.20.0.5:5000"
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/latest/api/token":
			_, _ = response.Write([]byte("mmds-token"))
		case "/latest/meta-data/runner-center":
			_ = json.NewEncoder(response).Encode(Metadata{RunnerName: "runner-a", JITConfig: "jit", RegistryMirrorURL: mirror})
		default:
			http.NotFound(response, request)
		}
	}))
	defer server.Close()

	metadata, err := NewMetadataClient(server.URL, server.Client()).Fetch(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if metadata.RegistryMirrorURL != mirror {
		t.Fatalf("registry_mirror_url = %q, want %q", metadata.RegistryMirrorURL, mirror)
	}
}

// The reading edge re-checks the mirror because the guest writes it into
// daemon.json, where a value dockerd rejects stops dockerd from restarting.
func TestMetadataRefusesAMirrorDockerdWouldReject(t *testing.T) {
	metadata := Metadata{RunnerName: "rc-a", JITConfig: "secret", RegistryMirrorURL: "10.20.0.5:5000"}
	if err := metadata.Validate(); err == nil {
		t.Fatal("a mirror with no scheme was accepted")
	}
	metadata.RegistryMirrorURL = "https://mirror.lan"
	if err := metadata.Validate(); err != nil {
		t.Fatalf("a valid mirror was refused: %v", err)
	}
}
