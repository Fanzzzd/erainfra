package guest

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestMetadataCarriesTheAptMirror(t *testing.T) {
	const mirror = "http://10.20.0.7:3142"
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/latest/api/token":
			_, _ = response.Write([]byte("mmds-token"))
		case "/latest/meta-data/runner-center":
			_ = json.NewEncoder(response).Encode(Metadata{RunnerName: "runner-a", JITConfig: "jit", AptMirrorURL: mirror})
		default:
			http.NotFound(response, request)
		}
	}))
	defer server.Close()

	metadata, err := NewMetadataClient(server.URL, server.Client()).Fetch(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if metadata.AptMirrorURL != mirror {
		t.Fatalf("apt_mirror_url = %q, want %q", metadata.AptMirrorURL, mirror)
	}
}

// The reading edge re-checks the mirror because its host lands in a shell
// script the guest writes.
func TestMetadataRefusesAnAptMirrorTheScriptCannotTake(t *testing.T) {
	metadata := Metadata{RunnerName: "rc-a", JITConfig: "secret", AptMirrorURL: "http://$(reboot).lan"}
	if err := metadata.Validate(); err == nil {
		t.Fatal("a mirror with shell in its host was accepted")
	}
	metadata.AptMirrorURL = "http://10.20.0.7:3142"
	if err := metadata.Validate(); err != nil {
		t.Fatalf("a valid mirror was refused: %v", err)
	}
}
