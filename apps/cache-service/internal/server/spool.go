package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"sync"
	"time"
)

// flexInt64 accepts a JSON number or a JSON string holding one.
//
// This is not defensiveness for its own sake: `size_bytes` on
// FinalizeCacheEntryUpload arrives as a string from @actions/cache (capture
// L038: "size_bytes":"204101795") and as a number from BuildKit (capture L086:
// "size_bytes":4092319). A service that picks one fails half its clients on the
// last call of a completed upload.
type flexInt64 int64

func (value *flexInt64) UnmarshalJSON(body []byte) error {
	var number int64
	if err := json.Unmarshal(body, &number); err == nil {
		*value = flexInt64(number)
		return nil
	}
	var text string
	if err := json.Unmarshal(body, &text); err != nil {
		return fmt.Errorf("expected a number or a numeric string, got %s", body)
	}
	if text == "" {
		*value = 0
		return nil
	}
	parsed, err := strconv.ParseInt(text, 10, 64)
	if err != nil {
		return fmt.Errorf("expected a numeric string, got %q", text)
	}
	*value = flexInt64(parsed)
	return nil
}

// ErrEntryTooLarge is returned when a client sends more than the configured
// per-entry ceiling.
var ErrEntryTooLarge = errors.New("cache entry exceeds ERAINFRA_CACHE_MAX_ENTRY_BYTES")

// reservation is a v1 upload between POST /caches and its commit.
//
// The bytes are spooled to a file rather than streamed straight into the store
// because a v1 upload is not a stream: @actions/cache sends 32 MiB chunks, up
// to four at a time and out of order — capture L021-L027 delivers the final
// 2,521,508-byte chunk fifth of seven — and each chunk names its own byte range.
// A file gives random access, which is exactly the shape of the traffic.
type reservation struct {
	id         int64
	repository string
	ref        string
	key        string
	version    string
	path       string
	limit      int64
	expires    time.Time

	mu      sync.Mutex
	file    *os.File
	written int64
}

func newReservation(id int64, path string, limit int64, expires time.Time) (*reservation, error) {
	file, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return nil, err
	}
	return &reservation{id: id, path: path, limit: limit, expires: expires, file: file}, nil
}

// writeAt lands one chunk. It returns how many bytes arrived so the caller can
// check the chunk against its own Content-Range.
func (r *reservation) writeAt(body io.Reader, offset int64) (int64, error) {
	r.mu.Lock()
	file := r.file
	r.mu.Unlock()
	if file == nil {
		return 0, errors.New("this cache reservation is closed")
	}
	if offset < 0 || offset > r.limit {
		return 0, ErrEntryTooLarge
	}

	// One extra byte past the ceiling is read on purpose: it is the difference
	// between "exactly at the limit" and "over it", and without it a client
	// sending exactly limit+1 bytes would be silently truncated to a corrupt
	// entry rather than refused.
	written, err := io.Copy(&fileOffsetWriter{file: file, offset: offset},
		io.LimitReader(body, r.limit-offset+1))
	if err != nil {
		return written, err
	}
	if offset+written > r.limit {
		return written, ErrEntryTooLarge
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	if end := offset + written; end > r.written {
		r.written = end
	}
	return written, nil
}

func (r *reservation) size() int64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.written
}

// open rewinds the spool for reading. The caller must not write to the
// reservation afterwards.
func (r *reservation) open() (*os.File, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.file == nil {
		return nil, errors.New("this cache reservation is closed")
	}
	if _, err := r.file.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	return r.file, nil
}

func (r *reservation) discard() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.file != nil {
		_ = r.file.Close()
		r.file = nil
	}
	_ = os.Remove(r.path)
}

// fileOffsetWriter turns a WriteAt into a sequential Writer so io.Copy can
// stream a chunk straight from the request body into the middle of the spool.
// Concurrent chunks are safe because they never overlap: each carries its own
// Content-Range.
type fileOffsetWriter struct {
	file   *os.File
	offset int64
}

func (w *fileOffsetWriter) Write(chunk []byte) (int, error) {
	written, err := w.file.WriteAt(chunk, w.offset)
	w.offset += int64(written)
	return written, err
}

// stagedBlock is one Azure block waiting for the block list that will order it.
type stagedBlock struct {
	path string
	size int64
}

// session is a v2 upload between CreateCacheEntry and FinalizeCacheEntryUpload.
//
// Blocks have to be spooled rather than forwarded: the Azure protocol stages
// blocks in whatever order the client likes and only names the order in the
// blocklist commit (capture L081-L085), so the first byte of the finished
// object is not known until the last request.
type session struct {
	id         string
	repository string
	ref        string
	key        string
	version    string
	dir        string
	limit      int64
	expires    time.Time

	mu        sync.Mutex
	blocks    map[string]stagedBlock
	staged    int64
	blob      string
	size      int64
	committed bool
}

func newSession(id, dir string, limit int64, expires time.Time) (*session, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	return &session{id: id, dir: dir, limit: limit, expires: expires,
		blocks: map[string]stagedBlock{}}, nil
}

func (s *session) stage(id string, path string, size int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if previous, ok := s.blocks[id]; ok {
		// Azure lets a client re-stage a block id. The earlier bytes are dead
		// the moment the new ones land.
		s.staged -= previous.size
		_ = os.Remove(previous.path)
	}
	s.blocks[id] = stagedBlock{path: path, size: size}
	s.staged += size
}

func (s *session) block(id string) (stagedBlock, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	block, ok := s.blocks[id]
	return block, ok
}

func (s *session) stagedBytes() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.staged
}

func (s *session) commit(blob string, size int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.blob, s.size, s.committed = blob, size, true
}

func (s *session) state() (blob string, size int64, committed bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.blob, s.size, s.committed
}

func (s *session) discard() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.blocks = map[string]stagedBlock{}
	_ = os.RemoveAll(s.dir)
}

// clearBlocks drops the staged block files once their bytes are in the store.
// The session itself stays: FinalizeCacheEntryUpload still has to arrive.
func (s *session) clearBlocks() {
	s.mu.Lock()
	blocks := s.blocks
	s.blocks = map[string]stagedBlock{}
	s.staged = 0
	s.mu.Unlock()
	for _, block := range blocks {
		_ = os.Remove(block.path)
	}
}
