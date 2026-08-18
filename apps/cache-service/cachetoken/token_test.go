package cachetoken

import (
	"errors"
	"strings"
	"testing"
	"time"
)

var (
	testKey = []byte("erainfra-cache-service-test-signing-key-0123456789")
	testNow = time.Date(2026, 8, 18, 12, 0, 0, 0, time.UTC)
)

func newTestIssuer(t *testing.T) *Issuer {
	t.Helper()
	issuer, err := NewIssuer(testKey, 30*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	issuer.Now = func() time.Time { return testNow }
	return issuer
}

func newTestVerifier(t *testing.T) *Verifier {
	t.Helper()
	verifier, err := NewVerifier(testKey)
	if err != nil {
		t.Fatal(err)
	}
	return verifier
}

func TestIssueAndVerifyRoundTrip(t *testing.T) {
	issuer := newTestIssuer(t)
	token, minted, err := issuer.Issue(JobFacts{
		Repository: "Fanzzzd/erainfra", Event: "push", Ref: "refs/heads/main",
		DefaultBranch: "refs/heads/main", Attempt: "attempt-1",
	})
	if err != nil {
		t.Fatal(err)
	}

	claims, err := newTestVerifier(t).Verify(token, testNow)
	if err != nil {
		t.Fatal(err)
	}
	if claims.Repository != minted.Repository || claims.Ref != minted.Ref ||
		claims.Permission != minted.Permission {
		t.Fatalf("verified %+v, minted %+v", claims, minted)
	}
	if !claims.CanWrite() {
		t.Error("a branch push should carry write")
	}
	if claims.ExpiresAt != testNow.Add(30*time.Minute).Unix() {
		t.Errorf("exp = %d, want the configured lifetime", claims.ExpiresAt)
	}
}

// Rule 2, at the seam stage C wires into the controller. The question the
// issuer asks is not "is this a fork?" but "will this job run code the
// repository does not control?", and every way of failing to answer it lands on
// read-only.
func TestIssueGrantsWriteOnlyForCodeTheRepositoryControls(t *testing.T) {
	for name, testCase := range map[string]struct {
		facts JobFacts
		write bool
	}{
		"branch push": {JobFacts{
			Repository: "Fanzzzd/erainfra", Event: "push", Ref: "refs/heads/main"}, true},
		"schedule": {JobFacts{
			Repository: "Fanzzzd/erainfra", Event: "schedule", Ref: "refs/heads/main"}, true},
		"merge group": {JobFacts{
			Repository: "Fanzzzd/erainfra", Event: "merge_group", Ref: "refs/heads/gh-readonly-queue/main/x"}, true},
		"same-repository pull request": {JobFacts{
			Repository: "Fanzzzd/erainfra", HeadRepository: "Fanzzzd/erainfra",
			Event: "pull_request", Ref: "refs/pull/3/merge", BaseRef: "refs/heads/main"}, true},
		"same repository in another case": {JobFacts{
			Repository: "Fanzzzd/erainfra", HeadRepository: "fanzzzd/ERAINFRA",
			Event: "pull_request", Ref: "refs/pull/3/merge", BaseRef: "refs/heads/main"}, true},
		"fork pull request": {JobFacts{
			Repository: "Fanzzzd/erainfra", HeadRepository: "attacker/erainfra",
			Event: "pull_request", Ref: "refs/pull/7/merge", BaseRef: "refs/heads/main"}, false},
		// pull_request_target runs with the base repository's permissions and
		// a workflow is free to check out the fork's code in it, so it is
		// treated as a fork here. That is stricter than GitHub, deliberately.
		"fork pull_request_target": {JobFacts{
			Repository: "Fanzzzd/erainfra", HeadRepository: "attacker/erainfra",
			Event: "pull_request_target", Ref: "refs/heads/main", BaseRef: "refs/heads/main"}, false},
		"pull request review from a fork": {JobFacts{
			Repository: "Fanzzzd/erainfra", HeadRepository: "attacker/erainfra",
			Event: "pull_request_review", Ref: "refs/pull/7/merge", BaseRef: "refs/heads/main"}, false},
		"pull request with an unknown head repository": {JobFacts{
			Repository: "Fanzzzd/erainfra", Event: "pull_request",
			Ref: "refs/pull/9/merge", BaseRef: "refs/heads/main"}, false},
		"no event at all": {JobFacts{
			Repository: "Fanzzzd/erainfra", Ref: "refs/heads/main"}, false},
		// issue_comment fires in the BASE repository for a comment on a fork's
		// pull request, and the /ok-to-test pattern it exists to serve then
		// checks the fork's head out and runs it. It is not a pull-request
		// event, so a fork test written as a list of event names grants it
		// write to the base repository's cache.
		"issue_comment on a fork's pull request": {JobFacts{
			Repository: "Fanzzzd/erainfra", HeadRepository: "attacker/erainfra",
			Event: "issue_comment", Ref: "refs/heads/main", DefaultBranch: "refs/heads/main"}, false},
		"issue_comment with no fork behind it": {JobFacts{
			Repository: "Fanzzzd/erainfra", Event: "issue_comment",
			Ref: "refs/heads/main", DefaultBranch: "refs/heads/main"}, true},
		// workflow_run is the same shape one step removed: it runs on the base
		// repository's default branch after a fork's workflow finished, with
		// that workflow's artifacts to hand.
		"workflow_run after a fork's workflow": {JobFacts{
			Repository: "Fanzzzd/erainfra", HeadRepository: "attacker/erainfra",
			Event: "workflow_run", Ref: "refs/heads/main", DefaultBranch: "refs/heads/main"}, false},
		"an event nobody here has heard of, from a fork": {JobFacts{
			Repository: "Fanzzzd/erainfra", HeadRepository: "attacker/erainfra",
			Event: "some_event_invented_in_2027", Ref: "refs/heads/main",
			DefaultBranch: "refs/heads/main"}, false},
	} {
		t.Run(name, func(t *testing.T) {
			_, claims, err := newTestIssuer(t).Issue(testCase.facts)
			if err != nil {
				t.Fatal(err)
			}
			if claims.CanWrite() != testCase.write {
				t.Fatalf("permission = %q, CanWrite = %v, want %v",
					claims.Permission, claims.CanWrite(), testCase.write)
			}
		})
	}
}

// A fork pull request reads the base branch's entries and has no scope of its
// own — not even one it could write to if the permission check ever failed
// open.
func TestIssueCollapsesAForkToTheBaseBranchScope(t *testing.T) {
	_, claims, err := newTestIssuer(t).Issue(JobFacts{
		Repository: "Fanzzzd/erainfra", HeadRepository: "attacker/erainfra",
		Event: "pull_request", Ref: "refs/pull/7/merge",
		BaseRef: "refs/heads/main", DefaultBranch: "refs/heads/main",
	})
	if err != nil {
		t.Fatal(err)
	}
	if claims.Ref != "refs/heads/main" {
		t.Fatalf("ref = %q, want the base branch", claims.Ref)
	}
	if claims.WriteScope() != "refs/heads/main" || claims.CanWrite() {
		t.Fatalf("a fork must not be able to write anywhere: %+v", claims)
	}
	scopes := claims.ReadScopes()
	if len(scopes) != 1 || scopes[0] != "refs/heads/main" {
		t.Fatalf("read scopes = %v, want the base branch only", scopes)
	}
	if contains(scopes, "refs/pull/7/merge") {
		t.Fatal("the fork's own ref is still a readable scope")
	}
}

// A foreign head repository collapses the read scope too, not just the
// permission — including on an event that is not a pull request.
func TestIssueCollapsesAnyForeignHeadToTheBaseBranchScope(t *testing.T) {
	_, claims, err := newTestIssuer(t).Issue(JobFacts{
		Repository: "Fanzzzd/erainfra", HeadRepository: "attacker/erainfra",
		Event: "issue_comment", Ref: "refs/heads/main", DefaultBranch: "refs/heads/main",
	})
	if err != nil {
		t.Fatal(err)
	}
	if claims.CanWrite() {
		t.Fatal("an issue_comment carrying a fork's head repository was granted write")
	}
	scopes := claims.ReadScopes()
	if len(scopes) != 1 || scopes[0] != "refs/heads/main" {
		t.Fatalf("read scopes = %v, want the default branch only", scopes)
	}
}

// Rule 3's ordering lives in the claims, so the service cannot get it wrong by
// consulting a request.
func TestReadScopesAreOwnRefThenBaseRefThenDefaultBranch(t *testing.T) {
	claims := Claims{
		Ref: "refs/heads/feature-x", BaseRef: "refs/heads/release-2",
		DefaultBranch: "refs/heads/main",
	}
	want := []string{"refs/heads/feature-x", "refs/heads/release-2", "refs/heads/main"}
	got := claims.ReadScopes()
	if len(got) != len(want) {
		t.Fatalf("scopes = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("scopes = %v, want %v", got, want)
		}
	}
	if claims.WriteScope() != "refs/heads/feature-x" {
		t.Errorf("write scope = %q, want the own ref", claims.WriteScope())
	}
}

func TestReadScopesDropEmptiesAndDuplicates(t *testing.T) {
	claims := Claims{Ref: "refs/heads/main", BaseRef: "", DefaultBranch: "refs/heads/main"}
	if got := claims.ReadScopes(); len(got) != 1 || got[0] != "refs/heads/main" {
		t.Fatalf("scopes = %v, want one entry", got)
	}
	if got := (Claims{}).ReadScopes(); len(got) != 0 {
		t.Fatalf("scopes = %v, want none", got)
	}
}

// Rule 1: a token that verifies but names no repository is rejected, never
// defaulted to something.
func TestVerifyRejectsATokenWithoutARepositoryClaim(t *testing.T) {
	for name, repository := range map[string]string{
		"empty":          "",
		"one segment":    "erainfra",
		"three segments": "a/b/c",
		"traversal":      "../etc",
		"leading dot":    ".hidden/repo",
		"empty owner":    "/erainfra",
	} {
		t.Run(name, func(t *testing.T) {
			token, err := sign(testKey, Claims{
				Repository: repository, Ref: "refs/heads/main",
				Permission: PermissionReadWrite, ExpiresAt: testNow.Add(time.Hour).Unix(),
			})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := newTestVerifier(t).Verify(token, testNow); !errors.Is(err, ErrNoRepository) {
				t.Fatalf("err = %v, want ErrNoRepository", err)
			}
		})
	}
}

func TestVerifyRejectsForgedTamperedAndExpiredTokens(t *testing.T) {
	issuer := newTestIssuer(t)
	token, _, err := issuer.Issue(JobFacts{
		Repository: "Fanzzzd/erainfra", Event: "push", Ref: "refs/heads/main"})
	if err != nil {
		t.Fatal(err)
	}
	verifier := newTestVerifier(t)

	if _, err := verifier.Verify(token, testNow.Add(2*time.Hour)); !errors.Is(err, ErrExpired) {
		t.Errorf("expired token: err = %v, want ErrExpired", err)
	}

	other, err := NewVerifier([]byte("a-completely-different-key-0123456789-abcdef"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := other.Verify(token, testNow); !errors.Is(err, ErrSignature) {
		t.Errorf("wrong key: err = %v, want ErrSignature", err)
	}

	parts := strings.Split(token, ".")
	tampered := parts[0] + "." + strings.Repeat("A", len(parts[1])) + "." + parts[2]
	if _, err := verifier.Verify(tampered, testNow); !errors.Is(err, ErrSignature) {
		t.Errorf("tampered payload: err = %v, want ErrSignature", err)
	}

	for name, bad := range map[string]string{
		"empty":          "",
		"no parts":       "abc",
		"wrong prefix":   "erainfra-cache-v2." + parts[1] + "." + parts[2],
		"bad base64":     parts[0] + ".!!!." + parts[2],
		"too many parts": token + ".extra",
	} {
		if _, err := verifier.Verify(bad, testNow); err == nil {
			t.Errorf("%s: verified a token that should not parse", name)
		}
	}
}

// A permission string the issuer never mints must not be readable as write.
func TestUnknownPermissionIsRead(t *testing.T) {
	token, err := sign(testKey, Claims{
		Repository: "Fanzzzd/erainfra", Ref: "refs/heads/main",
		Permission: "admin", ExpiresAt: testNow.Add(time.Hour).Unix(),
	})
	if err != nil {
		t.Fatal(err)
	}
	claims, err := newTestVerifier(t).Verify(token, testNow)
	if err != nil {
		t.Fatal(err)
	}
	if claims.CanWrite() || claims.Permission != PermissionRead {
		t.Fatalf("claims = %+v, want read", claims)
	}
}

func TestShortSigningKeysAreRefused(t *testing.T) {
	if _, err := NewIssuer([]byte("too-short"), time.Minute); !errors.Is(err, ErrShortSigningKey) {
		t.Errorf("NewIssuer err = %v, want ErrShortSigningKey", err)
	}
	if _, err := NewVerifier([]byte("too-short")); !errors.Is(err, ErrShortSigningKey) {
		t.Errorf("NewVerifier err = %v, want ErrShortSigningKey", err)
	}
	if _, err := NewIssuer(testKey, 0); err == nil {
		t.Error("a zero token lifetime was accepted")
	}
}

func TestIssueRefusesFactsItCannotScope(t *testing.T) {
	issuer := newTestIssuer(t)
	for name, facts := range map[string]JobFacts{
		"no repository":  {Event: "push", Ref: "refs/heads/main"},
		"bad repository": {Repository: "erainfra", Event: "push", Ref: "refs/heads/main"},
		"no ref":         {Repository: "Fanzzzd/erainfra", Event: "push"},
	} {
		if _, _, err := issuer.Issue(facts); err == nil {
			t.Errorf("%s: Issue succeeded, want a refusal", name)
		}
	}
}

func TestValidateRepository(t *testing.T) {
	for _, good := range []string{"Fanzzzd/erainfra", "a/b", "org-name/repo.name_1"} {
		if err := ValidateRepository(good); err != nil {
			t.Errorf("ValidateRepository(%q) = %v", good, err)
		}
	}
	for _, bad := range []string{"", "erainfra", "a/b/c", "-lead/repo", "own er/repo", "own\ner/repo", "a/"} {
		if err := ValidateRepository(bad); err == nil {
			t.Errorf("ValidateRepository(%q) accepted it", bad)
		}
	}
}
