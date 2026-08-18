package server

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/Fanzzzd/erainfra/apps/cache-service/cachetoken"
)

// ADR 0007's security contract, one test per rule and each written before the
// feature it constrains. The numbering below is the ADR's.

// forgeToken mints a token from arbitrary claims, which the issuer refuses to
// do. It exists so the tests can present the shapes an attacker would: a token
// with no repository claim, one signed with the wrong key, one already expired.
func forgeToken(t *testing.T, key []byte, claims map[string]any) string {
	t.Helper()
	payload, err := json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
	signed := "erainfra-cache-v1." + base64.RawURLEncoding.EncodeToString(payload)
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(signed))
	return signed + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// --- Rule 1: scope by an authenticated repository claim carried in the token.

// The claim has to be stable across Attempts or the cache never hits, which is
// the half of rule 1 that a per-Attempt identifier would get wrong.
func TestRule1TwoAttemptsOfTheSameRepositoryShareEntries(t *testing.T) {
	h := newHarness(t, nil)
	body := payload(4096)

	first := h.token(cachetoken.JobFacts{
		Repository: "Fanzzzd/erainfra", Event: "push", Ref: "refs/heads/main",
		DefaultBranch: "refs/heads/main", Attempt: "attempt-one",
	})
	h.saveV1(first, keySetupNode, versionSetupNode, body, wholeBody(body))

	second := h.token(cachetoken.JobFacts{
		Repository: "Fanzzzd/erainfra", Event: "push", Ref: "refs/heads/main",
		DefaultBranch: "refs/heads/main", Attempt: "attempt-two",
	})
	response := h.do(http.MethodGet,
		v1Path("cache")+"?keys="+keySetupNode+"&version="+versionSetupNode, second, nil, nil)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("second Attempt got %d, want the first Attempt's entry", response.StatusCode)
	}
	var hit v1RestoreResponse
	decodeInto(t, response, &hit)
	if got := readAll(t, h.getURL(hit.ArchiveLocation)); !bytes.Equal(got, body) {
		t.Fatal("the second Attempt restored different bytes")
	}
}

// The other half: the same key, in another repository, is not the same entry.
func TestRule1AnotherRepositoryIsDeniedTheSameKey(t *testing.T) {
	h := newHarness(t, nil)
	body := payload(4096)

	owner := h.pushToken("Fanzzzd/erainfra", "refs/heads/main")
	h.saveV1(owner, keySetupNode, versionSetupNode, body, wholeBody(body))

	stranger := h.pushToken("attacker/erainfra", "refs/heads/main")
	v1 := h.do(http.MethodGet,
		v1Path("cache")+"?keys="+keySetupNode+"&version="+versionSetupNode, stranger, nil, nil)
	if v1.StatusCode != http.StatusNoContent {
		t.Fatalf("v1 restore for another repository = %d, want a 204 miss", v1.StatusCode)
	}
	readAll(t, v1)

	v2 := h.postJSON(v2Path("GetCacheEntryDownloadURL"), stranger,
		jsonBody(map[string]any{"key": keySetupNode, "version": versionSetupNode}))
	var miss v2DownloadResponse
	decodeInto(t, v2, &miss)
	if miss.OK {
		t.Fatalf("v2 restore for another repository = %+v, want a miss", miss)
	}
}

// "A request whose token carries no such claim is rejected rather than
// defaulted." The capture is why nothing else can carry it: the client sends
// key and version and nothing that names a repository (L008, L020), so any
// repository identity read out of a request is identity the job chose.
func TestRule1TokenWithoutARepositoryClaimIsRejected(t *testing.T) {
	h := newHarness(t, nil)
	expiry := h.now().Add(time.Hour).Unix()

	for name, claims := range map[string]map[string]any{
		"no repository field": {"ref": "refs/heads/main", "permission": "read-write", "exp": expiry},
		"empty repository":    {"repository": "", "ref": "refs/heads/main", "permission": "read-write", "exp": expiry},
		"not owner/name":      {"repository": "erainfra", "ref": "refs/heads/main", "permission": "read-write", "exp": expiry},
		"path traversal":      {"repository": "../../etc", "ref": "refs/heads/main", "permission": "read-write", "exp": expiry},
	} {
		t.Run(name, func(t *testing.T) {
			token := forgeToken(t, signingKey, claims)
			response := h.do(http.MethodGet,
				v1Path("cache")+"?keys=key-A1&version="+versionA, token, nil, nil)
			readAll(t, response)
			if response.StatusCode != http.StatusUnauthorized {
				t.Fatalf("status = %d, want 401 — a missing claim is rejected, never defaulted",
					response.StatusCode)
			}
		})
	}
}

func TestRule1ForgedAndExpiredTokensAreRejected(t *testing.T) {
	h := newHarness(t, nil)
	valid := map[string]any{
		"repository": "Fanzzzd/erainfra", "ref": "refs/heads/main",
		"permission": "read-write", "exp": h.now().Add(time.Hour).Unix(),
	}
	expired := map[string]any{
		"repository": "Fanzzzd/erainfra", "ref": "refs/heads/main",
		"permission": "read-write", "exp": h.now().Add(-time.Hour).Unix(),
	}

	for name, token := range map[string]string{
		"signed with another key": forgeToken(t, []byte("a-different-key-that-is-long-enough-0123456789"), valid),
		"already expired":         forgeToken(t, signingKey, expired),
		"no token at all":         "",
		"not a token":             "hello",
	} {
		t.Run(name, func(t *testing.T) {
			response := h.do(http.MethodGet,
				v1Path("cache")+"?keys=key-A1&version="+versionA, token, nil, nil)
			readAll(t, response)
			if response.StatusCode != http.StatusUnauthorized {
				t.Fatalf("status = %d, want 401", response.StatusCode)
			}
		})
	}
}

// --- Rule 2: a fork pull request must never write.

// The poisoning attack, in the shape ADR 0007 describes it: a fork PR's
// workflow runs attacker-authored code in a job that holds a cache token, and
// the key it would overwrite is the one setup-node restores on every later job
// (capture L020's key, verbatim).
func TestRule2ForkPullRequestCannotPoisonTheKeyTheBaseBranchRestores(t *testing.T) {
	h := newHarness(t, nil)
	clean := payload(4096)
	poison := payload(8192)

	base := h.pushToken("Fanzzzd/erainfra", "refs/heads/main")
	h.saveV1(base, keySetupNode, versionSetupNode, clean, wholeBody(clean))

	fork := h.token(cachetoken.JobFacts{
		Repository:     "Fanzzzd/erainfra",
		HeadRepository: "attacker/erainfra",
		Event:          "pull_request",
		Ref:            "refs/pull/7/merge",
		BaseRef:        "refs/heads/main",
		DefaultBranch:  "refs/heads/main",
	})

	// v1: the reservation is refused before a byte is uploaded.
	reserve := h.postJSON(v1Path("caches"), fork,
		jsonBody(map[string]any{"key": keySetupNode, "version": versionSetupNode, "cacheSize": len(poison)}))
	readAll(t, reserve)
	if reserve.StatusCode != http.StatusForbidden {
		t.Fatalf("fork v1 reserve = %d, want 403", reserve.StatusCode)
	}

	// v2: the same refusal on the other generation. A hole in one is a hole.
	create := h.postJSON(v2Path("CreateCacheEntry"), fork,
		jsonBody(map[string]any{"key": keySetupNode, "version": versionSetupNode}))
	readAll(t, create)
	if create.StatusCode != http.StatusForbidden {
		t.Fatalf("fork v2 CreateCacheEntry = %d, want 403", create.StatusCode)
	}

	// The fork still reads, scoped to the base branch's entries, which is what
	// makes a fork PR's job useful rather than merely safe.
	forkRestore := h.do(http.MethodGet,
		v1Path("cache")+"?keys="+keySetupNode+"&version="+versionSetupNode, fork, nil, nil)
	if forkRestore.StatusCode != http.StatusOK {
		t.Fatalf("fork restore = %d, want the base branch's entry", forkRestore.StatusCode)
	}
	var forkHit v1RestoreResponse
	decodeInto(t, forkRestore, &forkHit)
	if got := readAll(t, h.getURL(forkHit.ArchiveLocation)); !bytes.Equal(got, clean) {
		t.Fatal("the fork read something other than the clean entry")
	}

	// And the base branch still restores exactly what it stored.
	baseRestore := h.do(http.MethodGet,
		v1Path("cache")+"?keys="+keySetupNode+"&version="+versionSetupNode, base, nil, nil)
	var baseHit v1RestoreResponse
	decodeInto(t, baseRestore, &baseHit)
	if got := readAll(t, h.getURL(baseHit.ArchiveLocation)); !bytes.Equal(got, clean) {
		t.Fatal("the base branch restored poisoned bytes")
	}
}

// "We forgot" is how this ships, so read has to be the default and write the
// case that proves itself. A same-repository pull request is not a fork and
// keeps its write, scoped to its own pull ref.
func TestRule2WriteIsGrantedOnlyWhenTheCodeIsTheRepositoryOwn(t *testing.T) {
	for name, testCase := range map[string]struct {
		facts cachetoken.JobFacts
		write bool
	}{
		"a branch push writes": {cachetoken.JobFacts{
			Repository: "Fanzzzd/erainfra", Event: "push", Ref: "refs/heads/main"}, true},
		"a same-repository pull request writes": {cachetoken.JobFacts{
			Repository: "Fanzzzd/erainfra", HeadRepository: "Fanzzzd/erainfra",
			Event: "pull_request", Ref: "refs/pull/3/merge", BaseRef: "refs/heads/main"}, true},
		"a fork pull request does not": {cachetoken.JobFacts{
			Repository: "Fanzzzd/erainfra", HeadRepository: "attacker/erainfra",
			Event: "pull_request", Ref: "refs/pull/7/merge", BaseRef: "refs/heads/main"}, false},
		"a fork pull_request_target does not": {cachetoken.JobFacts{
			Repository: "Fanzzzd/erainfra", HeadRepository: "attacker/erainfra",
			Event: "pull_request_target", Ref: "refs/heads/main", BaseRef: "refs/heads/main"}, false},
		"a pull request with no known head repository does not": {cachetoken.JobFacts{
			Repository: "Fanzzzd/erainfra", Event: "pull_request",
			Ref: "refs/pull/9/merge", BaseRef: "refs/heads/main"}, false},
		"an event the issuer does not recognise does not": {cachetoken.JobFacts{
			Repository: "Fanzzzd/erainfra", Event: "", Ref: "refs/heads/main"}, false},
	} {
		t.Run(name, func(t *testing.T) {
			h := newHarness(t, nil)
			token := h.token(testCase.facts)

			response := h.postJSON(v1Path("caches"), token,
				jsonBody(map[string]any{"key": "probe", "version": versionA}))
			readAll(t, response)

			granted := response.StatusCode == http.StatusCreated
			if granted != testCase.write {
				t.Fatalf("reserve = %d, write granted = %v, want %v",
					response.StatusCode, granted, testCase.write)
			}
		})
	}
}

// --- Rule 3: own ref, then base ref, then default branch, never a sibling.
//
// The capture does not establish this. It shows only the mechanism the ordering
// runs on — v1 keys is a prefix match (L072) and v2 accepts a restore_keys
// array (L115) — and it contains no multi-entry restore_keys case and no ref
// other than refs/heads/main. ADR 0007 therefore makes the ordering a stage-B
// requirement to be proved by test, which is what these two are.

func TestRule3RestoreFallsBackOwnRefThenBaseRefThenDefaultBranch(t *testing.T) {
	h := newHarness(t, nil)
	const key = "dep-cache"

	fromDefault := payload(101)
	fromBase := payload(202)
	fromOwn := payload(303)

	h.saveV1(h.pushToken("Fanzzzd/erainfra", "refs/heads/main"), key, versionA, fromDefault, wholeBody(fromDefault))

	feature := func(base string) string {
		return h.token(cachetoken.JobFacts{
			Repository: "Fanzzzd/erainfra", Event: "push", Ref: "refs/heads/feature-x",
			BaseRef: base, DefaultBranch: "refs/heads/main",
		})
	}

	// Nothing on the branch or its base yet: a brand new branch is warm from
	// the default branch, which is the property people actually rely on.
	restored := h.restoreV1(feature("refs/heads/release-2"), key, versionA)
	if !bytes.Equal(restored, fromDefault) {
		t.Fatal("a new branch did not fall back to the default branch")
	}

	// The base branch is nearer than the default branch.
	h.saveV1(h.pushToken("Fanzzzd/erainfra", "refs/heads/release-2"), key, versionA, fromBase, wholeBody(fromBase))
	restored = h.restoreV1(feature("refs/heads/release-2"), key, versionA)
	if !bytes.Equal(restored, fromBase) {
		t.Fatal("the base branch did not win over the default branch")
	}

	// And the branch's own entry is nearer than either.
	h.saveV1(feature("refs/heads/release-2"), key, versionA, fromOwn, wholeBody(fromOwn))
	restored = h.restoreV1(feature("refs/heads/release-2"), key, versionA)
	if !bytes.Equal(restored, fromOwn) {
		t.Fatal("the branch's own entry did not win")
	}
}

// The isolation half of rule 3: sibling-branch reads would let any branch
// author stage bytes that another branch picks up.
func TestRule3ASiblingBranchIsNeverRestored(t *testing.T) {
	h := newHarness(t, nil)
	const key = "dep-cache"
	staged := payload(4096)

	// A branch anyone with push access can create, holding bytes of their
	// choosing under the key every job asks for.
	h.saveV1(h.pushToken("Fanzzzd/erainfra", "refs/heads/staging-ground"), key, versionA, staged, wholeBody(staged))

	victim := h.token(cachetoken.JobFacts{
		Repository: "Fanzzzd/erainfra", Event: "push", Ref: "refs/heads/feature-x",
		BaseRef: "refs/heads/main", DefaultBranch: "refs/heads/main",
	})

	v1 := h.do(http.MethodGet, v1Path("cache")+"?keys="+key+"&version="+versionA, victim, nil, nil)
	readAll(t, v1)
	if v1.StatusCode != http.StatusNoContent {
		t.Fatalf("v1 restore = %d, want a 204 miss: a sibling branch is not in the fallback chain", v1.StatusCode)
	}

	v2 := h.postJSON(v2Path("GetCacheEntryDownloadURL"), victim,
		jsonBody(map[string]any{"key": key, "restore_keys": []string{"dep-"}, "version": versionA}))
	var miss v2DownloadResponse
	decodeInto(t, v2, &miss)
	if miss.OK {
		t.Fatalf("v2 restore = %+v, want a miss — not even a prefix reaches a sibling", miss)
	}
}

// A save always lands in the token's own ref, never in the base ref it may
// read from.
func TestRule3WritesLandInTheOwnRefOnly(t *testing.T) {
	h := newHarness(t, nil)
	const key = "dep-cache"
	body := payload(256)

	feature := h.token(cachetoken.JobFacts{
		Repository: "Fanzzzd/erainfra", Event: "push", Ref: "refs/heads/feature-x",
		BaseRef: "refs/heads/main", DefaultBranch: "refs/heads/main",
	})
	h.saveV1(feature, key, versionA, body, wholeBody(body))

	// A job on main must not see what a feature branch stored.
	response := h.do(http.MethodGet, v1Path("cache")+"?keys="+key+"&version="+versionA,
		h.pushToken("Fanzzzd/erainfra", "refs/heads/main"), nil, nil)
	readAll(t, response)
	if response.StatusCode != http.StatusNoContent {
		t.Fatalf("main restored a feature branch's entry (%d)", response.StatusCode)
	}
}

// --- Rule 4: the job never holds bucket credentials.

func TestRule4NoResponseCarriesBucketCredentials(t *testing.T) {
	h := newHarness(t, nil)
	token := h.pushToken("Fanzzzd/erainfra", "refs/heads/main")
	body := payload(1024)
	h.saveV1(token, "key-A1", versionA, body, wholeBody(body))
	h.saveV2Blocks(token, "key-A2", versionA, [][]byte{body})
	h.finalizeV2(token, "key-A2", versionA, len(body))

	responses := map[string]*http.Response{
		"v1 restore": h.do(http.MethodGet, v1Path("cache")+"?keys=key-A1&version="+versionA, token, nil, nil),
		"v2 restore": h.postJSON(v2Path("GetCacheEntryDownloadURL"), token,
			jsonBody(map[string]any{"key": "key-A2", "version": versionA})),
		"v2 create": h.postJSON(v2Path("CreateCacheEntry"), token,
			jsonBody(map[string]any{"key": "key-A3", "version": versionA})),
		"v1 reserve": h.postJSON(v1Path("caches"), token,
			jsonBody(map[string]any{"key": "key-A4", "version": versionA})),
	}
	for name, response := range responses {
		body := string(readAll(t, response))
		headers := response.Header.Clone()
		// The secret is the credential. It may not appear anywhere, in any
		// encoding this service could produce.
		if strings.Contains(body, h.store.Secret) {
			t.Errorf("%s leaked the store secret in its body", name)
		}
		for header, values := range headers {
			for _, value := range values {
				if strings.Contains(value, h.store.Secret) {
					t.Errorf("%s leaked the store secret in header %s", name, header)
				}
			}
		}
	}
}

func TestRule4DownloadURLIsOneObjectOneMethodAndShortLived(t *testing.T) {
	h := newHarness(t, nil)
	token := h.pushToken("Fanzzzd/erainfra", "refs/heads/main")
	body := payload(1024)
	h.saveV1(token, "key-A1", versionA, body, wholeBody(body))

	response := h.do(http.MethodGet, v1Path("cache")+"?keys=key-A1&version="+versionA, token, nil, nil)
	var hit v1RestoreResponse
	decodeInto(t, response, &hit)

	parsed, err := url.Parse(hit.ArchiveLocation)
	if err != nil {
		t.Fatal(err)
	}
	query := parsed.Query()
	if query.Get("X-Amz-Signature") == "" {
		t.Fatal("archiveLocation is not a presigned URL")
	}
	if got := query.Get("X-Amz-SignedHeaders"); got != "host" {
		t.Errorf("X-Amz-SignedHeaders = %q", got)
	}
	expires, err := strconv.Atoi(query.Get("X-Amz-Expires"))
	if err != nil || expires <= 0 || time.Duration(expires)*time.Second > 5*time.Minute {
		t.Errorf("X-Amz-Expires = %q, want a short lifetime", query.Get("X-Amz-Expires"))
	}
	// One object: the path names a single blob and nothing bucket-wide.
	if strings.Contains(parsed.Path, "?") || !strings.Contains(parsed.Path, "/blobs/") {
		t.Errorf("path = %q, want one object under blobs/", parsed.Path)
	}
	if strings.Contains(hit.ArchiveLocation, "list-type") {
		t.Error("the download URL can list the bucket")
	}

	// The method is inside the signature, so the same URL cannot write.
	replay, err := http.NewRequest(http.MethodPut, hit.ArchiveLocation, strings.NewReader("poison"))
	if err != nil {
		t.Fatal(err)
	}
	written, err := h.http.Client().Do(replay)
	if err != nil {
		t.Fatal(err)
	}
	readAll(t, written)
	if written.StatusCode == http.StatusOK {
		t.Fatal("the download URL was accepted as a write")
	}
}

// The v2 upload URL is the one place a presigned store URL would have been the
// obvious answer and is not allowed to be: the client speaks Azure block
// protocol at it and dereferences x-ms-request-id from the reply.
func TestRule4TheV2UploadURLPointsAtThisServiceAndNotTheStore(t *testing.T) {
	h := newHarness(t, nil)
	token := h.pushToken("Fanzzzd/erainfra", "refs/heads/main")

	uploadURL := h.createV2(token, "key-A2", versionA)
	parsed, err := url.Parse(uploadURL)
	if err != nil {
		t.Fatal(err)
	}
	service, err := url.Parse(h.http.URL)
	if err != nil {
		t.Fatal(err)
	}
	store, err := url.Parse(h.store.URL)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Host != service.Host {
		t.Fatalf("signed_upload_url host = %q, want this service at %q", parsed.Host, service.Host)
	}
	if parsed.Host == store.Host {
		t.Fatal("signed_upload_url points at the store")
	}
	if strings.Contains(uploadURL, h.store.AccessKey) || strings.Contains(uploadURL, h.store.Secret) {
		t.Fatal("signed_upload_url carries store credentials")
	}
	// The credential is in the path, not the query, so an Azure client that
	// rebuilds the query for ?comp=block cannot drop it.
	if parsed.RawQuery != "" {
		t.Errorf("signed_upload_url carries a query string %q", parsed.RawQuery)
	}
}
