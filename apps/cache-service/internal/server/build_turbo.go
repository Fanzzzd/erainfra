package server

import (
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/Fanzzzd/erainfra/apps/cache-service/internal/cacheindex"
)

// The Turborepo Remote Cache API, v8, as specified at
// https://turborepo.dev/api/remote-cache-spec (a copy is in
// testdata/turborepo-remote-cache-spec.json, and the conformance test walks
// every operation in it). turbo appends /v8/artifacts/... to TURBO_API, so the
// guest proxy maps /v8/ onto /_erainfra-build/turbo/v8/ here.
//
// The team turbo sends as ?slug= or ?teamId= is ignored: the repository a
// request may touch comes from the runner's facts, never from the request.

// Artifact metadata headers turbo sends on upload and expects back on a hit.
const (
	turboDurationHeader  = "x-artifact-duration"
	turboTagHeader       = "x-artifact-tag"
	turboSHAHeader       = "x-artifact-sha"
	turboDirtyHashHeader = "x-artifact-dirty-hash"
)

// turboAttributes maps each stored header to its entry attribute and the
// longest value accepted. The tag's 600 is the spec's maxLength.
var turboAttributes = []struct {
	header, attribute string
	limit             int
}{
	{turboDurationHeader, "duration", 20},
	{turboTagHeader, "tag", 600},
	{turboSHAHeader, "sha", 128},
	{turboDirtyHashHeader, "dirtyHash", 128},
}

// maxTurboQueryHashes bounds POST /v8/artifacts. Each hash is a lookup, and
// turbo does not use this endpoint for a run; it is served for conformance.
const maxTurboQueryHashes = 100

// turboError writes the spec's Error object, and the same object again under
// "error", which is the shape turbo's client actually parses on a 403
// (turborepo-api-client handle_403 reads {"error":{"code","message"}}).
func turboError(w http.ResponseWriter, status int, code, message string) {
	body := map[string]string{"code": code, "message": message}
	writeJSON(w, status, map[string]any{"code": code, "message": message, "error": body})
}

func (s *Server) serveTurbo(w http.ResponseWriter, r *http.Request, rest, arch string) {
	refuse := func(status int, code, message string) { turboError(w, status, code, message) }
	route, found := strings.CutPrefix(rest, "v8/artifacts")
	if !found {
		turboError(w, http.StatusNotFound, "not_found", "no such endpoint")
		return
	}
	route = strings.TrimPrefix(route, "/")
	version := buildVersion(buildTurbo, arch)
	switch {
	case route == "status" && r.Method == http.MethodGet:
		if _, ok := s.buildClaims(r, false, refuse); !ok {
			return
		}
		// "enabled" for a read-only token too: the spec reserves "disabled"
		// for a principal that may not use the cache at all, and a fork pull
		// request may read it.
		writeJSON(w, http.StatusOK, map[string]string{"status": "enabled"})
	case route == "events" && r.Method == http.MethodPost:
		if _, ok := s.buildClaims(r, false, refuse); !ok {
			return
		}
		// Hit and miss analytics. The counters below already measure hits
		// and misses from this side, so the events are read and dropped.
		s.socketDeadline(w, s.config.ReserveTimeout)
		_, _ = io.Copy(io.Discard, io.LimitReader(r.Body, maxRequestJSON))
		w.WriteHeader(http.StatusOK)
	case route == "" && r.Method == http.MethodPost:
		s.turboQuery(w, r, version, refuse)
	case route != "" && !strings.Contains(route, "/"):
		s.turboArtifact(w, r, route, version, refuse)
	default:
		turboError(w, http.StatusNotFound, "not_found", "no such endpoint")
	}
}

func (s *Server) turboArtifact(w http.ResponseWriter, r *http.Request, hash, version string, refuse func(int, string, string)) {
	if !turboHashPattern.MatchString(hash) {
		turboError(w, http.StatusBadRequest, "bad_request", "an artifact hash is hex")
		return
	}
	key := buildKey(buildTurbo, strings.ToLower(hash))
	switch r.Method {
	case http.MethodGet, http.MethodHead:
		claims, ok := s.buildClaims(r, false, refuse)
		if !ok {
			return
		}
		entry, err := s.findBuildEntry(w, r, claims, key, version)
		if entry == nil {
			s.metrics.build(buildTurbo, missOrError(err))
			turboError(w, http.StatusNotFound, "not_found", "artifact not found")
			return
		}
		for _, attribute := range turboAttributes {
			if value := entry.Attributes[attribute.attribute]; value != "" {
				w.Header().Set(attribute.header, value)
			}
		}
		if r.Method == http.MethodHead {
			s.metrics.build(buildTurbo, buildHit)
			w.Header().Set("Content-Length", strconv.FormatInt(entry.Size, 10))
			w.WriteHeader(http.StatusOK)
			return
		}
		if sent, err := s.streamBuildEntry(w, r, entry); !sent {
			s.metrics.build(buildTurbo, missOrError(err))
			for _, attribute := range turboAttributes {
				w.Header().Del(attribute.header)
			}
			turboError(w, http.StatusNotFound, "not_found", "artifact not found")
			return
		}
		s.metrics.build(buildTurbo, buildHit)
	case http.MethodPut:
		claims, ok := s.buildClaims(r, true, refuse)
		if !ok {
			return
		}
		attributes := map[string]string{}
		for _, attribute := range turboAttributes {
			value, valid := headerValue(r, attribute.header, attribute.limit)
			if !valid {
				turboError(w, http.StatusBadRequest, "bad_request", "invalid "+attribute.header)
				return
			}
			if value != "" {
				attributes[attribute.attribute] = value
			}
		}
		if duration := attributes["duration"]; duration != "" {
			if _, err := strconv.ParseUint(duration, 10, 64); err != nil {
				turboError(w, http.StatusBadRequest, "bad_request", "invalid "+turboDurationHeader)
				return
			}
		}
		switch s.saveBuildEntry(w, r, claims, key, version, attributes) {
		case saveStored:
			s.metrics.build(buildTurbo, buildSaved)
			writeJSON(w, http.StatusAccepted, map[string][]string{"urls": {}})
		case saveExisted:
			writeJSON(w, http.StatusAccepted, map[string][]string{"urls": {}})
		case saveNeedLength:
			turboError(w, http.StatusLengthRequired, "bad_request", "Content-Length is required")
		case saveTooLarge:
			turboError(w, http.StatusRequestEntityTooLarge, "too_large", ErrEntryTooLarge.Error())
		case saveShortBody:
			turboError(w, http.StatusBadRequest, "bad_request", "the body is shorter than its Content-Length")
		default:
			// The guest proxy passes this 503 on, so turbo warns for the
			// task instead of taking the artifact as cached.
			s.metrics.build(buildTurbo, buildError)
			turboError(w, http.StatusServiceUnavailable, "unavailable", "cache store unavailable")
		}
	default:
		turboError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed")
	}
}

// turboInfo is one entry of the query response (ArtifactInfo in the spec).
type turboInfo struct {
	Size           int64  `json:"size"`
	TaskDurationMs int64  `json:"taskDurationMs"`
	Tag            string `json:"tag,omitempty"`
}

func (s *Server) turboQuery(w http.ResponseWriter, r *http.Request, version string, refuse func(int, string, string)) {
	claims, ok := s.buildClaims(r, false, refuse)
	if !ok {
		return
	}
	var request struct {
		Hashes []string `json:"hashes"`
	}
	if err := s.decodeControl(w, r, &request); err != nil {
		turboError(w, http.StatusBadRequest, "bad_request", "malformed query")
		return
	}
	if len(request.Hashes) > maxTurboQueryHashes {
		turboError(w, http.StatusBadRequest, "bad_request",
			"at most "+strconv.Itoa(maxTurboQueryHashes)+" hashes per query")
		return
	}
	response := make(map[string]any, len(request.Hashes))
	for _, hash := range request.Hashes {
		if !turboHashPattern.MatchString(hash) {
			response[hash] = map[string]any{"error": map[string]string{"message": "an artifact hash is hex"}}
			continue
		}
		entry, _ := s.findBuildEntry(w, r, claims, buildKey(buildTurbo, strings.ToLower(hash)), version)
		if entry == nil {
			response[hash] = nil
			continue
		}
		response[hash] = turboInfoOf(entry)
	}
	writeJSON(w, http.StatusOK, response)
}

func turboInfoOf(entry *cacheindex.Entry) turboInfo {
	duration, _ := strconv.ParseInt(entry.Attributes["duration"], 10, 64)
	return turboInfo{Size: entry.Size, TaskDurationMs: duration, Tag: entry.Attributes["tag"]}
}
