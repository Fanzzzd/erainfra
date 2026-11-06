package server

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"net"
	"net/http"
	"strconv"
	"testing"
	"time"

	"github.com/Fanzzzd/erainfra/apps/cache-service/cachetoken"
	"github.com/Fanzzzd/erainfra/apps/cache-service/internal/adminapi"
	"github.com/Fanzzzd/erainfra/apps/cache-service/internal/config"
)

// A repository renamed away (or deleted) and a new repository created under the
// old name are two repositories. GitHub's Actions cache belongs to the
// repository, not the name, and so does this one: every entry records the
// GitHub repository ID from the job's facts.
func sameNameJob(h *harness, id int64) string {
	return h.token(cachetoken.JobFacts{
		Repository: "acme/app", RepositoryID: id, Event: "push",
		Ref: "refs/heads/main", DefaultBranch: "refs/heads/main",
	})
}

const sameNameVersion = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func TestActionsCacheIsNotReadByANewRepositoryOfTheSameName(t *testing.T) {
	h := newHarness(t, nil)
	secret := payload(2 << 10)
	h.saveV1(sameNameJob(h, 1001), "node-modules-linux", sameNameVersion, secret, wholeBody(secret))

	if status := h.restoreStatus(sameNameJob(h, 2002), "node-modules-linux", sameNameVersion); status == http.StatusOK {
		t.Fatalf("repository 2002 restored repository 1001's actions/cache entry over v1: status %d", status)
	}
	if status := h.restoreStatus(sameNameJob(h, 2002), "node-modules-", sameNameVersion); status == http.StatusOK {
		t.Fatalf("repository 2002 prefix-matched repository 1001's entry over v1: status %d", status)
	}
	response := h.postJSON(v2Path("GetCacheEntryDownloadURL"), sameNameJob(h, 2002),
		jsonBody(map[string]any{"key": "node-modules-linux", "version": sameNameVersion}))
	var hit v2DownloadResponse
	decodeInto(t, response, &hit)
	if hit.OK {
		t.Fatalf("repository 2002 restored repository 1001's entry over v2: %+v", hit)
	}
	// The repository that saved it still restores it.
	if got := h.restoreV1(sameNameJob(h, 1001), "node-modules-linux", sameNameVersion); !bytes.Equal(got, secret) {
		t.Fatal("the saving repository lost its own entry")
	}
}

func TestBuildCachesAreNotReadByANewRepositoryOfTheSameName(t *testing.T) {
	h := newHarness(t, nil)
	secret := payload(2 << 10)
	if put := h.turboPut(sameNameJob(h, 1001), "abc123", secret, nil); put.StatusCode != http.StatusAccepted {
		t.Fatalf("turbo PUT = %d", put.StatusCode)
	}
	if status, body, _ := h.turboGet(sameNameJob(h, 2002), "abc123", nil); status == http.StatusOK || bytes.Equal(body, secret) {
		t.Fatalf("repository 2002 read repository 1001's turbo artifact: %d", status)
	}
	action := goID("same name")
	if status := h.goPut(sameNameJob(h, 1001), action, secret, nil); status != http.StatusNoContent {
		t.Fatalf("go PUT = %d", status)
	}
	if status, body, _ := h.goGet(sameNameJob(h, 2002), action, nil); status == http.StatusOK || bytes.Equal(body, secret) {
		t.Fatalf("repository 2002 read repository 1001's Go build output: %d", status)
	}
	if status, body, _ := h.goGet(sameNameJob(h, 1001), action, nil); status != http.StatusOK || !bytes.Equal(body, secret) {
		t.Fatalf("the saving repository's Go build output = %d", status)
	}
}

// The new repository's first save takes the name: the old repository's
// entries go, and a key the old one held is the new one's to save.
func TestANewRepositoryOfTheSameNameSavesTheOldOnesKeys(t *testing.T) {
	h := newHarness(t, nil)
	old, fresh := payload(1<<10), payload(3<<10)
	h.saveV1(sameNameJob(h, 1001), "deps", sameNameVersion, old, wholeBody(old))
	if put := h.turboPut(sameNameJob(h, 1001), "abc123", old, nil); put.StatusCode != http.StatusAccepted {
		t.Fatalf("turbo PUT = %d", put.StatusCode)
	}

	// Without the purge this reserve is a 409: the key exists in the scope.
	h.saveV1(sameNameJob(h, 2002), "deps", sameNameVersion, fresh, wholeBody(fresh))
	if got := h.restoreV1(sameNameJob(h, 2002), "deps", sameNameVersion); !bytes.Equal(got, fresh) {
		t.Fatal("the new repository restored something other than its own save")
	}
	if put := h.turboPut(sameNameJob(h, 2002), "abc123", fresh, nil); put.StatusCode != http.StatusAccepted {
		t.Fatalf("turbo PUT = %d", put.StatusCode)
	}
	if status, body, _ := h.turboGet(sameNameJob(h, 2002), "abc123", nil); status != http.StatusOK || !bytes.Equal(body, fresh) {
		t.Fatalf("the new repository's turbo GET = %d, want its own artifact", status)
	}

	listed, err := h.adminClient().List(context.Background(), adminapi.ListQuery{Repository: "acme/app"})
	if err != nil {
		t.Fatal(err)
	}
	if listed.RepositoryID != 2002 || listed.TotalCount != 2 {
		t.Fatalf("list = %+v, want the new repository's two entries under a name it holds", listed)
	}
	for _, entry := range listed.Entries {
		if entry.RepositoryID != 2002 {
			t.Fatalf("an entry saved by %d survived the new repository's first save: %+v", entry.RepositoryID, entry)
		}
	}
}

// Entries saved before IDs were recorded, and jobs from a controller that
// pushes none, keep today's by-name behaviour until a different ID saves.
func TestEntriesAndJobsWithoutAnIDKeepWorkingByName(t *testing.T) {
	h := newHarness(t, nil)
	legacy := payload(1 << 10)
	h.saveV1(h.pushToken("acme/app", "refs/heads/main"), "legacy", sameNameVersion, legacy, wholeBody(legacy))

	if got := h.restoreV1(sameNameJob(h, 1001), "legacy", sameNameVersion); !bytes.Equal(got, legacy) {
		t.Fatal("an entry saved without an ID is no longer restored by the repository that holds the name")
	}
	own := payload(2 << 10)
	h.saveV1(sameNameJob(h, 1001), "own", sameNameVersion, own, wholeBody(own))
	if got := h.restoreV1(h.pushToken("acme/app", "refs/heads/main"), "own", sameNameVersion); !bytes.Equal(got, own) {
		t.Fatal("a job without an ID lost the by-name restore it had")
	}
	if status := h.restoreStatus(sameNameJob(h, 2002), "legacy", sameNameVersion); status == http.StatusOK {
		t.Fatal("another repository of the same name restored an entry the holder adopted")
	}
}

// The admin API reports which ID saved each entry and which ID holds the name,
// and narrows a list or a delete to one ID.
func TestAdminReportsAndNarrowsByRepositoryID(t *testing.T) {
	h := newHarness(t, nil)
	body := payload(64)
	h.saveV1(h.pushToken("acme/app", "refs/heads/main"), "legacy", sameNameVersion, body, wholeBody(body))
	h.saveV1(sameNameJob(h, 1001), "own", sameNameVersion, body, wholeBody(body))
	client := h.adminClient()
	ctx := context.Background()

	all, err := client.List(ctx, adminapi.ListQuery{Repository: "acme/app", SortBy: "key", SortDirection: "asc"})
	if err != nil {
		t.Fatal(err)
	}
	if all.RepositoryID != 1001 || len(all.Entries) != 2 ||
		all.Entries[0].RepositoryID != 0 || all.Entries[1].RepositoryID != 1001 {
		t.Fatalf("list = %+v, want the holder and each entry's own ID", all)
	}
	narrowed, err := client.List(ctx, adminapi.ListQuery{Repository: "acme/app", RepositoryID: 1001})
	if err != nil {
		t.Fatal(err)
	}
	if narrowed.TotalCount != 1 || narrowed.Entries[0].Key != "own" {
		t.Fatalf("list narrowed to 1001 = %+v", narrowed)
	}
	deleted, err := client.Delete(ctx, adminapi.DeleteQuery{Repository: "acme/app", All: true, RepositoryID: 1001})
	if err != nil {
		t.Fatal(err)
	}
	if deleted.DeletedCount != 1 || deleted.Entries[0].Key != "own" {
		t.Fatalf("clear narrowed to 1001 = %+v, want only its own entry", deleted)
	}
	response := h.send(h.adminRequest(http.MethodGet, repoQuery("acme/app", "repository_id", "-3"), signingKey, h.now()))
	_ = readAll(t, response)
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("a negative repository_id = %d, want 400", response.StatusCode)
	}
}

// putSeedLength sends a seed PUT that declares length bytes and sends none of
// them, which the HTTP client will not do, so it is written by hand. length
// must be over 256 KiB: below that, net/http drains an unread body before it
// sends the response, and this request has none to drain.
func (h *harness) putSeedLength(token string, length int64) int {
	h.t.Helper()
	dialer := net.Dialer{Timeout: 5 * time.Second}
	conn, err := dialer.DialContext(h.t.Context(), "tcp", h.http.Listener.Addr().String())
	if err != nil {
		h.t.Fatal(err)
	}
	defer conn.Close() //nolint:errcheck // test connection
	_ = conn.SetDeadline(time.Now().Add(10 * time.Second))
	request := "PUT " + gitSeedMarker + " HTTP/1.1\r\nHost: cache\r\nAuthorization: Bearer " + token +
		"\r\nContent-Length: " + strconv.FormatInt(length, 10) + "\r\n\r\n"
	if _, err := conn.Write([]byte(request)); err != nil {
		h.t.Fatal(err)
	}
	response, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		h.t.Fatal(err)
	}
	_ = response.Body.Close()
	return response.StatusCode
}

func (h *harness) seedWritable(token string) string {
	h.t.Helper()
	response, _ := h.getSeed(token)
	return response.Header.Get(headerGitSeedWritable)
}

// A seed refusal is decided from the PUT's Content-Length before any byte of
// the body arrives. A job on a pull request or a feature branch chooses that
// number, so its refusal holds for its own ref and never stops the default
// branch's seed, which every other scope reads.
func TestGitSeedRefusalFromAnotherRefDoesNotStopTheDefaultBranch(t *testing.T) {
	h := newHarness(t, func(cfg *config.Config) { cfg.MaxEntryBytes = 1 << 10 })
	pullRequest := func() string {
		return h.token(cachetoken.JobFacts{
			Repository: "acme/app", RepositoryID: 1001, HeadRepository: "acme/app", Event: "pull_request",
			Ref: "refs/pull/7/merge", BaseRef: "refs/heads/main", DefaultBranch: "refs/heads/main",
		})
	}
	main := func() string { return sameNameJob(h, 1001) }
	feature := func() string {
		return h.token(cachetoken.JobFacts{
			Repository: "acme/app", RepositoryID: 1001, Event: "push",
			Ref: "refs/heads/feature", DefaultBranch: "refs/heads/main",
		})
	}

	if status := h.putSeedLength(pullRequest(), 1<<40); status != http.StatusRequestEntityTooLarge {
		t.Fatalf("an oversized PUT from a pull request = %d, want 413", status)
	}
	if got := h.seedWritable(main()); got != "true" {
		t.Fatalf("after a pull request's refusal the default branch is writable = %q, want true", got)
	}
	if got := h.seedWritable(feature()); got != "true" {
		t.Fatalf("after a pull request's refusal another branch is writable = %q, want true", got)
	}
	if got := h.seedWritable(pullRequest()); got != "false" {
		t.Fatalf("the refused pull request's own ref is writable = %q, want false until the backoff", got)
	}

	// The default branch's refusal holds for every ref.
	if status := h.putSeedLength(main(), 1<<40); status != http.StatusRequestEntityTooLarge {
		t.Fatalf("an oversized PUT from the default branch = %d, want 413", status)
	}
	for name, token := range map[string]string{"default branch": main(), "feature": feature()} {
		if got := h.seedWritable(token); got != "false" {
			t.Fatalf("after the default branch's refusal %s is writable = %q, want false", name, got)
		}
	}

	// A seed saved on a feature branch does not lift the default branch's
	// refusal; one saved on the default branch does.
	h.server.config.MaxEntryBytes = 8 << 10
	if put := h.putSeed(feature(), payload(2<<10)); put.StatusCode != http.StatusCreated {
		t.Fatalf("feature PUT = %d", put.StatusCode)
	}
	h.server.config.MaxEntryBytes = 1 << 10
	if got := h.seedWritable(main()); got != "false" {
		t.Fatalf("a feature branch's seed cleared the default branch's refusal: writable = %q", got)
	}
}

// A refusal recorded for one repository is not inherited by a new repository
// created under its name.
func TestGitSeedRefusalIsNotInheritedByANewRepositoryOfTheSameName(t *testing.T) {
	h := newHarness(t, func(cfg *config.Config) { cfg.MaxEntryBytes = 1 << 10 })
	if status := h.putSeedLength(sameNameJob(h, 1001), 1<<40); status != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized PUT = %d, want 413", status)
	}
	if got := h.seedWritable(sameNameJob(h, 1001)); got != "false" {
		t.Fatalf("the refused repository is writable = %q, want false", got)
	}
	if got := h.seedWritable(sameNameJob(h, 2002)); got != "true" {
		t.Fatalf("a new repository of the same name inherited the refusal: writable = %q", got)
	}
	// A controller without IDs still sees the refusal by name.
	if got := h.seedWritable(h.pushToken("acme/app", "refs/heads/main")); got != "false" {
		t.Fatalf("a job without an ID is writable = %q, want the refusal by name", got)
	}
}

// A refusal recorded before refusals were scoped carries no ref, so it may
// have been a length a pull request made up. Other refs keep honouring it;
// the default branch builds once more and records its own answer.
func TestGitSeedRefusalWithoutARefDoesNotHoldTheDefaultBranch(t *testing.T) {
	h := newHarness(t, func(cfg *config.Config) { cfg.MaxEntryBytes = 1 << 10 })
	record, err := json.Marshal(map[string]any{
		"repository": "acme/app", "bytes": 1 << 40, "limit": 1 << 10, "refusals": 1,
		"refusedAt": h.now().Unix(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := h.backing.PutBytes(context.Background(), gitSeedRefusalKey("acme/app"), "application/json", record); err != nil {
		t.Fatal(err)
	}
	if got := h.seedWritable(sameNameJob(h, 1001)); got != "true" {
		t.Fatalf("the default branch is held by a refusal of unknown origin: writable = %q", got)
	}
	feature := h.token(cachetoken.JobFacts{
		Repository: "acme/app", RepositoryID: 1001, Event: "push",
		Ref: "refs/heads/feature", DefaultBranch: "refs/heads/main",
	})
	if got := h.seedWritable(feature); got != "false" {
		t.Fatalf("another ref ignores the earlier refusal: writable = %q, want false", got)
	}
}
