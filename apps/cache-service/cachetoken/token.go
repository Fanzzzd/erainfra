// Package cachetoken mints and verifies the short-lived bearer token that the
// job cache trusts, and it is deliberately the only place that decides whether
// a job may write.
//
// It is a library rather than part of the service because the two ends live in
// different processes: the controller mints a token when GitHub tells it what
// an Attempt is actually running (`JobStarted` carries the repository, ref and
// event), and the cache service verifies it on every request. They share only
// an HMAC secret, ERAINFRA_CACHE_SIGNING_KEY.
//
// ADR 0007's security contract, rule 1, is the reason the repository lives in
// the token at all: the capture shows the client sends `key` and `version` and
// nothing that names a repository (capture L008, L020), so any repository
// identity read out of a request is identity the job chose. Rule 2 is the
// reason Issue defaults to read-only: write has to prove itself from the event
// and the head repository, and anything unproven is a read token.
package cachetoken

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
)

// Permission is what a token allows. There are two, and the zero value of the
// pair is the read one, so a claim set that fails to decide cannot decide
// "write" by accident.
const (
	PermissionRead      = "read"
	PermissionReadWrite = "read-write"
)

// tokenPrefix versions the wire format. A token minted by a future issuer with
// a different layout is rejected by this verifier rather than misparsed.
const tokenPrefix = "erainfra-cache-v1"

// runnerTokenPrefix versions the runner-auth token, distinct from tokenPrefix so
// a runner token can never be parsed as an authorization token or the reverse.
// The runner token exists because a VM's repository is unknown when it boots: the
// scale set assigns the job to an already-running runner, so the host can mint an
// identity ("this is runner X") but not a scope. The service resolves the scope
// from the facts the controller pushed for X.
const runnerTokenPrefix = "erainfra-cache-runner-v1"

// MinSigningKeyLen is the shortest shared secret this package accepts. HMAC
// tolerates short keys; an operator who pastes one has not built a secret.
const MinSigningKeyLen = 32

var (
	ErrMalformed       = errors.New("cache token is malformed")
	ErrSignature       = errors.New("cache token signature does not verify")
	ErrExpired         = errors.New("cache token has expired")
	ErrNoRepository    = errors.New("cache token carries no repository claim")
	ErrNoRunner        = errors.New("cache runner token carries no runner claim")
	ErrShortSigningKey = fmt.Errorf("cache signing key must be at least %d bytes", MinSigningKeyLen)
)

// repositorySegment is one side of "owner/name". GitHub's own rules are
// narrower than this; the point here is that a claim which cannot be turned
// into a safe object-key segment is refused at the door rather than escaped
// downstream.
var repositorySegment = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)

// runnerNamePattern is the shape of a runner name — the same safe-identity charset
// the executor uses for RunnerName, so a runner token key is safe to look facts up
// by and safe to log.
var runnerNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)

// Claims is what the service gets to know about a job. Every field is minted
// by the issuer; none of it is copied from a request body.
type Claims struct {
	// Repository is "owner/name" and is stable across Attempts. Rule 1 turns
	// on that stability: a per-Attempt identifier would give every Attempt its
	// own object prefix and the cache would never hit.
	Repository string `json:"repository"`
	// Ref is the scope writes land in, and the first scope reads look in.
	Ref string `json:"ref"`
	// BaseRef and DefaultBranch are the second and third read scopes. A fork
	// pull request gets Ref already rewritten to the base branch and BaseRef
	// empty, so it has no scope of its own to read from or (were the
	// permission check ever to fail open) to write to.
	BaseRef       string `json:"baseRef,omitempty"`
	DefaultBranch string `json:"defaultBranch,omitempty"`
	// Permission is PermissionRead or PermissionReadWrite. Anything else is
	// read.
	Permission string `json:"permission"`
	// Attempt is carried for logs only. Nothing is scoped by it.
	Attempt   string `json:"attempt,omitempty"`
	IssuedAt  int64  `json:"iat"`
	ExpiresAt int64  `json:"exp"`
}

// CanWrite reports whether this token may create entries. It is a method
// rather than a comparison at each call site so that "anything that is not
// exactly read-write is read" holds everywhere.
func (c Claims) CanWrite() bool { return c.Permission == PermissionReadWrite }

// ReadScopes is the ordered list of refs a restore may match in, deduplicated
// and with empties dropped: own ref, then base ref, then default branch.
// ADR 0007 rule 3 lives here — a sibling feature branch is not on the list, so
// it cannot be read no matter what the request asks for.
func (c Claims) ReadScopes() []string {
	scopes := make([]string, 0, 3)
	for _, ref := range []string{c.Ref, c.BaseRef, c.DefaultBranch} {
		if ref == "" {
			continue
		}
		if !contains(scopes, ref) {
			scopes = append(scopes, ref)
		}
	}
	return scopes
}

// WriteScope is the single ref a save lands in. Never the base ref and never
// the default branch: a job may only add to its own scope.
func (c Claims) WriteScope() string { return c.Ref }

func contains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

// RunnerClaims is the whole of a runner-auth token: which runner made the
// request, and when the token was minted and expires. It carries no
// authorization — no repository, no permission. The cache service verifies it to
// learn the runner un-spoofably, then resolves that runner's repository and
// permission from the facts the controller pushed at JobStarted. It exists
// because those facts are not known when the runner's VM boots.
type RunnerClaims struct {
	Runner    string `json:"runner"`
	IssuedAt  int64  `json:"iat"`
	ExpiresAt int64  `json:"exp"`
}

// ValidateRunner refuses anything that is not a safe runner-name identity. Both
// ends need the same answer to "is this a runner claim at all", so it is
// exported and used by mint and verify alike.
func ValidateRunner(runner string) error {
	if runner == "" {
		return ErrNoRunner
	}
	if !runnerNamePattern.MatchString(runner) {
		return fmt.Errorf("%w: %q", ErrNoRunner, runner)
	}
	return nil
}

// JobFacts is what the controller knows at JobStarted. It is the whole input
// to the write decision, named as facts rather than as a request so that the
// seam reads the same on both sides of stage C.
type JobFacts struct {
	// Repository is the repository the Attempt belongs to. For a pull request
	// that is the base repository, which is exactly the one whose cache is at
	// stake.
	Repository string
	// HeadRepository is where the code that will run comes from. Empty for
	// events that have no head repository, which is most of them.
	//
	// Whoever fills this in owes it for every event that has one, not only for
	// pull requests: a foreign head repository is what denies write, and an
	// `issue_comment` or `workflow_run` on a fork's pull request that arrives
	// here with this field empty is indistinguishable from a job on the
	// repository's own code.
	HeadRepository string
	// Event is the GitHub event name: push, pull_request, schedule, ...
	Event string
	// Ref is the ref the job runs on.
	Ref string
	// BaseRef is the pull request's base ref, empty otherwise.
	BaseRef string
	// DefaultBranch is the repository's default branch as a full ref. Optional:
	// without it the third fallback scope simply does not exist, which costs
	// warm caches on new branches but is not a security property.
	DefaultBranch string
	// Attempt is carried into the token for logs.
	Attempt string
}

// pullRequestEvents are the events on which an unknown head repository is
// treated as a foreign one. It is deliberately not the whole of the fork test —
// a head repository that differs denies write on any event at all — because a
// list of event names is exactly the thing that goes stale: `issue_comment` and
// `workflow_run` both carry fork code into the base repository and neither is a
// pull-request event.
var pullRequestEvents = map[string]bool{
	"pull_request":                true,
	"pull_request_target":         true,
	"pull_request_review":         true,
	"pull_request_review_comment": true,
}

// Issuer mints tokens. One per process; safe for concurrent use.
type Issuer struct {
	key []byte
	ttl time.Duration
	// Now is the clock. Tests replace it; production leaves it nil.
	Now func() time.Time
}

// NewIssuer returns an Issuer over a shared secret. ttl is how long a minted
// token stays valid — short, because it is handed to untrusted code.
func NewIssuer(signingKey []byte, ttl time.Duration) (*Issuer, error) {
	if len(signingKey) < MinSigningKeyLen {
		return nil, ErrShortSigningKey
	}
	if ttl <= 0 {
		return nil, errors.New("cache token lifetime must be positive")
	}
	return &Issuer{key: append([]byte(nil), signingKey...), ttl: ttl}, nil
}

func (i *Issuer) now() time.Time {
	if i.Now != nil {
		return i.Now()
	}
	return time.Now()
}

// Issue turns what the controller learned at JobStarted into a token and the
// claims that token carries. The claims are returned as well so the caller can
// log what it granted without parsing its own token back.
func (i *Issuer) Issue(facts JobFacts) (string, Claims, error) {
	claims, err := Scope(facts)
	if err != nil {
		return "", Claims{}, err
	}
	now := i.now().UTC()
	claims.IssuedAt = now.Unix()
	claims.ExpiresAt = now.Add(i.ttl).Unix()

	token, err := sign(i.key, claims)
	if err != nil {
		return "", Claims{}, err
	}
	return token, claims, nil
}

// Scope derives the claims a set of job facts authorizes — the repository, the
// read and write ref scopes, and read-versus-write — without minting or timing a
// token. It is the whole of ADR 0007 rule 2. It is exported because the decision
// is made in two places over the same rule: Issue applies it at mint time, and
// the cache service applies it at request time to the facts the controller pushed
// for the runner, because a VM's repository is not known when it boots.
func Scope(facts JobFacts) (Claims, error) {
	repository := strings.TrimSpace(facts.Repository)
	if err := ValidateRepository(repository); err != nil {
		return Claims{}, err
	}
	ref := strings.TrimSpace(facts.Ref)
	if ref == "" {
		return Claims{}, errors.New("cache token needs a ref")
	}

	claims := Claims{
		Repository:    repository,
		Ref:           ref,
		BaseRef:       strings.TrimSpace(facts.BaseRef),
		DefaultBranch: strings.TrimSpace(facts.DefaultBranch),
		Permission:    PermissionRead,
		Attempt:       strings.TrimSpace(facts.Attempt),
	}

	// Rule 2. The question is never "is this a fork?" in the abstract, it is
	// "will this job run code the repository does not control?", and there are
	// two ways for the answer to be yes.
	//
	// The first is a head repository that is not this repository, whatever the
	// event. This is not an "if the event is a pull request" test, and it must
	// not become one: `issue_comment` fires in the BASE repository for a
	// comment on a fork's pull request, and the /ok-to-test pattern it exists
	// to serve then checks the fork's head out and runs it. So does
	// `workflow_run` after a fork's workflow. An earlier version of this
	// function granted write to every event that was not on a list of
	// pull-request event names, which meant every one of those shapes wrote to
	// the base repository's cache. The list is now the narrow case and a
	// foreign head repository is the general one.
	//
	// The second is a pull request whose head repository the controller could
	// not name. Unknown is not the same as absent: on a pull request it means
	// the fact that decides this was not measured, and CONTEXT.md's rule for
	// that is that absence is never a successful measurement.
	event := strings.ToLower(strings.TrimSpace(facts.Event))
	head := strings.TrimSpace(facts.HeadRepository)
	untrusted := (head != "" && !strings.EqualFold(head, repository)) ||
		(pullRequestEvents[event] && head == "")
	if untrusted {
		// An untrusted job reads the base branch's entries and has no scope of
		// its own. Collapsing Ref here rather than special-casing the service
		// means there is one place where such a job's scope is decided. If
		// neither a base ref nor a default branch is known, it is left with no
		// readable scope at all rather than with its own.
		base := claims.BaseRef
		if base == "" {
			base = claims.DefaultBranch
		}
		claims.Ref = base
		claims.BaseRef = ""
	} else if event != "" {
		claims.Permission = PermissionReadWrite
	}

	return claims, nil
}

// IssueRunner mints a runner-auth token: it names the runner and nothing else.
// The host mints it at claim time, when the runner name is known but the
// repository is not, and it lives long enough to cover a whole job (the issuer's
// ttl). The returned claims let the caller log what it minted without parsing its
// own token back.
func (i *Issuer) IssueRunner(runner string) (string, RunnerClaims, error) {
	runner = strings.TrimSpace(runner)
	if err := ValidateRunner(runner); err != nil {
		return "", RunnerClaims{}, err
	}
	now := i.now().UTC()
	claims := RunnerClaims{
		Runner:    runner,
		IssuedAt:  now.Unix(),
		ExpiresAt: now.Add(i.ttl).Unix(),
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", RunnerClaims{}, err
	}
	return signPayload(i.key, runnerTokenPrefix, payload), claims, nil
}

// Verifier checks tokens. One per process; safe for concurrent use.
type Verifier struct {
	key []byte
	// Leeway absorbs clock skew between the issuer and the service. Keep it
	// small: it extends the life of a token handed to untrusted code.
	Leeway time.Duration
}

// NewVerifier returns a Verifier over the same shared secret the issuer holds.
func NewVerifier(signingKey []byte) (*Verifier, error) {
	if len(signingKey) < MinSigningKeyLen {
		return nil, ErrShortSigningKey
	}
	return &Verifier{key: append([]byte(nil), signingKey...), Leeway: 30 * time.Second}, nil
}

// Verify authenticates a token and returns its claims. Every failure mode is a
// distinct sentinel so the service can log which one happened without
// reporting it to the job, and a token that verifies but carries no repository
// claim fails here rather than being defaulted to something (rule 1).
func (v *Verifier) Verify(token string, now time.Time) (Claims, error) {
	payload, err := verifyPayload(v.key, tokenPrefix, token)
	if err != nil {
		return Claims{}, err
	}

	var claims Claims
	if err := json.Unmarshal(payload, &claims); err != nil {
		return Claims{}, ErrMalformed
	}
	if err := ValidateRepository(claims.Repository); err != nil {
		return Claims{}, ErrNoRepository
	}
	if claims.ExpiresAt == 0 || now.Add(-v.Leeway).Unix() > claims.ExpiresAt {
		return Claims{}, ErrExpired
	}
	if claims.Permission != PermissionReadWrite {
		claims.Permission = PermissionRead
	}
	return claims, nil
}

// VerifyRunner authenticates a runner-auth token and returns which runner it
// names. Like Verify, every failure is a distinct sentinel, and a token that
// verifies but names no runner fails here rather than being defaulted.
func (v *Verifier) VerifyRunner(token string, now time.Time) (RunnerClaims, error) {
	payload, err := verifyPayload(v.key, runnerTokenPrefix, token)
	if err != nil {
		return RunnerClaims{}, err
	}
	var claims RunnerClaims
	if err := json.Unmarshal(payload, &claims); err != nil {
		return RunnerClaims{}, ErrMalformed
	}
	if err := ValidateRunner(claims.Runner); err != nil {
		return RunnerClaims{}, ErrNoRunner
	}
	if claims.ExpiresAt == 0 || now.Add(-v.Leeway).Unix() > claims.ExpiresAt {
		return RunnerClaims{}, ErrExpired
	}
	return claims, nil
}

// ValidateRepository refuses anything that is not "owner/name" in a charset
// that survives being an object-key segment. It is exported because both ends
// of the seam need the same answer to "is this a repository claim at all".
func ValidateRepository(repository string) error {
	if repository == "" {
		return ErrNoRepository
	}
	owner, name, found := strings.Cut(repository, "/")
	if !found || !repositorySegment.MatchString(owner) || !repositorySegment.MatchString(name) {
		return fmt.Errorf("%w: %q is not owner/name", ErrNoRepository, repository)
	}
	return nil
}

func sign(key []byte, claims Claims) (string, error) {
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	return signPayload(key, tokenPrefix, payload), nil
}

// signPayload renders a prefixed, HMAC-signed token: prefix.base64(payload).base64(mac).
// The prefix versions the wire format and keeps two token kinds over the same key
// from being parsed as each other.
func signPayload(key []byte, prefix string, payload []byte) string {
	signed := prefix + "." + base64.RawURLEncoding.EncodeToString(payload)
	return signed + "." + base64.RawURLEncoding.EncodeToString(macOf(key, signed))
}

// verifyPayload authenticates a prefixed, HMAC-signed token's wire format and
// signature and returns its raw payload. The caller unmarshals it and applies its
// own claim rules; a wrong prefix is a malformed token, never a silent accept.
func verifyPayload(key []byte, prefix, token string) ([]byte, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 || parts[0] != prefix {
		return nil, ErrMalformed
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, ErrMalformed
	}
	mac, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return nil, ErrMalformed
	}
	if !hmac.Equal(mac, macOf(key, parts[0]+"."+parts[1])) {
		return nil, ErrSignature
	}
	return payload, nil
}

func macOf(key []byte, signed string) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(signed))
	return mac.Sum(nil)
}
