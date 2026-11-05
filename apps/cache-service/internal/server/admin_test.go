package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Fanzzzd/erainfra/apps/cache-service/internal/adminapi"
	"github.com/Fanzzzd/erainfra/apps/cache-service/internal/cacheindex"
	"github.com/Fanzzzd/erainfra/apps/cache-service/internal/config"
)

// adminRequest builds a signed admin request, so a test can tamper with it
// before sending.
func (h *harness) adminRequest(method string, query url.Values, key []byte, at time.Time) *http.Request {
	h.t.Helper()
	request, err := http.NewRequestWithContext(context.Background(), method, h.http.URL+adminEntriesMarker+"?"+query.Encode(), nil)
	if err != nil {
		h.t.Fatal(err)
	}
	if err := adminapi.Sign(request, key, nil, at); err != nil {
		h.t.Fatal(err)
	}
	return request
}

func (h *harness) send(request *http.Request) *http.Response {
	h.t.Helper()
	response, err := h.http.Client().Do(request)
	if err != nil {
		h.t.Fatal(err)
	}
	return response
}

func (h *harness) adminClient() *adminapi.Client {
	return &adminapi.Client{BaseURL: h.http.URL, SigningKey: signingKey, HTTP: h.http.Client(), Now: h.now}
}

func (h *harness) restoreStatus(token, key, version string) int {
	h.t.Helper()
	response := h.do(http.MethodGet, v1Path("cache")+"?keys="+url.QueryEscape(key)+"&version="+version, token, nil, nil)
	_ = readAll(h.t, response)
	return response.StatusCode
}

func repoQuery(repository string, pairs ...string) url.Values {
	query := url.Values{"repository": {repository}}
	for i := 0; i+1 < len(pairs); i += 2 {
		query.Set(pairs[i], pairs[i+1])
	}
	return query
}

// Every way of presenting the wrong credentials is refused, and refused before
// anything is done: a rejected "clear" leaves the cache as it was.
func TestAdminRejectsUnsignedForgedTamperedStaleAndReplayedRequests(t *testing.T) {
	h := newHarness(t, nil)
	token := h.pushToken("Fanzzzd/erainfra", "refs/heads/main")
	body := payload(1024)
	h.saveV1(token, "keep-me", "v1", body, wholeBody(body))
	clear := repoQuery("Fanzzzd/erainfra", "all", "true")

	unsigned, err := http.NewRequestWithContext(context.Background(), http.MethodDelete, h.http.URL+adminEntriesMarker+"?"+clear.Encode(), nil)
	if err != nil {
		t.Fatal(err)
	}
	tampered := h.adminRequest(http.MethodDelete, repoQuery("someone/else", "all", "true"), signingKey, h.now())
	tampered.URL.RawQuery = clear.Encode()
	factsShaped := h.adminRequest(http.MethodDelete, clear, signingKey, h.now())
	factsShaped.Header.Del(adminapi.HeaderSignature)
	factsShaped.Header.Set("X-Erainfra-Cache-Admin", adminSign(""))

	for name, request := range map[string]*http.Request{
		"unsigned": unsigned,
		"wrong key": h.adminRequest(http.MethodDelete, clear,
			[]byte("a-different-key-that-is-also-long-enough-000000"), h.now()),
		"query changed after signing": tampered,
		"signed six minutes ago":      h.adminRequest(http.MethodDelete, clear, signingKey, h.now().Add(-6*time.Minute)),
		"signed six minutes ahead":    h.adminRequest(http.MethodDelete, clear, signingKey, h.now().Add(6*time.Minute)),
		"a facts-push signature":      factsShaped,
	} {
		response := h.send(request)
		_ = readAll(t, response)
		if response.StatusCode != http.StatusUnauthorized {
			t.Errorf("%s: %d, want 401", name, response.StatusCode)
		}
	}
	if status := h.restoreStatus(token, "keep-me", "v1"); status != http.StatusOK {
		t.Fatalf("restore after the rejected clears = %d, want the entry still there", status)
	}

	// Replay: the same signed request, byte for byte, a second time.
	list := h.adminRequest(http.MethodGet, repoQuery("Fanzzzd/erainfra"), signingKey, h.now())
	first := h.send(list)
	_ = readAll(t, first)
	if first.StatusCode != http.StatusOK {
		t.Fatalf("signed list = %d, want 200", first.StatusCode)
	}
	again, err := http.NewRequestWithContext(context.Background(), list.Method, list.URL.String(), nil)
	if err != nil {
		t.Fatal(err)
	}
	again.Header = list.Header.Clone()
	second := h.send(again)
	_ = readAll(t, second)
	if second.StatusCode != http.StatusUnauthorized {
		t.Fatalf("replayed list = %d, want 401", second.StatusCode)
	}
}

func TestAdminRefusesARequestWithoutOneExplicitRepository(t *testing.T) {
	h := newHarness(t, nil)
	for name, query := range map[string]url.Values{
		"no repository": {"all": {"true"}},
		"wildcard":      repoQuery("*", "all", "true"),
		"owner only":    repoQuery("Fanzzzd", "all", "true"),
		"glob":          repoQuery("Fanzzzd/*", "all", "true"),
		"traversal":     repoQuery("Fanzzzd/../other", "all", "true"),
	} {
		response := h.send(h.adminRequest(http.MethodDelete, query, signingKey, h.now()))
		_ = readAll(t, response)
		if response.StatusCode != http.StatusBadRequest {
			t.Errorf("%s: %d, want 400", name, response.StatusCode)
		}
	}
}

func TestAdminDeleteNamesExactlyOneSelector(t *testing.T) {
	h := newHarness(t, nil)
	for name, query := range map[string]url.Values{
		"nothing":            repoQuery("Fanzzzd/erainfra"),
		"key and prefix":     repoQuery("Fanzzzd/erainfra", "key", "a", "prefix", "b"),
		"key and all":        repoQuery("Fanzzzd/erainfra", "key", "a", "all", "true"),
		"all with a ref":     repoQuery("Fanzzzd/erainfra", "all", "true", "ref", "refs/heads/main"),
		"all spelled wrong":  repoQuery("Fanzzzd/erainfra", "all", "yes"),
		"only a version":     repoQuery("Fanzzzd/erainfra", "version", "v1"),
		"an empty prefix":    repoQuery("Fanzzzd/erainfra", "prefix", ""),
		"bad sort on delete": repoQuery("Fanzzzd/erainfra", "sort", "size"),
	} {
		response := h.send(h.adminRequest(http.MethodDelete, query, signingKey, h.now()))
		_ = readAll(t, response)
		if response.StatusCode != http.StatusBadRequest {
			t.Errorf("%s: %d, want 400", name, response.StatusCode)
		}
	}
	response := h.send(h.adminRequest(http.MethodPost, repoQuery("Fanzzzd/erainfra"), signingKey, h.now()))
	_ = readAll(t, response)
	if response.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("POST = %d, want 405", response.StatusCode)
	}
}

// List carries what an operator needs to decide what to delete: key, version,
// ref, size, created, last restored. It sorts most recently used first by
// default, filters by prefix, and pages.
func TestAdminListShowsEntriesSortedByLastUse(t *testing.T) {
	h := newHarness(t, nil)
	main := h.pushToken("Fanzzzd/erainfra", "refs/heads/main")
	for i, key := range []string{"node-cache-a", "node-cache-b", "go-build-c"} {
		body := payload(100 * (i + 1))
		h.saveV1(main, key, "v1", body, wholeBody(body))
		h.advance(time.Minute)
	}
	h.advance(15 * time.Minute)
	h.restoreV1(main, "node-cache-a", "v1")
	if err := h.server.index.FlushAccess(context.Background()); err != nil {
		t.Fatal(err)
	}
	client := h.adminClient()
	ctx := context.Background()

	all, err := client.List(ctx, adminapi.ListQuery{Repository: "Fanzzzd/erainfra"})
	if err != nil {
		t.Fatal(err)
	}
	if all.TotalCount != 3 || all.TotalBytes != 600 || len(all.Entries) != 3 {
		t.Fatalf("list = %+v, want 3 entries and 600 bytes", all)
	}
	if got := all.Entries[0]; got.Key != "node-cache-a" || got.Ref != "refs/heads/main" ||
		got.Version != "v1" || got.SizeInBytes != 100 ||
		!got.CreatedAt.Equal(startedAt) || !got.LastAccessedAt.After(got.CreatedAt) {
		t.Fatalf("first entry = %+v, want the restored node-cache-a with its access time", got)
	}
	if all.Entries[1].Key != "go-build-c" || all.Entries[2].Key != "node-cache-b" {
		t.Fatalf("order = %s, %s; want the newer never-restored entry before the older one",
			all.Entries[1].Key, all.Entries[2].Key)
	}

	prefixed, err := client.List(ctx, adminapi.ListQuery{
		Repository: "Fanzzzd/erainfra", Prefix: "node-cache-", SortBy: "size", SortDirection: "asc",
		PerPage: 1, Page: 2,
	})
	if err != nil {
		t.Fatal(err)
	}
	if prefixed.TotalCount != 2 || len(prefixed.Entries) != 1 || prefixed.Entries[0].Key != "node-cache-b" {
		t.Fatalf("prefix page 2 = %+v, want node-cache-b alone of two", prefixed)
	}

	past, err := client.List(ctx, adminapi.ListQuery{Repository: "Fanzzzd/erainfra", Page: 9})
	if err != nil {
		t.Fatal(err)
	}
	if past.TotalCount != 3 || len(past.Entries) != 0 {
		t.Fatalf("a page past the end = %+v, want an empty page with the total", past)
	}

	var problem *adminapi.Error
	if _, err := client.List(ctx, adminapi.ListQuery{Repository: "Fanzzzd/erainfra", SortBy: "colour"}); !errors.As(err, &problem) || problem.Status != http.StatusBadRequest {
		t.Fatalf("an unknown sort column = %v, want 400", err)
	}
}

// Delete by key narrows by version and ref; delete by prefix takes every key
// that starts with it; clear takes the repository. Whatever is deleted is a miss
// on the very next restore.
func TestAdminDeleteByKeyPrefixAndClear(t *testing.T) {
	h := newHarness(t, nil)
	main := h.pushToken("Fanzzzd/erainfra", "refs/heads/main")
	feature := h.pushToken("Fanzzzd/erainfra", "refs/heads/feature")
	body := payload(64)
	h.saveV1(main, "deps-1", "v1", body, wholeBody(body))
	h.saveV1(main, "deps-1", "v2", body, wholeBody(body))
	h.saveV1(feature, "deps-1", "v1", body, wholeBody(body))
	h.saveV1(main, "deps-2", "v1", body, wholeBody(body))
	h.saveV1(main, "tools", "v1", body, wholeBody(body))
	client := h.adminClient()
	ctx := context.Background()

	deleted, err := client.Delete(ctx, adminapi.DeleteQuery{
		Repository: "Fanzzzd/erainfra", Key: "deps-1", Version: "v1", Ref: "refs/heads/main",
	})
	if err != nil {
		t.Fatal(err)
	}
	if deleted.DeletedCount != 1 || deleted.DeletedBytes != 64 {
		t.Fatalf("key+version+ref delete = %+v, want one entry", deleted)
	}
	if status := h.restoreStatus(main, "deps-1", "v1"); status != http.StatusNoContent {
		t.Fatalf("restore of the deleted entry = %d, want a 204 miss", status)
	}
	if status := h.restoreStatus(main, "deps-1", "v2"); status != http.StatusOK {
		t.Fatalf("the other version = %d, want it untouched", status)
	}
	if status := h.restoreStatus(feature, "deps-1", "v1"); status != http.StatusOK {
		t.Fatalf("the other ref's entry = %d, want it untouched", status)
	}

	deleted, err = client.Delete(ctx, adminapi.DeleteQuery{Repository: "Fanzzzd/erainfra", Prefix: "deps-"})
	if err != nil {
		t.Fatal(err)
	}
	if deleted.DeletedCount != 3 {
		t.Fatalf("prefix delete = %+v, want deps-1@v2, deps-1@feature and deps-2", deleted)
	}
	if status := h.restoreStatus(main, "tools", "v1"); status != http.StatusOK {
		t.Fatalf("an entry outside the prefix = %d, want it untouched", status)
	}

	deleted, err = client.Delete(ctx, adminapi.DeleteQuery{Repository: "Fanzzzd/erainfra", All: true})
	if err != nil {
		t.Fatal(err)
	}
	if deleted.DeletedCount != 1 {
		t.Fatalf("clear = %+v, want the last entry", deleted)
	}
	listed, err := client.List(ctx, adminapi.ListQuery{Repository: "Fanzzzd/erainfra"})
	if err != nil {
		t.Fatal(err)
	}
	if listed.TotalCount != 0 {
		t.Fatalf("after clear the repository lists %d entries", listed.TotalCount)
	}

	// A key saved again after its deletion is a new entry, not refused as a
	// duplicate of the one that is gone.
	h.saveV1(main, "tools", "v1", body, wholeBody(body))
}

// Admin operations are scoped to the repository they name, by the same layout
// that scopes a job: the same key in another repository is not listed, not
// deleted and not cleared.
func TestAdminOperationsDoNotCrossRepositories(t *testing.T) {
	h := newHarness(t, nil)
	ours := h.pushToken("Fanzzzd/erainfra", "refs/heads/main")
	theirs := h.pushToken("Fanzzzd/erainfra-fork", "refs/heads/main")
	body := payload(32)
	h.saveV1(ours, "shared-key", "v1", body, wholeBody(body))
	h.saveV1(theirs, "shared-key", "v1", body, wholeBody(body))
	client := h.adminClient()
	ctx := context.Background()

	listed, err := client.List(ctx, adminapi.ListQuery{Repository: "Fanzzzd/erainfra"})
	if err != nil {
		t.Fatal(err)
	}
	if listed.TotalCount != 1 {
		t.Fatalf("list shows %d entries, want only this repository's one", listed.TotalCount)
	}
	if _, err := client.Delete(ctx, adminapi.DeleteQuery{Repository: "Fanzzzd/erainfra", Key: "shared-key"}); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Delete(ctx, adminapi.DeleteQuery{Repository: "Fanzzzd/erainfra", All: true}); err != nil {
		t.Fatal(err)
	}
	if status := h.restoreStatus(theirs, "shared-key", "v1"); status != http.StatusOK {
		t.Fatalf("the other repository's entry = %d after deletes and a clear elsewhere, want it untouched", status)
	}
	other, err := client.List(ctx, adminapi.ListQuery{Repository: "Fanzzzd/erainfra-fork"})
	if err != nil {
		t.Fatal(err)
	}
	if other.TotalCount != 1 {
		t.Fatalf("the other repository lists %d entries, want 1", other.TotalCount)
	}
}

// The property eviction is built around: a restore that races an eviction gets
// either a hit whose bytes download, or a miss. Never an error, and never a hit
// whose URL fails.
func TestRestoreDuringEvictionIsAMissNeverAnError(t *testing.T) {
	for _, mode := range []string{config.DownloadPresign, config.DownloadProxy} {
		t.Run(mode, func(t *testing.T) {
			h := newHarness(t, func(cfg *config.Config) {
				cfg.DownloadMode = mode
				cfg.IdleTTL = 10 * time.Minute
			})
			token := h.pushToken("Fanzzzd/erainfra", "refs/heads/main")
			want := payload(6 << 20) // over one 5 MiB part, so the multipart path is in play
			h.saveV1(token, "racing", "v1", want, wholeBody(want))
			// Idle past the TTL but well inside the token's 30 minutes.
			h.advance(11 * time.Minute)

			client := h.http.Client()
			restoreOnce := func(v2 bool) (hit bool, err error) {
				var request *http.Request
				if v2 {
					request, err = http.NewRequestWithContext(context.Background(), http.MethodPost, h.http.URL+v2Path("GetCacheEntryDownloadURL"),
						strings.NewReader(`{"key":"racing","version":"v1"}`))
				} else {
					request, err = http.NewRequestWithContext(context.Background(), http.MethodGet, h.http.URL+v1Path("cache")+"?keys=racing&version=v1", nil)
				}
				if err != nil {
					return false, err
				}
				request.Header.Set("Authorization", "Bearer "+token)
				response, err := client.Do(request)
				if err != nil {
					return false, err
				}
				raw, _ := io.ReadAll(response.Body)
				_ = response.Body.Close()
				location := ""
				switch {
				case !v2 && response.StatusCode == http.StatusNoContent:
					return false, nil
				case !v2 && response.StatusCode == http.StatusOK:
					var hit v1RestoreResponse
					if err := json.Unmarshal(raw, &hit); err != nil {
						return false, err
					}
					location = hit.ArchiveLocation
				case v2 && response.StatusCode == http.StatusOK:
					var answer v2DownloadResponse
					if err := json.Unmarshal(raw, &answer); err != nil {
						return false, err
					}
					if !answer.OK {
						return false, nil
					}
					location = answer.SignedDownloadURL
				default:
					return false, fmt.Errorf("restore answered %d %s", response.StatusCode, raw)
				}
				get, err := http.NewRequestWithContext(context.Background(), http.MethodGet, location, nil)
				if err != nil {
					return true, err
				}
				download, err := client.Do(get)
				if err != nil {
					return true, err
				}
				got, _ := io.ReadAll(download.Body)
				_ = download.Body.Close()
				if download.StatusCode != http.StatusOK || len(got) != len(want) {
					return true, fmt.Errorf("a hit's download answered %d with %d bytes", download.StatusCode, len(got))
				}
				return true, nil
			}

			var (
				mu       sync.Mutex
				failures []error
				hits     int
			)
			stop := make(chan struct{})
			var wg sync.WaitGroup
			for worker := 0; worker < 4; worker++ {
				wg.Add(1)
				go func(v2 bool) {
					defer wg.Done()
					for {
						select {
						case <-stop:
							return
						default:
						}
						hit, err := restoreOnce(v2)
						mu.Lock()
						if err != nil {
							failures = append(failures, err)
						}
						if hit {
							hits++
						}
						mu.Unlock()
					}
				}(worker%2 == 1)
			}
			waitFor := func(condition func() bool) {
				deadline := time.Now().Add(10 * time.Second)
				for !condition() && time.Now().Before(deadline) {
					time.Sleep(5 * time.Millisecond)
				}
			}
			waitFor(func() bool { mu.Lock(); defer mu.Unlock(); return hits >= 4 })

			report, err := h.server.index.Sweep(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			if report.EvictedIdle != 1 {
				t.Fatalf("sweep = %+v, want the idle entry evicted", report)
			}
			// Keep restoring after the eviction, while hits handed out just
			// before it are still downloading.
			time.Sleep(100 * time.Millisecond)
			close(stop)
			wg.Wait()

			for _, failure := range failures {
				t.Error(failure)
			}
			if hits == 0 {
				t.Fatal("no restore hit before the eviction; the race was not exercised")
			}
			if status := h.restoreStatus(token, "racing", "v1"); status != http.StatusNoContent {
				t.Fatalf("restore after the eviction = %d, want a 204 miss", status)
			}
		})
	}
}

// The quota holds within one tick of the commit that broke it, without waiting
// for the full sweep, and the restore that kept an entry warm keeps it.
func TestQuotaIsEnforcedSoonAfterTheCommitThatBreaksIt(t *testing.T) {
	h := newHarness(t, func(cfg *config.Config) { cfg.RepoQuotaBytes = 2500 })
	token := h.pushToken("Fanzzzd/erainfra", "refs/heads/main")
	for _, key := range []string{"first", "second"} {
		body := payload(1000)
		h.saveV1(token, key, "v1", body, wholeBody(body))
		h.advance(time.Minute)
	}
	h.advance(15 * time.Minute)
	h.restoreV1(token, "first", "v1")
	h.advance(time.Minute)
	body := payload(1000)
	h.saveV1(token, "third", "v1", body, wholeBody(body))

	h.server.retainTickOnce(context.Background())

	for key, want := range map[string]int{"first": http.StatusOK, "second": http.StatusNoContent, "third": http.StatusOK} {
		if got := h.restoreStatus(token, key, "v1"); got != want {
			t.Errorf("restore %q = %d, want %d", key, got, want)
		}
	}
	listed, err := h.adminClient().List(context.Background(), adminapi.ListQuery{Repository: "Fanzzzd/erainfra"})
	if err != nil {
		t.Fatal(err)
	}
	if listed.TotalBytes > 2500 {
		t.Fatalf("repository holds %d bytes after the quota pass, quota 2500", listed.TotalBytes)
	}
}

var _ = cacheindex.Match{}
