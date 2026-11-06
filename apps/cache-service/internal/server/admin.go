package server

import (
	"context"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/Fanzzzd/erainfra/apps/cache-service/cachetoken"
	"github.com/Fanzzzd/erainfra/apps/cache-service/internal/adminapi"
	"github.com/Fanzzzd/erainfra/apps/cache-service/internal/cacheindex"
)

// adminEntriesMarker is the admin API's one collection. Like the facts push,
// a job's cache traffic never routes here, and reaching the address directly
// is useless without the signing key.
const adminEntriesMarker = adminapi.EntriesPath

// adminBudget bounds one admin request. Listing a repository reads every entry
// document once per process (after that they are memoised), so a first list of
// a large repository is the slow case this is sized for.
const adminBudget = 2 * time.Minute

const (
	defaultPerPage = 50
	maxPerPage     = 100
)

func (s *Server) serveAdminEntries(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodDelete {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"message": "method not allowed"})
		return
	}
	s.socketDeadline(w, s.config.ReserveTimeout)
	body, err := io.ReadAll(io.LimitReader(r.Body, maxRequestJSON))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "unreadable body"})
		return
	}
	if err := s.admin.Verify(r, body); err != nil {
		s.logger.Warn("cache admin request rejected", "method", r.Method, "path", r.URL.Path, "reason", err)
		writeJSON(w, http.StatusUnauthorized, map[string]string{"message": "unauthorized"})
		return
	}

	query := r.URL.Query()
	// Every operation names one repository, and nothing defaults it: there is
	// no request that reaches across repositories, the same as for a job.
	repository := strings.TrimSpace(query.Get("repository"))
	if err := cachetoken.ValidateRepository(repository); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "repository must be owner/name"})
		return
	}

	ctx, cancel := s.deadline(w, r, adminBudget)
	defer cancel()
	if r.Method == http.MethodGet {
		s.adminList(ctx, w, repository, query)
		return
	}
	s.adminDelete(ctx, w, repository, query)
}

func (s *Server) adminList(ctx context.Context, w http.ResponseWriter, repository string, query map[string][]string) {
	get := func(name string) string {
		if values := query[name]; len(values) > 0 {
			return strings.TrimSpace(values[0])
		}
		return ""
	}
	sortBy := get("sort")
	if sortBy == "" {
		sortBy = "last_used_at"
	}
	if !containsString(adminapi.SortColumns, sortBy) {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"message": "sort must be one of " + strings.Join(adminapi.SortColumns, ", ")})
		return
	}
	direction := get("direction")
	if direction == "" {
		direction = "desc"
	}
	if direction != "asc" && direction != "desc" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "direction must be asc or desc"})
		return
	}
	page, ok := positive(get("page"), 1)
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "page must be a positive integer"})
		return
	}
	perPage, ok := positive(get("per_page"), defaultPerPage)
	if !ok || perPage > maxPerPage {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "per_page must be between 1 and 100"})
		return
	}

	repositoryID, ok := repositoryIDParam(get("repository_id"))
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "repository_id must be a positive integer"})
		return
	}

	records, err := s.index.Entries(ctx, repository, cacheindex.Match{
		Prefix: get("prefix"), Search: get("search"), Ref: get("ref"), Version: get("version"),
		RepositoryID: repositoryID,
	})
	if err != nil {
		s.logger.Error("cache admin list could not read the index", "repository", repository, "error", err)
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"message": "cache store unavailable"})
		return
	}
	holder, err := s.index.NameOwner(ctx, repository)
	if err != nil {
		s.logger.Error("cache admin list could not read the name record", "repository", repository, "error", err)
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"message": "cache store unavailable"})
		return
	}
	sortRecords(records, sortBy, direction == "desc")

	response := adminapi.ListResponse{
		Repository: repository, RepositoryID: holder, TotalCount: len(records), Page: page, PerPage: perPage,
		Entries: []adminapi.Entry{},
	}
	for _, record := range records {
		response.TotalBytes += record.Size
	}
	start := (page - 1) * perPage
	if start < len(records) {
		end := start + perPage
		if end > len(records) {
			end = len(records)
		}
		for _, record := range records[start:end] {
			response.Entries = append(response.Entries, wireEntry(record))
		}
	}
	writeJSON(w, http.StatusOK, response)
}

func (s *Server) adminDelete(ctx context.Context, w http.ResponseWriter, repository string, query map[string][]string) {
	get := func(name string) string {
		if values := query[name]; len(values) > 0 {
			return values[0]
		}
		return ""
	}
	repositoryID, ok := repositoryIDParam(get("repository_id"))
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "repository_id must be a positive integer"})
		return
	}
	match := cacheindex.Match{
		Key: get("key"), Prefix: get("prefix"), Version: get("version"), Ref: get("ref"),
		RepositoryID: repositoryID,
	}
	switch get("all") {
	case "":
	case "true":
		match.All = true
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "all must be true or absent"})
		return
	}
	// Exactly one selector. An empty prefix would match everything, and
	// "everything" has to be asked for by name.
	selectors := 0
	for _, set := range []bool{match.Key != "", match.Prefix != "", match.All} {
		if set {
			selectors++
		}
	}
	if selectors != 1 {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"message": "a delete names exactly one of key, prefix, or all=true"})
		return
	}
	// all=true may still be narrowed to one repository ID: that is how the
	// entries an earlier repository left under the name are cleared.
	if match.All && (match.Version != "" || match.Ref != "") {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"message": "all=true clears the whole repository and takes no version or ref"})
		return
	}

	removed, err := s.index.Remove(ctx, repository, match)
	response := adminapi.DeleteResponse{Repository: repository, Entries: []adminapi.Entry{}}
	for _, record := range removed {
		response.DeletedCount++
		response.DeletedBytes += record.Size
		response.Entries = append(response.Entries, wireEntry(record))
	}
	s.logger.Info("cache entries deleted by an operator", "repository", repository,
		"key", match.Key, "prefix", match.Prefix, "all", match.All, "version", match.Version,
		"ref", match.Ref, "repositoryId", match.RepositoryID,
		"deleted", response.DeletedCount, "bytes", response.DeletedBytes)
	if err != nil {
		s.logger.Error("cache admin delete stopped early", "repository", repository,
			"deleted", response.DeletedCount, "error", err)
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"message": "cache store unavailable after deleting " + strconv.Itoa(response.DeletedCount) +
				" entries; run the same delete again"})
		return
	}
	writeJSON(w, http.StatusOK, response)
}

func wireEntry(record cacheindex.Record) adminapi.Entry {
	return adminapi.Entry{
		Key: record.Key, Version: record.Version, Ref: record.Ref, SizeInBytes: record.Size,
		CreatedAt: record.Created(), LastAccessedAt: record.LastAccess.UTC(),
		RepositoryID: record.RepositoryID,
	}
}

// repositoryIDParam reads the optional repository_id filter. Absent is zero,
// which matches every entry.
func repositoryIDParam(raw string) (int64, bool) {
	if raw == "" {
		return 0, true
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value <= 0 {
		return 0, false
	}
	return value, true
}

func positive(raw string, fallback int) (int, bool) {
	if raw == "" {
		return fallback, true
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value <= 0 {
		return 0, false
	}
	return value, true
}

// sortRecords orders a listing. Every column breaks ties by key, then version,
// then ref, so a page boundary falls in the same place on every request.
func sortRecords(records []cacheindex.Record, by string, descending bool) {
	compare := func(a, b cacheindex.Record) int {
		switch by {
		case "last_used_at", "last_accessed_at":
			return a.LastAccess.Compare(b.LastAccess)
		case "created_at":
			return compareInt(a.CreatedAt, b.CreatedAt)
		case "size":
			return compareInt(a.Size, b.Size)
		case "version":
			return strings.Compare(a.Version, b.Version)
		case "ref":
			return strings.Compare(a.Ref, b.Ref)
		}
		return strings.Compare(a.Key, b.Key)
	}
	sort.SliceStable(records, func(i, j int) bool {
		order := compare(records[i], records[j])
		if order == 0 {
			order = strings.Compare(records[i].Key, records[j].Key)
		}
		if order == 0 {
			order = strings.Compare(records[i].Version, records[j].Version)
		}
		if order == 0 {
			order = strings.Compare(records[i].Ref, records[j].Ref)
		}
		if descending {
			return order > 0
		}
		return order < 0
	})
}

func compareInt(a, b int64) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	}
	return 0
}
