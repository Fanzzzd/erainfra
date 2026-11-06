package gitmirror

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func pkt(line string) string { return fmt.Sprintf("%04x%s", len(line)+4, line) }

func fetchBody(wants ...string) []byte {
	var body strings.Builder
	body.WriteString(pkt("command=fetch\n"))
	body.WriteString(pkt("object-format=sha1\n"))
	body.WriteString("0001")
	body.WriteString(pkt("thin-pack\n"))
	body.WriteString(pkt("ofs-delta\n"))
	body.WriteString(pkt("deepen 1\n"))
	for _, want := range wants {
		body.WriteString(pkt("want " + want + "\n"))
	}
	body.WriteString(pkt("done\n"))
	body.WriteString("0000")
	return []byte(body.String())
}

func TestParseRequestReadsAFetch(t *testing.T) {
	want := strings.Repeat("ab", 20)
	request, err := parseRequest(fetchBody(want))
	if err != nil {
		t.Fatal(err)
	}
	if request.command != "fetch" || len(request.wants) != 1 || request.wants[0] != want || request.wantRefs {
		t.Fatalf("parsed %+v", request)
	}

	refs, err := parseRequest([]byte(pkt("command=fetch\n") + "0001" + pkt("want-ref refs/heads/main\n") + "0000"))
	if err != nil || !refs.wantRefs {
		t.Fatalf("want-ref parsed as %+v, %v", refs, err)
	}

	for name, body := range map[string]string{
		"no flush":         pkt("command=fetch\n"),
		"bad length":       "zzzzcommand=fetch\n0000",
		"length past end":  "00ffcommand=fetch\n",
		"reserved length":  "0003",
		"want not an oid":  pkt("command=fetch\n") + "0001" + pkt("want HEAD; rm -rf /\n") + "0000",
		"want upper case":  pkt("command=fetch\n") + "0001" + pkt("want "+strings.Repeat("AB", 20)+"\n") + "0000",
		"want short":       pkt("command=fetch\n") + "0001" + pkt("want abc\n") + "0000",
		"truncated header": "00",
	} {
		if _, err := parseRequest([]byte(body)); err == nil {
			t.Errorf("%s: parsed without error", name)
		}
	}
}

func TestUploadPackRepositoryMatchesGitHubPaths(t *testing.T) {
	for path, want := range map[string]string{
		"/acme/app/git-upload-pack":         "acme/app",
		"/acme/app.git/git-upload-pack":     "acme/app",
		"/acme/my.repo/git-upload-pack":     "acme/my.repo",
		"/acme/app/info/refs":               "",
		"/acme/app/git-receive-pack":        "",
		"/acme/app/x/git-upload-pack":       "",
		"/../app/git-upload-pack":           "",
		"/acme/app/git-upload-pack/../evil": "",
	} {
		got, ok := uploadPackRepository(path)
		if (want == "") == ok || got != want {
			t.Errorf("%s: got %q, %v; want %q", path, got, ok, want)
		}
	}
}

// The mirror checks the client's credential with GitHub on every fetch it
// answers, even when it holds every wanted object. This sends the fetch
// request itself, as git would after a ref listing it got some other way, so
// GitHub's refusal of the ref listing cannot be what stops it.
func TestMirrorChecksTheCredentialOnEveryFetch(t *testing.T) {
	gitPath := requireGit(t)
	fake := newFakeGitHub(t, gitPath)
	repo := fake.newRepository(t, "acme/private-app")
	basicHistory(repo)
	sha := runGit(t, repo.env, repo.bare, "rev-parse", "refs/heads/main")
	g := startGuest(t, fake, &memorySeeds{repository: "acme/private-app", seed: repo.seedBundle(), created: time.Now()})

	send := func(token string, gzipped bool) *httptest.ResponseRecorder {
		body := fetchBody(sha)
		request := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "https://github.com/acme/private-app/git-upload-pack", nil)
		if gzipped {
			var compressed bytes.Buffer
			writer := gzip.NewWriter(&compressed)
			_, _ = writer.Write(body)
			_ = writer.Close()
			body = compressed.Bytes()
			request.Header.Set("Content-Encoding", "gzip")
		}
		request.Body = io.NopCloser(bytes.NewReader(body))
		request.ContentLength = int64(len(body))
		request.Header.Set("Git-Protocol", "version=2")
		request.Header.Set("Content-Type", "application/x-git-upload-pack-request")
		request.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte("x-access-token:"+token)))
		recorder := httptest.NewRecorder()
		g.service.serveGitHub(recorder, request)
		return recorder
	}

	fake.sent.Store(0)
	good := send(goodToken, true)
	if good.Code != http.StatusOK || !bytes.Contains(good.Body.Bytes(), []byte("packfile")) {
		t.Fatalf("the job's own fetch got %d %q, want a pack", good.Code, firstBytes(good.Body.Bytes()))
	}
	if sent := fake.sent.Load(); sent > 16<<10 || int64(good.Body.Len()) < 100<<10 {
		t.Fatalf("GitHub sent %d bytes and the client got %d; the mirror should have answered from the seed", sent, good.Body.Len())
	}

	bad := send(badToken, false)
	if bad.Code != http.StatusUnauthorized || bytes.Contains(bad.Body.Bytes(), []byte("packfile")) {
		t.Fatalf("a refused credential got %d %q, want GitHub's 401 and no objects", bad.Code, firstBytes(bad.Body.Bytes()))
	}
}

func firstBytes(body []byte) []byte {
	if len(body) > 80 {
		return body[:80]
	}
	return body
}

// A ref advertisement GitHub granted stands in for asking again only for the
// same repository, the same credential, and for a minute.
func TestAuthorizationIsRememberedNarrowlyAndBriefly(t *testing.T) {
	now := time.Date(2026, 11, 6, 12, 0, 0, 0, time.UTC)
	s := &Service{config: Config{Now: func() time.Time { return now }}}
	s.rememberAuthorized("Acme/App", "Basic good")
	switch {
	case !s.recentlyAuthorized("acme/app", "Basic good"):
		t.Fatal("the remembered credential was not recognised")
	case s.recentlyAuthorized("acme/app", "Basic other"):
		t.Fatal("another credential rode on the remembered one")
	case s.recentlyAuthorized("acme/lib", "Basic good"):
		t.Fatal("the credential was taken as proof for another repository")
	}
	now = now.Add(authorizedFor)
	if s.recentlyAuthorized("acme/app", "Basic good") {
		t.Fatal("the memo outlived authorizedFor")
	}
}

func TestSeedClientSpeaksTheCacheServiceContract(t *testing.T) {
	var saved []byte
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != seedPath || r.Header.Get("Authorization") != "Bearer runner-token" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		w.Header().Set("X-Erainfra-Repository", "acme/app")
		w.Header().Set("X-Erainfra-Git-Seed-Writable", "true")
		switch r.Method {
		case http.MethodPut:
			if r.ContentLength <= 0 {
				http.Error(w, "length", http.StatusLengthRequired)
				return
			}
			saved, _ = io.ReadAll(r.Body)
			w.WriteHeader(http.StatusCreated)
		case http.MethodGet:
			if saved == nil {
				http.Error(w, "none", http.StatusNotFound)
				return
			}
			w.Header().Set("X-Erainfra-Git-Seed-Created", "1700000000")
			_, _ = w.Write(saved)
		}
	}))
	defer server.Close()

	client, err := NewSeedClient(server.URL+"/", "runner-token", nil)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	info, body, err := client.Open(ctx)
	if err != nil || body != nil || info.Found || info.Repository != "acme/app" || !info.Writable {
		t.Fatalf("a miss read as %+v, %v, %v", info, body, err)
	}

	path := filepath.Join(t.TempDir(), "seed.bundle")
	if err := os.WriteFile(path, []byte("bundle bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := client.Save(ctx, path); err != nil {
		t.Fatal(err)
	}
	info, body, err = client.Open(ctx)
	if err != nil || body == nil || !info.Found || info.Created.Unix() != 1700000000 {
		t.Fatalf("a hit read as %+v, %v", info, err)
	}
	content, _ := io.ReadAll(body)
	_ = body.Close()
	if string(content) != "bundle bytes" {
		t.Fatalf("seed body %q", content)
	}

	refused, _ := NewSeedClient(server.URL, "someone-else", nil)
	if _, _, err := refused.Open(ctx); err == nil {
		t.Fatal("a 401 read as an answer")
	}
	// A cache service from before seeds existed answers 404 with no repository.
	old := httptest.NewServer(http.NotFoundHandler())
	defer old.Close()
	oldClient, _ := NewSeedClient(old.URL, "runner-token", nil)
	if _, _, err := oldClient.Open(ctx); err == nil {
		t.Fatal("a 404 without a repository read as a miss for some repository")
	}
}
