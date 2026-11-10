package gitmirror

import (
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"slices"
	"strings"
)

// repositoryPath matches a smart HTTP upload-pack request:
// /<owner>/<name>[.git]/git-upload-pack.
var repositoryPath = regexp.MustCompile(`^/([A-Za-z0-9][A-Za-z0-9-]*)/([A-Za-z0-9._-]+?)(?:\.git)?/git-upload-pack$`)

// forwardPath is what the forwarder serves: the two endpoints a git fetch
// over smart HTTP uses, and nothing else.
var forwardPath = regexp.MustCompile(`^/[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9._-]+/(?:info/refs|git-upload-pack)$`)

func uploadPackRepository(path string) (string, bool) {
	match := repositoryPath.FindStringSubmatch(path)
	if match == nil {
		return "", false
	}
	return match[1] + "/" + match[2], true
}

// serveForward is the mirror's own route to GitHub.
func (s *Service) serveForward(w http.ResponseWriter, r *http.Request) {
	if !forwardPath.MatchString(r.URL.Path) {
		http.Error(w, "the git mirror forwarder only fetches", http.StatusForbidden)
		return
	}
	_ = http.NewResponseController(w).EnableFullDuplex()
	s.github.ServeHTTP(w, r)
}

// serveGitHub handles one request git sent to github.com through the tunnel.
func (s *Service) serveGitHub(w http.ResponseWriter, r *http.Request) {
	// The same full-duplex reason as the cache interceptor's: a reply that
	// starts before the request body is read to its end must not end it.
	_ = http.NewResponseController(w).EnableFullDuplex()
	if repository, ok := refsRepository(r); ok {
		// Forwarded as it is. A ref advertisement GitHub just granted this
		// credential is the same proof authorize would ask GitHub for, so it
		// is remembered and the fetch that follows saves a round trip.
		status := &statusWriter{ResponseWriter: w}
		s.github.ServeHTTP(status, r)
		if status.code == http.StatusOK &&
			status.Header().Get("Content-Type") == "application/x-git-upload-pack-advertisement" {
			s.rememberAuthorized(repository, r.Header.Get("Authorization"))
		}
		return
	}
	repository, ok := uploadPackRepository(r.URL.Path)
	if !ok || r.Method != http.MethodPost || !strings.Contains(r.Header.Get("Git-Protocol"), "version=2") {
		s.github.ServeHTTP(w, r)
		return
	}

	raw, complete, err := readBounded(r.Body, maxRequestBytes)
	if err != nil {
		http.Error(w, "git request unreadable", http.StatusBadGateway)
		return
	}
	if !complete {
		s.forward(w, r, io.MultiReader(bytes.NewReader(raw), r.Body), -1)
		return
	}
	authorization := r.Header.Get("Authorization")
	served := false
	if body, err := decodeBody(r.Header.Get("Content-Encoding"), raw); err == nil {
		if request, err := parseRequest(body); err == nil && request.command == "fetch" && len(request.wants) > 0 {
			if request.unsupported == "" {
				served = s.serveFromMirror(w, r, repository, authorization, request, body)
			} else {
				s.logForwarded(repository, request.unsupported)
			}
		}
	}
	if !served {
		s.forward(w, r, bytes.NewReader(raw), int64(len(raw)))
	}
	s.maybeRefresh(repository, authorization)
}

// forward sends a request to GitHub with the given body.
func (s *Service) forward(w http.ResponseWriter, r *http.Request, body io.Reader, length int64) {
	out := r.Clone(r.Context())
	out.Body = io.NopCloser(body)
	out.ContentLength = length
	s.github.ServeHTTP(w, out)
}

// serveFromMirror answers a fetch from the mirror, or reports false having
// written nothing, which sends the request to GitHub.
//
// It holds writeMu from the mirror's fetch to the end of the answer. Another
// fetch's depth-limited fetch into the mirror rewrites its shallow boundary,
// and an upload-pack reading the mirror while that happens could cut a
// whole-history answer short. A fetch that finds the mirror busy, with a
// background refresh or with another fetch, goes to GitHub at once rather than
// wait: a refresh of a large repository runs for many minutes.
func (s *Service) serveFromMirror(
	w http.ResponseWriter, r *http.Request, repository, authorization string, request fetchRequest, body []byte,
) bool {
	if request.includeTag && request.depth > 0 && request.depth < infiniteDepth {
		// Following tags needs the tags brought in line with GitHub's, which
		// git refuses on the shallow mirror this fetch would leave (see
		// below). A clone --depth that follows tags goes to GitHub;
		// actions/checkout passes --no-tags.
		s.logForwarded(repository, "include-tag with deepen")
		return false
	}
	if !s.prepare(r.Context(), repository) {
		return false
	}
	ctx := r.Context()
	if err := s.authorize(ctx, repository, authorization); err != nil {
		s.logf("git mirror: GitHub did not let this client read %s, passing its fetch to GitHub: %v", repository, err)
		return false
	}
	if !s.writeMu.TryLock() {
		s.logf("git mirror: the mirror of %s is busy (a seed refresh or another fetch), fetching from GitHub directly", repository)
		return false
	}
	defer s.writeMu.Unlock()

	// A fetch without a depth completes without asking GitHub for a wanted
	// object the mirror already holds, so for those GitHub is asked here. A
	// depth-limited fetch names every want to GitHub, which refuses one it no
	// longer serves.
	var held []string
	if request.depth == 0 {
		absent, err := s.mirror.missing(ctx, request.wants)
		if err != nil {
			s.logf("git mirror: could not read the mirror of %s, fetching from GitHub directly: %v", repository, err)
			return false
		}
		held = without(request.wants, absent)
	}
	if err := s.mirror.fetchObjects(ctx, s.upstream(repository), authorization, request.wants, request.depth); err != nil {
		s.logf("git mirror: GitHub did not give the mirror %s's wanted objects, fetching from GitHub directly: %v", repository, err)
		return false
	}
	if len(held) > 0 {
		if err := s.confirmServed(ctx, repository, authorization, held); err != nil {
			s.logf("git mirror: GitHub does not serve every object this fetch of %s wants, fetching from GitHub directly: %v", repository, err)
			return false
		}
	}
	// The client's shallow commits as well as its wants: upload-pack ignores a
	// shallow commit it does not hold, and would then leave the client's
	// boundary where it was.
	needed := append(append([]string(nil), request.wants...), request.shallows...)
	if missing, err := s.mirror.missing(ctx, needed); err != nil || len(missing) > 0 {
		s.logf("git mirror: the mirror lacks %d wanted or shallow objects of %s, fetching from GitHub directly", len(missing), repository)
		return false
	}
	if request.includeTag {
		if s.mirror.shallow() {
			// Bringing the tags in line on a shallow mirror would need new
			// shallow boundaries, which git refuses.
			s.logf("git mirror: a depth-limited fetch of %s follows tags, fetching from GitHub directly", repository)
			return false
		}
		if err := s.mirror.syncTags(ctx, s.upstream(repository), authorization); err != nil {
			s.logf("git mirror: could not bring %s's tags in line with GitHub, fetching from GitHub directly: %v", repository, err)
			return false
		}
	}
	err := s.mirror.uploadPack(ctx, body, func() io.Writer {
		header := w.Header()
		header.Set("Content-Type", "application/x-git-upload-pack-result")
		header.Set("Cache-Control", "no-cache, max-age=0, must-revalidate")
		w.WriteHeader(http.StatusOK)
		return flushWriter{w}
	})
	if errors.Is(err, errNoAnswer) {
		s.logf("git mirror: upload-pack refused a fetch of %s, fetching from GitHub directly: %v", repository, err)
		return false
	}
	if err != nil {
		// The response had begun; git sees a truncated pack and fails this
		// fetch. Nothing can be taken back at this point.
		s.logf("git mirror: serving %s stopped part way: %v", repository, err)
	}
	return true
}

// logForwarded notes, once per kind of argument, that fetches carrying it go
// to GitHub because the mirror does not reproduce it exactly.
func (s *Service) logForwarded(repository, line string) {
	kind, _, _ := strings.Cut(line, " ")
	s.mu.Lock()
	if s.forwarded == nil {
		s.forwarded = map[string]bool{}
	}
	seen := s.forwarded[kind]
	s.forwarded[kind] = true
	s.mu.Unlock()
	if !seen {
		s.logf("git mirror: fetches of %s that send %q go to GitHub directly; the mirror cannot answer them exactly", repository, line)
	}
}

func without(values, remove []string) []string {
	var kept []string
	for _, value := range values {
		if !slices.Contains(remove, value) {
			kept = append(kept, value)
		}
	}
	return kept
}

// confirmServed asks GitHub whether it serves every object in oids to this
// client now, with a fetch that wants each one and says it already has each
// one. GitHub answers that with an empty pack, or refuses it with "not our
// ref" for an object it does not have: a commit purged after a sensitive-data
// removal, say, or one from an earlier repository of the same name. Only the
// start of the answer is needed, because upload-pack checks every want before
// it begins the packfile section.
func (s *Service) confirmServed(ctx context.Context, repository, authorization string, oids []string) error {
	var body bytes.Buffer
	writePkt := func(line string) { fmt.Fprintf(&body, "%04x%s\n", len(line)+5, line) }
	writePkt("command=fetch")
	writePkt("agent=git/erainfra-git-mirror")
	writePkt("object-format=sha1")
	body.WriteString("0001")
	writePkt("no-progress")
	for _, oid := range oids {
		writePkt("want " + oid)
	}
	for _, oid := range oids {
		writePkt("have " + oid)
	}
	writePkt("done")
	body.WriteString("0000")

	target := *s.config.GitHub
	target.Path = "/" + repository + "/git-upload-pack"
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, target.String(), &body)
	if err != nil {
		return err
	}
	if authorization != "" {
		request.Header.Set("Authorization", authorization)
	}
	request.Header.Set("Git-Protocol", "version=2")
	request.Header.Set("Content-Type", "application/x-git-upload-pack-request")
	request.Header.Set("Accept", "application/x-git-upload-pack-result")
	request.Header.Set("User-Agent", "git/erainfra-git-mirror")
	response, err := s.config.Transport.RoundTrip(request)
	if err != nil {
		return err
	}
	defer response.Body.Close() //nolint:errcheck // the first line is the answer
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("GitHub answered %d", response.StatusCode)
	}
	line, err := readPktLine(response.Body)
	if err != nil {
		return err
	}
	if line != "packfile" {
		return fmt.Errorf("GitHub answered %q", line)
	}
	// The empty pack that follows is a few dozen bytes; reading it lets the
	// connection be reused.
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 1<<20))
	return nil
}

// refsPath matches the ref advertisement a smart HTTP fetch starts with.
var refsPath = regexp.MustCompile(`^/([A-Za-z0-9][A-Za-z0-9-]*)/([A-Za-z0-9._-]+?)(?:\.git)?/info/refs$`)

func refsRepository(r *http.Request) (string, bool) {
	if r.Method != http.MethodGet || r.URL.Query().Get("service") != "git-upload-pack" {
		return "", false
	}
	match := refsPath.FindStringSubmatch(r.URL.Path)
	if match == nil {
		return "", false
	}
	return match[1] + "/" + match[2], true
}

// statusWriter records the status a forwarded response was given.
type statusWriter struct {
	http.ResponseWriter
	code int
}

func (w *statusWriter) WriteHeader(code int) {
	// An informational 1xx the proxy relays is not the response's status.
	if w.code == 0 && code >= http.StatusOK {
		w.code = code
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusWriter) Write(p []byte) (int, error) {
	if w.code == 0 {
		w.code = http.StatusOK
	}
	return w.ResponseWriter.Write(p)
}

func (w *statusWriter) Flush() {
	_ = http.NewResponseController(w.ResponseWriter).Flush()
}

func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// readBounded reads up to limit bytes. complete is false when the body is
// longer, in which case raw is what was read so far.
func readBounded(body io.Reader, limit int64) (raw []byte, complete bool, err error) {
	if body == nil {
		return nil, true, nil
	}
	raw, err = io.ReadAll(io.LimitReader(body, limit+1))
	if err != nil {
		return nil, false, err
	}
	if int64(len(raw)) > limit {
		return raw, false, nil
	}
	return raw, true, nil
}

// decodeBody undoes the gzip git applies to a large request body.
func decodeBody(encoding string, raw []byte) ([]byte, error) {
	switch strings.ToLower(strings.TrimSpace(encoding)) {
	case "", "identity":
		return raw, nil
	case "gzip", "x-gzip":
		reader, err := gzip.NewReader(bytes.NewReader(raw))
		if err != nil {
			return nil, err
		}
		decoded, err := io.ReadAll(io.LimitReader(reader, maxRequestBytes+1))
		if err != nil {
			return nil, err
		}
		if len(decoded) > maxRequestBytes {
			return nil, errors.New("gitmirror: request too large once decoded")
		}
		return decoded, nil
	default:
		return nil, fmt.Errorf("gitmirror: unknown content encoding %q", encoding)
	}
}

// flushWriter sends each write on at once, so git's progress lines and the
// pack reach the client as upload-pack produces them.
type flushWriter struct{ w http.ResponseWriter }

func (f flushWriter) Write(p []byte) (int, error) {
	n, err := f.w.Write(p)
	if err == nil {
		_ = http.NewResponseController(f.w).Flush()
	}
	return n, err
}
