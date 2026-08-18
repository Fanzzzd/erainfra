// Package fakes3 is an in-process stand-in for an S3-compatible store.
//
// It exists so the cache service's tests exercise the real signer, the real
// multipart coalescing and the real HTTP path rather than a hand-written
// double of the store seam. Nothing in the service imports it.
package fakes3

import (
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sort"
	"strconv"
	"strings"
	"sync"
)

// Server is a bucket that speaks enough of the S3 API for this service: put,
// get, delete, list-type=2, and the four multipart calls.
type Server struct {
	*httptest.Server
	Bucket    string
	AccessKey string
	Secret    string

	mu      sync.Mutex
	objects map[string][]byte
	parts   map[string]map[int][]byte
	nextID  int

	fail  func(method, key string, query map[string][]string) int
	stall func(method, key string) <-chan struct{}
}

// SetFail injects a store fault. It is consulted for every request; a non-zero
// return is sent as the status. Setting it is guarded because a test changes it
// while requests are in flight.
func (s *Server) SetFail(fail func(method, key string, query map[string][]string) int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.fail = fail
}

// SetStall reproduces the outage shape ADR 0007 calls the dangerous one: the
// store accepts the connection and never answers. A non-nil channel parks the
// request until it closes or the caller gives up.
func (s *Server) SetStall(stall func(method, key string) <-chan struct{}) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.stall = stall
}

func (s *Server) hooks() (func(string, string, map[string][]string) int, func(string, string) <-chan struct{}) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.fail, s.stall
}

// New starts a fake store. The caller closes it.
func New() *Server {
	server := &Server{
		Bucket:    "erainfra-cache-test",
		AccessKey: "AKIAIOSFODNN7EXAMPLE",
		Secret:    "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
		objects:   map[string][]byte{},
		parts:     map[string]map[int][]byte{},
	}
	server.Server = httptest.NewServer(http.HandlerFunc(server.serve))
	return server
}

// Object returns a stored object and whether it exists.
func (s *Server) Object(key string) ([]byte, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	body, ok := s.objects[key]
	return body, ok
}

// Overwrite replaces an object's bytes without going through the API, so a
// test can inject a document the service would never write.
func (s *Server) Overwrite(key string, body []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.objects[key] = body
}

// Keys returns every stored key, sorted.
func (s *Server) Keys() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	keys := make([]string, 0, len(s.objects))
	for key := range s.objects {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func (s *Server) serve(w http.ResponseWriter, r *http.Request) {
	// Every request must carry a credential: either the header form or the
	// query form of a presigned URL. A store that answered unsigned requests
	// would let the service's tests pass with a signer that emits nothing.
	query := r.URL.Query()
	if r.Header.Get("Authorization") == "" && query.Get("X-Amz-Signature") == "" {
		http.Error(w, "<Error><Code>AccessDenied</Code><Message>unsigned</Message></Error>", http.StatusForbidden)
		return
	}
	// A presigned URL is signed for one method. The fake enforces that much of
	// rule 4 directly: the method is in the signature, so a URL minted for GET
	// arriving as anything else is refused.
	if query.Get("X-Amz-Signature") != "" && r.Method != http.MethodGet {
		http.Error(w, "<Error><Code>SignatureDoesNotMatch</Code><Message>method</Message></Error>", http.StatusForbidden)
		return
	}

	path := strings.TrimPrefix(r.URL.Path, "/")
	bucket, key, _ := strings.Cut(path, "/")
	if bucket != s.Bucket {
		http.Error(w, "<Error><Code>NoSuchBucket</Code><Message>bucket</Message></Error>", http.StatusNotFound)
		return
	}
	fail, stall := s.hooks()
	if stall != nil {
		if wait := stall(r.Method, key); wait != nil {
			select {
			case <-wait:
			case <-r.Context().Done():
				// The caller's deadline fired. Returning here rather than
				// holding the goroutine is what lets a test close this server.
				return
			}
		}
	}
	if fail != nil {
		if status := fail(r.Method, key, query); status != 0 {
			http.Error(w, "<Error><Code>InternalError</Code><Message>injected</Message></Error>", status)
			return
		}
	}

	switch {
	case r.Method == http.MethodGet && key == "" && query.Get("list-type") == "2":
		s.list(w, query)
	case r.Method == http.MethodGet:
		s.get(w, key)
	case r.Method == http.MethodPost && query.Has("uploads"):
		s.startMultipart(w, key)
	case r.Method == http.MethodPost && query.Get("uploadId") != "":
		s.completeMultipart(w, r, key, query.Get("uploadId"))
	case r.Method == http.MethodDelete && query.Get("uploadId") != "":
		s.abortMultipart(w, query.Get("uploadId"))
	case r.Method == http.MethodPut && query.Get("uploadId") != "":
		s.uploadPart(w, r, query.Get("uploadId"), query.Get("partNumber"))
	case r.Method == http.MethodPut:
		s.put(w, r, key)
	case r.Method == http.MethodDelete:
		s.mu.Lock()
		delete(s.objects, key)
		s.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	default:
		http.Error(w, "<Error><Code>MethodNotAllowed</Code><Message>no</Message></Error>", http.StatusMethodNotAllowed)
	}
}

func (s *Server) get(w http.ResponseWriter, key string) {
	body, ok := s.Object(key)
	if !ok {
		http.Error(w, "<Error><Code>NoSuchKey</Code><Message>missing</Message></Error>", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.Header().Set("ETag", etagOf(body))
	_, _ = w.Write(body)
}

func (s *Server) put(w http.ResponseWriter, r *http.Request, key string) {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "<Error><Code>IncompleteBody</Code><Message>read</Message></Error>", http.StatusBadRequest)
		return
	}
	s.mu.Lock()
	s.objects[key] = body
	s.mu.Unlock()
	w.Header().Set("ETag", etagOf(body))
	w.WriteHeader(http.StatusOK)
}

func (s *Server) list(w http.ResponseWriter, query map[string][]string) {
	prefix := first(query, "prefix")
	max, err := strconv.Atoi(first(query, "max-keys"))
	if err != nil || max <= 0 {
		max = 1000
	}

	type content struct {
		Key  string `xml:"Key"`
		Size int64  `xml:"Size"`
	}
	var result struct {
		XMLName     xml.Name  `xml:"ListBucketResult"`
		IsTruncated bool      `xml:"IsTruncated"`
		Contents    []content `xml:"Contents"`
	}
	for _, key := range s.Keys() {
		if !strings.HasPrefix(key, prefix) {
			continue
		}
		if len(result.Contents) == max {
			result.IsTruncated = true
			break
		}
		body, _ := s.Object(key)
		result.Contents = append(result.Contents, content{Key: key, Size: int64(len(body))})
	}
	w.Header().Set("Content-Type", "application/xml")
	_ = xml.NewEncoder(w).Encode(result)
}

func (s *Server) startMultipart(w http.ResponseWriter, key string) {
	s.mu.Lock()
	s.nextID++
	id := fmt.Sprintf("upload-%d-%s", s.nextID, key)
	s.parts[id] = map[int][]byte{}
	s.mu.Unlock()

	w.Header().Set("Content-Type", "application/xml")
	_, _ = fmt.Fprintf(w, "<InitiateMultipartUploadResult><UploadId>%s</UploadId></InitiateMultipartUploadResult>", id)
}

func (s *Server) uploadPart(w http.ResponseWriter, r *http.Request, uploadID, partNumber string) {
	number, err := strconv.Atoi(partNumber)
	if err != nil {
		http.Error(w, "<Error><Code>InvalidPart</Code><Message>number</Message></Error>", http.StatusBadRequest)
		return
	}
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "<Error><Code>IncompleteBody</Code><Message>read</Message></Error>", http.StatusBadRequest)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.parts[uploadID] == nil {
		http.Error(w, "<Error><Code>NoSuchUpload</Code><Message>id</Message></Error>", http.StatusNotFound)
		return
	}
	s.parts[uploadID][number] = body
	w.Header().Set("ETag", etagOf(body))
	w.WriteHeader(http.StatusOK)
}

func (s *Server) completeMultipart(w http.ResponseWriter, r *http.Request, key, uploadID string) {
	var request struct {
		Parts []struct {
			Number int    `xml:"PartNumber"`
			ETag   string `xml:"ETag"`
		} `xml:"Part"`
	}
	if err := xml.NewDecoder(r.Body).Decode(&request); err != nil {
		http.Error(w, "<Error><Code>MalformedXML</Code><Message>body</Message></Error>", http.StatusBadRequest)
		return
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	staged := s.parts[uploadID]
	if staged == nil {
		http.Error(w, "<Error><Code>NoSuchUpload</Code><Message>id</Message></Error>", http.StatusNotFound)
		return
	}
	var assembled []byte
	for _, part := range request.Parts {
		body, ok := staged[part.Number]
		if !ok {
			http.Error(w, "<Error><Code>InvalidPart</Code><Message>missing</Message></Error>", http.StatusBadRequest)
			return
		}
		// S3 refuses any part but the last under 5 MiB, and the whole point of
		// the coalescing in the client is to never send one. Enforce it here so
		// a regression fails a test rather than a production upload.
		if part.Number != request.Parts[len(request.Parts)-1].Number && len(body) < 5<<20 {
			http.Error(w, "<Error><Code>EntityTooSmall</Code><Message>part</Message></Error>", http.StatusBadRequest)
			return
		}
		assembled = append(assembled, body...)
	}
	s.objects[key] = assembled
	delete(s.parts, uploadID)

	w.Header().Set("Content-Type", "application/xml")
	_, _ = fmt.Fprintf(w, "<CompleteMultipartUploadResult><ETag>%s</ETag></CompleteMultipartUploadResult>", etagOf(assembled))
}

func (s *Server) abortMultipart(w http.ResponseWriter, uploadID string) {
	s.mu.Lock()
	delete(s.parts, uploadID)
	s.mu.Unlock()
	w.WriteHeader(http.StatusNoContent)
}

func first(query map[string][]string, name string) string {
	if values := query[name]; len(values) > 0 {
		return values[0]
	}
	return ""
}

func etagOf(body []byte) string {
	return fmt.Sprintf("%q", fmt.Sprintf("fake-%d", len(body)))
}
