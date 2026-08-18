// Package server speaks both generations of GitHub's Actions cache protocol.
//
// Both are implemented because ADR 0007 measured that neither is optional: the
// generation is selected by ACTIONS_CACHE_SERVICE_V2, that flag is GitHub's to
// set, and client version overrides it in both directions — actions/cache
// v4.0.2 has no v2 path at all (capture L013-L018) and buildx v0.20.1 stays on
// v1 even with the flag set (capture L147-L164).
package server

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Fanzzzd/erainfra/apps/cache-service/cachetoken"
	"github.com/Fanzzzd/erainfra/apps/cache-service/internal/cacheindex"
	"github.com/Fanzzzd/erainfra/apps/cache-service/internal/config"
	"github.com/Fanzzzd/erainfra/apps/cache-service/internal/objectstore"
)

// Path markers. Each is matched anywhere in the path rather than at the root,
// because ACTIONS_CACHE_URL carries a per-job path prefix — the capture writes
// it as {ACTIONS_CACHE_URL} for exactly that reason — and whoever composes the
// job environment is free to put something in front of us.
const (
	v1Marker       = "/_apis/artifactcache/"
	v2Marker       = "/twirp/github.actions.results.api.v1.CacheService/"
	blobMarker     = "/_erainfra-cache-blob/"
	downloadMarker = "/_erainfra-cache-download/"
	healthPath     = "/healthz"
)

// maxRequestJSON bounds a control-plane request body. The largest one measured
// is a v1 reserve carrying a 100-character key (capture L020).
const maxRequestJSON = 1 << 20

// maxCacheKeyBytes matches GitHub's own limit. It matters here for a second
// reason: v1 packs restore keys into one comma-separated query parameter, so an
// unbounded key is an unbounded URL.
const maxCacheKeyBytes = 512

// Server holds the protocol state that cannot live in the bucket: v1
// reservations between POST and commit, and v2 upload sessions between
// CreateCacheEntry and FinalizeCacheEntryUpload.
type Server struct {
	config config.Config
	index  *cacheindex.Index
	verify *cachetoken.Verifier
	logger *slog.Logger

	// Now is the clock. Tests replace it.
	Now func() time.Time

	mu           sync.Mutex
	reservations map[int64]*reservation
	sessions     map[string]*session

	stopOnce sync.Once
	stop     chan struct{}
	done     chan struct{}
}

// New builds a server over an already-validated store.
func New(cfg config.Config, store objectstore.Store, logger *slog.Logger) (*Server, error) {
	if logger == nil {
		logger = slog.Default()
	}
	verify, err := cachetoken.NewVerifier(cfg.SigningKey)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(cfg.SpoolDir, 0o700); err != nil {
		return nil, fmt.Errorf("create ERAINFRA_CACHE_SPOOL_DIR: %w", err)
	}
	server := &Server{
		config:       cfg,
		index:        cacheindex.New(store, logger),
		verify:       verify,
		logger:       logger,
		reservations: map[int64]*reservation{},
		sessions:     map[string]*session{},
		stop:         make(chan struct{}),
		done:         make(chan struct{}),
	}
	go server.sweep()
	return server, nil
}

// Close stops the janitor and drops every spooled byte. A cache entry that was
// mid-upload is lost, which is a miss on the next job rather than a corrupt
// entry.
func (s *Server) Close() {
	s.stopOnce.Do(func() {
		close(s.stop)
		<-s.done
		s.mu.Lock()
		defer s.mu.Unlock()
		for id, held := range s.reservations {
			held.discard()
			delete(s.reservations, id)
		}
		for id, held := range s.sessions {
			held.discard()
			delete(s.sessions, id)
		}
	})
}

func (s *Server) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

// sweep drops reservations and sessions whose client went away. Without it a
// job that starts an upload and dies holds a spool file forever.
func (s *Server) sweep() {
	defer close(s.done)
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-s.stop:
			return
		case <-ticker.C:
			now := s.now()
			s.mu.Lock()
			for id, held := range s.reservations {
				if now.After(held.expires) {
					held.discard()
					delete(s.reservations, id)
				}
			}
			for id, held := range s.sessions {
				if now.After(held.expires) {
					held.discard()
					delete(s.sessions, id)
				}
			}
			s.mu.Unlock()
		}
	}
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	switch {
	case path == healthPath:
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	case strings.Contains(path, blobMarker):
		s.serveBlob(w, r, after(path, blobMarker))
	case strings.Contains(path, downloadMarker):
		s.serveDownload(w, r, after(path, downloadMarker))
	case strings.Contains(path, v1Marker):
		s.serveV1(w, r, after(path, v1Marker))
	case strings.Contains(path, v2Marker):
		s.serveV2(w, r, after(path, v2Marker))
	default:
		http.NotFound(w, r)
	}
}

func after(path, marker string) string {
	index := strings.Index(path, marker)
	return strings.TrimPrefix(path[index+len(marker):], "/")
}

// authenticate turns the bearer token into claims. Every failure is the same
// answer to the client and a distinct line in the log: a job learns only that
// it is not authorised, and an operator learns which of malformed, forged and
// expired it was.
//
// A restore that fails here is a 401 and not a silent miss on purpose. A miss
// is what a working cache says about a key it does not have; a
// misconfigured token would otherwise look exactly like a cache that is simply
// always cold.
func (s *Server) authenticate(r *http.Request) (cachetoken.Claims, bool) {
	header := r.Header.Get("Authorization")
	raw, found := strings.CutPrefix(header, "Bearer ")
	if !found {
		raw, found = strings.CutPrefix(header, "bearer ")
	}
	if !found || strings.TrimSpace(raw) == "" {
		s.logger.Warn("cache request carried no bearer token", "path", r.URL.Path)
		return cachetoken.Claims{}, false
	}
	claims, err := s.verify.Verify(strings.TrimSpace(raw), s.now())
	if err != nil {
		s.logger.Warn("cache token rejected", "path", r.URL.Path, "reason", err)
		return cachetoken.Claims{}, false
	}
	return claims, true
}

// require authenticates and, when write is asked for, enforces rule 2. The
// permission is decided by the issuer from the event and the head repository;
// this end only reads what was minted, which is what keeps "the default is
// read" true no matter what a job sends.
func (s *Server) require(w http.ResponseWriter, r *http.Request, write bool) (cachetoken.Claims, bool) {
	claims, ok := s.authenticate(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"message": "unauthorized"})
		return cachetoken.Claims{}, false
	}
	if write && !claims.CanWrite() {
		s.logger.Warn("refused a cache write to a read-only token",
			"repository", claims.Repository, "ref", claims.Ref, "path", r.URL.Path)
		writeJSON(w, http.StatusForbidden, map[string]string{"message": "this token may not write cache entries"})
		return cachetoken.Claims{}, false
	}
	return claims, true
}

// deadline gives a handler its budget and pins the socket to the same one, so
// neither a hung store nor a client that stops reading can hold the handler
// past it.
func (s *Server) deadline(w http.ResponseWriter, r *http.Request, budget time.Duration) (context.Context, context.CancelFunc) {
	controller := http.NewResponseController(w)
	_ = controller.SetWriteDeadline(s.now().Add(budget + 5*time.Second))
	return context.WithTimeout(r.Context(), budget)
}

// readBodyDeadline bounds how long a client may take to deliver a body. A
// request that stalls mid-chunk otherwise holds a spool file and a goroutine
// for as long as the connection stays open.
func (s *Server) readBodyDeadline(w http.ResponseWriter) {
	controller := http.NewResponseController(w)
	_ = controller.SetReadDeadline(s.now().Add(s.config.TransferTimeout))
	_ = controller.SetWriteDeadline(s.now().Add(s.config.TransferTimeout + 30*time.Second))
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func decodeJSON(r *http.Request, target any) error {
	return json.NewDecoder(io.LimitReader(r.Body, maxRequestJSON)).Decode(target)
}

// validateKey refuses keys this service cannot round-trip. A comma is refused
// because v1 splits `keys` on it (capture L001), so a key containing one could
// never be asked for again.
func validateKey(key string) error {
	switch {
	case strings.TrimSpace(key) == "":
		return errors.New("a cache key is required")
	case len(key) > maxCacheKeyBytes:
		return fmt.Errorf("a cache key may be at most %d bytes", maxCacheKeyBytes)
	case strings.Contains(key, ","):
		return errors.New("a cache key may not contain a comma")
	}
	for i := 0; i < len(key); i++ {
		if key[i] < 0x20 || key[i] == 0x7f {
			return errors.New("a cache key may not contain control characters")
		}
	}
	return nil
}

func validateVersion(version string) error {
	if strings.TrimSpace(version) == "" {
		return errors.New("a cache version is required")
	}
	if len(version) > maxCacheKeyBytes {
		return fmt.Errorf("a cache version may be at most %d bytes", maxCacheKeyBytes)
	}
	return nil
}

// publicBase is the URL a job reaches this service at. It is taken from the
// request unless an operator pinned one, because the service does not
// otherwise know what hostname the job resolved.
func (s *Server) publicBase(r *http.Request) string {
	if s.config.PublicURL != "" {
		return s.config.PublicURL
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	if forwarded := r.Header.Get("X-Forwarded-Proto"); forwarded != "" {
		scheme = forwarded
	}
	return scheme + "://" + r.Host
}

func randomHex(bytes int) (string, error) {
	buffer := make([]byte, bytes)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return hex.EncodeToString(buffer), nil
}

// signName binds a name to this service's signing key and an expiry. It is
// what makes an upload or download URL usable without an Authorization header:
// the Azure client that consumes a signed_upload_url sends no bearer token, so
// the URL itself has to carry the authority.
func (s *Server) signName(kind, subject string, expires time.Time) string {
	stamp := strconv.FormatInt(expires.Unix(), 10)
	mac := hmac.New(sha256.New, s.config.SigningKey)
	mac.Write([]byte(kind + "\x00" + subject + "\x00" + stamp))
	return subject + "-" + stamp + "-" + hex.EncodeToString(mac.Sum(nil)[:16])
}

func (s *Server) verifyName(kind, name string) (string, bool) {
	parts := strings.Split(name, "-")
	if len(parts) != 3 {
		return "", false
	}
	stamp, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil {
		return "", false
	}
	expires := time.Unix(stamp, 0)
	if s.now().After(expires) {
		return "", false
	}
	if !hmac.Equal([]byte(s.signName(kind, parts[0], expires)), []byte(name)) {
		return "", false
	}
	return parts[0], true
}

// spoolPath is where one upload's bytes wait. It is under the configured spool
// directory and named by an unguessable id, never by anything a client chose.
func (s *Server) spoolPath(id string) string {
	return filepath.Join(s.config.SpoolDir, id)
}
