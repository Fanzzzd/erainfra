package server

import (
	"net/http"
	"strings"
)

// The Go build cache, as the erainfra-gocacheprog helper speaks it
// (apps/runtime/internal/gocacheprog). cmd/go's own protocol with a
// GOCACHEPROG program runs over stdin and stdout on the job's machine; this is
// the remote tier behind it, deliberately the smallest HTTP shape that carries
// cmd/go's two operations:
//
//	GET /_erainfra-build/go/<action ID>   200 + body + X-Erainfra-Go-Output-Id, or 404
//	PUT /_erainfra-build/go/<action ID>   body + X-Erainfra-Go-Output-Id + Content-Length
//
// Both IDs are SHA-256 hex, as cmd/go makes them.
func (s *Server) serveGo(w http.ResponseWriter, r *http.Request, rest, arch string) {
	refuse := func(status int, _, message string) {
		writeJSON(w, status, map[string]string{"message": message})
	}
	actionID := strings.ToLower(rest)
	if !goIDPattern.MatchString(actionID) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "an action ID is 64 hex digits"})
		return
	}
	key := buildKey(buildGo, actionID)
	version := buildVersion(buildGo, arch)
	switch r.Method {
	case http.MethodGet:
		claims, ok := s.buildClaims(r, false, refuse)
		if !ok {
			return
		}
		entry := s.findBuildEntry(w, r, claims, key, version)
		// An entry without an output ID cannot be handed to cmd/go. Only an
		// actions/cache save filed under this key and version could make one,
		// and a miss is the safe answer to it.
		if entry == nil || !goIDPattern.MatchString(entry.Attributes["outputID"]) {
			s.metrics.build(buildGo, buildMiss)
			writeJSON(w, http.StatusNotFound, map[string]string{"message": "not in the cache"})
			return
		}
		w.Header().Set(GoOutputIDHeader, entry.Attributes["outputID"])
		if !s.streamBuildEntry(w, r, entry) {
			w.Header().Del(GoOutputIDHeader)
			s.metrics.build(buildGo, buildMiss)
			writeJSON(w, http.StatusNotFound, map[string]string{"message": "not in the cache"})
			return
		}
		s.metrics.build(buildGo, buildHit)
	case http.MethodPut:
		claims, ok := s.buildClaims(r, true, refuse)
		if !ok {
			return
		}
		outputID := strings.ToLower(r.Header.Get(GoOutputIDHeader))
		if !goIDPattern.MatchString(outputID) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"message": GoOutputIDHeader + " is 64 hex digits"})
			return
		}
		switch s.saveBuildEntry(w, r, claims, key, version, map[string]string{"outputID": outputID}) {
		case saveStored:
			s.metrics.build(buildGo, buildSaved)
			w.WriteHeader(http.StatusNoContent)
		case saveExisted:
			w.WriteHeader(http.StatusNoContent)
		case saveNeedLength:
			writeJSON(w, http.StatusLengthRequired, map[string]string{"message": "Content-Length is required"})
		case saveTooLarge:
			writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"message": ErrEntryTooLarge.Error()})
		case saveShortBody:
			writeJSON(w, http.StatusBadRequest, map[string]string{"message": "the body is shorter than its Content-Length"})
		default:
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"message": "cache store unavailable"})
		}
	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"message": "method not allowed"})
	}
}
