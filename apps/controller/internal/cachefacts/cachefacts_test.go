package cachefacts

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

var testKey = []byte("erainfra-cache-service-signing-key-0123456789")

func sign(body []byte) string {
	mac := hmac.New(sha256.New, testKey)
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}

func TestNewRejectsUnusableConfig(t *testing.T) {
	if _, err := New("", testKey, time.Hour); err == nil {
		t.Fatal("empty base URL was accepted")
	}
	if _, err := New("http://c", testKey[:8], time.Hour); err == nil {
		t.Fatal("short signing key was accepted")
	}
	if _, err := New("http://c", testKey, 0); err == nil {
		t.Fatal("non-positive ttl was accepted")
	}
}

// A push carries the facts as JSON to the admin path, signs the exact body it
// sends, and stamps an expiry ttl from now. The test server plays the cache
// service: it recomputes the signature and rejects a body it cannot verify.
func TestPushSignsAndStampsExpiry(t *testing.T) {
	fixedNow := time.Date(2026, 8, 26, 9, 0, 0, 0, time.UTC)

	var got request
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != factsPath {
			t.Errorf("push hit %s %s", r.Method, r.URL.Path)
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatal(err)
		}
		if r.Header.Get(adminHeader) != sign(body) {
			http.Error(w, "bad signature", http.StatusUnauthorized)
			return
		}
		if err := json.Unmarshal(body, &got); err != nil {
			t.Fatal(err)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	client, err := New(server.URL, testKey, 6*time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	client.now = func() time.Time { return fixedNow }

	err = client.Push(t.Context(), Facts{
		Runner:     "rc-linux-js-a",
		Repository: "Fanzzzd/erainfra",
		Event:      "push",
		Ref:        "refs/heads/main",
	})
	if err != nil {
		t.Fatalf("push: %v", err)
	}

	if got.Runner != "rc-linux-js-a" || got.Repository != "Fanzzzd/erainfra" ||
		got.Event != "push" || got.Ref != "refs/heads/main" {
		t.Fatalf("pushed facts = %#v", got)
	}
	if want := fixedNow.Add(6 * time.Hour).Unix(); got.ExpiresUnix != want {
		t.Fatalf("expiresUnix = %d, want %d", got.ExpiresUnix, want)
	}
}

// A push the service refuses is an error the caller can log, not a silent
// success — otherwise a misconfigured key would look like a working cache.
func TestPushErrorsOnRejection(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer server.Close()

	client, err := New(server.URL, testKey, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Push(t.Context(), Facts{Runner: "rc-a", Repository: "o/r", Ref: "refs/heads/main"}); err == nil {
		t.Fatal("a 401 push reported success")
	}
}

// A cache service that is down is an error too, not a panic: the connection
// refused surfaces so the caller logs it and the job proceeds.
func TestPushErrorsWhenUnreachable(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	url := server.URL
	server.Close()

	client, err := New(url, testKey, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Push(t.Context(), Facts{Runner: "rc-a", Repository: "o/r", Ref: "refs/heads/main"}); err == nil {
		t.Fatal("a push to a closed server reported success")
	}
}
