package server

import (
	"bytes"
	"io"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/Fanzzzd/erainfra/apps/cache-service/cachetoken"
	"github.com/Fanzzzd/erainfra/apps/cache-service/internal/cacheindex"
	"github.com/Fanzzzd/erainfra/apps/cache-service/internal/config"
)

func (h *harness) putSeed(token string, body []byte) *http.Response {
	h.t.Helper()
	return h.do(http.MethodPut, gitSeedMarker, token, bytes.NewReader(body), nil)
}

func (h *harness) getSeed(token string) (*http.Response, []byte) {
	h.t.Helper()
	response := h.do(http.MethodGet, gitSeedMarker, token, nil, nil)
	return response, readAll(h.t, response)
}

func TestGitSeedRoundTripCarriesRepositoryAndWritability(t *testing.T) {
	h := newHarness(t, nil)
	token := h.pushToken("Fanzzzd/erainfra", "refs/heads/main")

	response, _ := h.getSeed(token)
	if response.StatusCode != http.StatusNotFound {
		t.Fatalf("GET before any save = %d, want 404", response.StatusCode)
	}
	if got := response.Header.Get(headerGitSeedRepository); got != "Fanzzzd/erainfra" {
		t.Fatalf("a miss names repository %q, want the job's", got)
	}
	if got := response.Header.Get(headerGitSeedWritable); got != "true" {
		t.Fatalf("a push to main is writable %q, want true", got)
	}

	seed := payload(3 << 20)
	put := h.putSeed(token, seed)
	_ = put.Body.Close()
	if put.StatusCode != http.StatusCreated {
		t.Fatalf("PUT = %d, want 201", put.StatusCode)
	}

	response, body := h.getSeed(token)
	if response.StatusCode != http.StatusOK || !bytes.Equal(body, seed) {
		t.Fatalf("GET after save = %d with %d bytes, want 200 with the %d saved", response.StatusCode, len(body), len(seed))
	}
	created, err := strconv.ParseInt(response.Header.Get(headerGitSeedCreated), 10, 64)
	if err != nil || created != h.now().Unix() {
		t.Fatalf("created header %q, want %d", response.Header.Get(headerGitSeedCreated), h.now().Unix())
	}
}

// A job reads only its own repository's seed, private repositories included:
// the repository comes from the runner's job facts, never from the request.
func TestGitSeedIsNeverReadAcrossRepositories(t *testing.T) {
	h := newHarness(t, nil)
	owner := h.pushToken("acme/private-app", "refs/heads/main")
	put := h.putSeed(owner, []byte("acme's objects"))
	_ = put.Body.Close()
	if put.StatusCode != http.StatusCreated {
		t.Fatalf("PUT = %d", put.StatusCode)
	}

	other := h.pushToken("someone/else", "refs/heads/main")
	response, body := h.getSeed(other)
	if response.StatusCode != http.StatusNotFound || len(body) == 0 || bytes.Contains(body, []byte("acme")) {
		t.Fatalf("another repository's GET = %d %q, want a 404 that carries none of acme's bytes", response.StatusCode, body)
	}
	if got := response.Header.Get(headerGitSeedRepository); got != "someone/else" {
		t.Fatalf("the other job is told repository %q, want its own", got)
	}
}

// A fork pull request reads its base branch's seed and may not write one,
// exactly as it may not write a cache entry.
func TestGitSeedFollowsTheCacheScopeRules(t *testing.T) {
	h := newHarness(t, nil)
	main := h.pushToken("Fanzzzd/erainfra", "refs/heads/main")
	put := h.putSeed(main, []byte("main's seed"))
	_ = put.Body.Close()

	fork := h.token(cachetoken.JobFacts{
		Repository: "Fanzzzd/erainfra", HeadRepository: "attacker/erainfra", Event: "pull_request",
		Ref: "refs/pull/7/merge", BaseRef: "refs/heads/main", DefaultBranch: "refs/heads/main",
	})
	response, body := h.getSeed(fork)
	if response.StatusCode != http.StatusOK || string(body) != "main's seed" {
		t.Fatalf("fork PR GET = %d %q, want the base branch's seed", response.StatusCode, body)
	}
	if got := response.Header.Get(headerGitSeedWritable); got != "false" {
		t.Fatalf("fork PR writable %q, want false", got)
	}
	refused := h.putSeed(fork, []byte("poison"))
	_ = refused.Body.Close()
	if refused.StatusCode != http.StatusForbidden {
		t.Fatalf("fork PR PUT = %d, want 403", refused.StatusCode)
	}

	feature := h.pushToken("Fanzzzd/erainfra", "refs/heads/feature")
	put = h.putSeed(feature, []byte("feature's seed"))
	_ = put.Body.Close()
	sibling := h.pushToken("Fanzzzd/erainfra", "refs/heads/sibling")
	if _, body := h.getSeed(sibling); string(body) != "main's seed" {
		t.Fatalf("a sibling branch read %q, want the default branch's seed and never the feature branch's", body)
	}
	if _, body := h.getSeed(feature); string(body) != "feature's seed" {
		t.Fatalf("the feature branch read %q, want its own newer seed", body)
	}
}

// A new seed replaces the older ones in its scope, so a repository holds one
// copy per ref rather than one per refresh until idle eviction.
func TestGitSeedSaveReplacesTheOlderSeedInItsScope(t *testing.T) {
	h := newHarness(t, nil)
	token := h.pushToken("Fanzzzd/erainfra", "refs/heads/main")
	for _, body := range []string{"first", "second", "third"} {
		put := h.putSeed(token, []byte(body))
		_ = put.Body.Close()
		if put.StatusCode != http.StatusCreated {
			t.Fatalf("PUT %s = %d", body, put.StatusCode)
		}
		h.advance(time.Minute)
	}
	if _, body := h.getSeed(token); string(body) != "third" {
		t.Fatalf("GET = %q, want the newest", body)
	}
	records, err := h.server.index.Entries(t.Context(), "Fanzzzd/erainfra", cacheindex.Match{
		Prefix: gitSeedKeyPrefix, Version: gitSeedVersion,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 1 {
		t.Fatalf("%d seeds left in the scope, want 1", len(records))
	}
}

// The reserved version keeps a seed out of an actions/cache restore of a
// look-alike key, and the other way round.
func TestGitSeedIsSeparateFromActionsCacheEntries(t *testing.T) {
	h := newHarness(t, nil)
	token := h.pushToken("Fanzzzd/erainfra", "refs/heads/main")
	h.saveV1(token, gitSeedKeyPrefix+"user", "user-version", []byte("a user's entry"),
		[]chunk{{start: 0, length: len("a user's entry")}})
	if response, _ := h.getSeed(token); response.StatusCode != http.StatusNotFound {
		t.Fatalf("GET = %d after a user saved a look-alike key, want 404", response.StatusCode)
	}
}

func TestGitSeedRefusesWhatItCannotStore(t *testing.T) {
	h := newHarness(t, func(cfg *config.Config) { cfg.MaxEntryBytes = 1 << 10 })
	token := h.pushToken("Fanzzzd/erainfra", "refs/heads/main")

	if response := h.do(http.MethodGet, gitSeedMarker, "", nil, nil); response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("GET without a token = %d, want 401", response.StatusCode)
	}
	if response := h.putSeed(token, payload(2<<10)); response.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("PUT over the entry limit = %d, want 413", response.StatusCode)
	}
	// A reader the client cannot size goes out chunked, with no length.
	chunked := h.do(http.MethodPut, gitSeedMarker, token, io.MultiReader(strings.NewReader("abc")), nil)
	if chunked.StatusCode != http.StatusLengthRequired {
		t.Fatalf("PUT without a length = %d, want 411", chunked.StatusCode)
	}
	if response := h.do(http.MethodPost, gitSeedMarker, token, nil, nil); response.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("POST = %d, want 405", response.StatusCode)
	}
}
