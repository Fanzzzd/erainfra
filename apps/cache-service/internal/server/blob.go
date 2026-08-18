package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/Fanzzzd/erainfra/apps/cache-service/internal/objectstore"
)

// The v2 upload path, translated.
//
// ADR 0007's "The v2 upload path is Azure-shaped" section gives stage B exactly
// two answers and picks neither. This is translate: signed_upload_url points
// back here, this service accepts the Azure Blob block protocol, and the blocks
// become S3 multipart parts. The alternative — an Azure-compatible gateway in
// front of the bucket — was not taken because it is a second piece of
// infrastructure an operator has to run, which cuts against the one
// endpoint/bucket/key/secret store contract the same ADR fixes.
//
// The mapping is not one block to one part. BuildKit stages 1 MiB blocks
// (capture L081-L084) and S3 refuses any part but the last under 5 MiB, so
// blocks are concatenated in block-list order and cut on the store's part
// boundary instead; see objectstore.Upload.

// defaultBlobVersion is the x-ms-version echoed when a client sends none. It is
// the value BuildKit's azsdk-go-azblob/v1.5.0 sent in the capture.
const defaultBlobVersion = "2024-11-04"

func (s *Server) serveBlob(w http.ResponseWriter, r *http.Request, rest string) {
	name, _, _ := strings.Cut(rest, "/")
	name, _, _ = strings.Cut(name, ".")
	id, ok := s.verifyName("upload", name)
	if !ok {
		s.writeBlobError(w, r, http.StatusForbidden, "AuthenticationFailed",
			"this upload URL is not valid or has expired")
		return
	}
	s.mu.Lock()
	held := s.sessions[id]
	s.mu.Unlock()
	if held == nil {
		s.writeBlobError(w, r, http.StatusNotFound, "BlobNotFound", "no such upload")
		return
	}
	if r.Method != http.MethodPut {
		s.writeBlobError(w, r, http.StatusMethodNotAllowed, "UnsupportedHttpVerb",
			"an upload URL accepts PUT")
		return
	}

	s.readBodyDeadline(w)
	ctx, cancel := s.deadline(w, r, s.config.TransferTimeout)
	defer cancel()

	query := r.URL.Query()
	switch query.Get("comp") {
	case "":
		// Put Blob: the whole entry in one request. Small entries take this
		// path — capture L098 uploads 116 bytes and L113 uploads 2305.
		s.putWholeBlob(ctx, w, r, held)
	case "block":
		s.stageBlock(w, r, held, query.Get("blockid"))
	case "blocklist":
		s.commitBlockList(ctx, w, r, held)
	default:
		s.writeBlobError(w, r, http.StatusBadRequest, "UnsupportedQueryParameter",
			"unsupported comp="+query.Get("comp"))
	}
}

func (s *Server) putWholeBlob(ctx context.Context, w http.ResponseWriter, r *http.Request, held *session) {
	blob, upload, err := s.index.NewBlob(ctx, held.repository)
	if err != nil {
		s.logger.Error("blob upload could not start", "error", err)
		s.writeBlobError(w, r, http.StatusServiceUnavailable, "ServerBusy", "cache store unavailable")
		return
	}

	size := r.ContentLength
	if size > s.config.MaxEntryBytes {
		_ = upload.Abort(ctx)
		s.writeBlobError(w, r, http.StatusRequestEntityTooLarge, "RequestBodyTooLarge",
			ErrEntryTooLarge.Error())
		return
	}
	if size < 0 {
		// No Content-Length. Every Azure client in the capture sends one, so
		// this is the unmeasured shape: spool it rather than guess a length the
		// store's part accounting depends on.
		path := filepath.Join(held.dir, "whole")
		spooled, err := writeSpoolFile(path, r.Body, s.config.MaxEntryBytes)
		if err != nil {
			_ = upload.Abort(ctx)
			s.blobWriteFailed(w, r, err)
			return
		}
		file, err := os.Open(path)
		if err != nil {
			_ = upload.Abort(ctx)
			s.blobWriteFailed(w, r, err)
			return
		}
		defer file.Close()
		if err := s.streamParts(ctx, upload, file, spooled); err != nil {
			_ = upload.Abort(ctx)
			s.blobWriteFailed(w, r, err)
			return
		}
		size = spooled
	} else if err := s.streamBody(ctx, upload, r.Body, size); err != nil {
		_ = upload.Abort(ctx)
		s.blobWriteFailed(w, r, err)
		return
	}
	if err := upload.Complete(ctx); err != nil {
		_ = upload.Abort(ctx)
		s.blobWriteFailed(w, r, err)
		return
	}

	held.commit(blob, size)
	held.clearBlocks()
	s.writeBlobCommitted(w, r, size)
}

func (s *Server) stageBlock(w http.ResponseWriter, r *http.Request, held *session, blockID string) {
	if strings.TrimSpace(blockID) == "" {
		s.writeBlobError(w, r, http.StatusBadRequest, "InvalidQueryParameterValue",
			"comp=block needs a blockid")
		return
	}
	// The block id is client-chosen base64 (capture L033: a 64-character
	// base64 block id), so it never becomes a path element as sent.
	path := filepath.Join(held.dir, "blk-"+hex.EncodeToString([]byte(blockID)))
	remaining := held.limit - held.stagedBytes()
	if remaining <= 0 {
		s.writeBlobError(w, r, http.StatusRequestEntityTooLarge, "RequestBodyTooLarge",
			ErrEntryTooLarge.Error())
		return
	}

	size, err := writeSpoolFile(path, r.Body, remaining)
	if err != nil {
		s.blobWriteFailed(w, r, err)
		return
	}
	held.stage(blockID, path, size)
	s.writeBlobAccepted(w, r)
}

// blockList is the XML body of a comp=blocklist commit (capture L037, L085).
// Order matters and the element name does not: Azure lets a client say Latest,
// Uncommitted or Committed, and this service only ever holds uncommitted
// blocks, so all three name the same staged bytes.
type blockList struct {
	XMLName xml.Name   `xml:"BlockList"`
	Blocks  []blockRef `xml:",any"`
}

type blockRef struct {
	XMLName xml.Name
	ID      string `xml:",chardata"`
}

func (s *Server) commitBlockList(ctx context.Context, w http.ResponseWriter, r *http.Request, held *session) {
	var list blockList
	if err := xml.NewDecoder(io.LimitReader(r.Body, maxRequestJSON)).Decode(&list); err != nil {
		s.writeBlobError(w, r, http.StatusBadRequest, "InvalidXmlDocument", "malformed block list")
		return
	}

	blocks := make([]stagedBlock, 0, len(list.Blocks))
	var total int64
	for _, ref := range list.Blocks {
		switch ref.XMLName.Local {
		case "Latest", "Uncommitted", "Committed":
		default:
			s.writeBlobError(w, r, http.StatusBadRequest, "InvalidXmlDocument",
				"unexpected element "+ref.XMLName.Local+" in the block list")
			return
		}
		block, ok := held.block(strings.TrimSpace(ref.ID))
		if !ok {
			s.writeBlobError(w, r, http.StatusBadRequest, "InvalidBlockList",
				"the block list names a block that was never staged")
			return
		}
		blocks = append(blocks, block)
		total += block.size
	}
	if len(blocks) == 0 {
		s.writeBlobError(w, r, http.StatusBadRequest, "InvalidBlockList", "the block list is empty")
		return
	}

	blob, upload, err := s.index.NewBlob(ctx, held.repository)
	if err != nil {
		s.logger.Error("blob commit could not start", "error", err)
		s.writeBlobError(w, r, http.StatusServiceUnavailable, "ServerBusy", "cache store unavailable")
		return
	}
	// Blocks go to the store in block-list order. objectstore.Upload decides
	// where a part ends, which is what keeps a 1 MiB block legal.
	//
	// The readers are lazy because AddPart buffers them until a part is full: a
	// 200 MiB entry made of BuildKit's 1 MiB blocks is 200 of them, and opening
	// all 200 up front would spend the process's file descriptors on files that
	// will be read one at a time.
	readers := make([]*blockReader, 0, len(blocks))
	defer func() {
		for _, reader := range readers {
			reader.close()
		}
	}()
	for _, block := range blocks {
		reader := &blockReader{path: block.path, remaining: block.size}
		readers = append(readers, reader)
		if err := upload.AddPart(ctx, reader, block.size); err != nil {
			_ = upload.Abort(ctx)
			s.blobWriteFailed(w, r, err)
			return
		}
	}
	if err := upload.Complete(ctx); err != nil {
		_ = upload.Abort(ctx)
		s.blobWriteFailed(w, r, err)
		return
	}

	held.commit(blob, total)
	held.clearBlocks()
	s.writeBlobCommitted(w, r, total)
}

// streamParts feeds a spool file to the store in part-sized slices so the
// multipart accounting is the store's rather than the client's.
func (s *Server) streamParts(ctx context.Context, upload objectstore.Upload, spool *os.File, size int64) error {
	part := s.config.Store.PartBytes
	if part <= 0 {
		part = 32 << 20
	}
	for offset := int64(0); offset < size; offset += part {
		length := part
		if remaining := size - offset; remaining < length {
			length = remaining
		}
		if err := upload.AddPart(ctx, io.NewSectionReader(spool, offset, length), length); err != nil {
			return err
		}
	}
	return nil
}

// blockReader streams one staged block, opening the file on the first read and
// closing it on the last, so that io.MultiReader over a whole block list holds
// exactly one descriptor at a time.
type blockReader struct {
	path      string
	file      *os.File
	remaining int64
}

func (b *blockReader) Read(buffer []byte) (int, error) {
	if b.remaining <= 0 {
		b.close()
		return 0, io.EOF
	}
	if b.file == nil {
		file, err := os.Open(b.path)
		if err != nil {
			return 0, err
		}
		b.file = file
	}
	if int64(len(buffer)) > b.remaining {
		buffer = buffer[:b.remaining]
	}
	read, err := b.file.Read(buffer)
	b.remaining -= int64(read)
	if err != nil || b.remaining <= 0 {
		b.close()
	}
	return read, err
}

func (b *blockReader) close() {
	if b.file != nil {
		_ = b.file.Close()
		b.file = nil
	}
}

func writeSpoolFile(path string, body io.Reader, limit int64) (int64, error) {
	file, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return 0, err
	}
	defer file.Close()
	written, err := io.Copy(file, io.LimitReader(body, limit+1))
	if err != nil {
		return written, err
	}
	if written > limit {
		return written, ErrEntryTooLarge
	}
	return written, file.Sync()
}

func (s *Server) blobWriteFailed(w http.ResponseWriter, r *http.Request, cause error) {
	s.logger.Error("blob upload failed", "error", cause)
	s.writeBlobError(w, r, http.StatusServiceUnavailable, "ServerBusy", "cache store unavailable")
}

// blobHeaders sets what every response on this path carries.
//
// x-ms-request-id is the one that is not optional, and the reason is a
// nil-pointer dereference in a client nobody here controls: BuildKit's
// go-actions-cache logs *resp.RequestID from the commit response without a nil
// check, so a commit that omits the header panics buildkitd after every byte
// has already been uploaded and fails the build with a message that names
// nothing about the cache (capture, "The BuildKit panic"). It is set on every
// response rather than only on the commit so that no future refactor can move
// the commit onto a path that forgets it.
func (s *Server) blobHeaders(w http.ResponseWriter, r *http.Request) {
	version := r.Header.Get("x-ms-version")
	if version == "" {
		version = defaultBlobVersion
	}
	w.Header().Set("x-ms-request-id", requestID())
	w.Header().Set("x-ms-version", version)
	w.Header().Set("Date", s.now().UTC().Format(http.TimeFormat))
}

func (s *Server) writeBlobAccepted(w http.ResponseWriter, r *http.Request) {
	s.blobHeaders(w, r)
	w.Header().Set("Content-Length", "0")
	w.WriteHeader(http.StatusCreated)
}

// streamBody hands a known-length request body to the store in part-sized
// slices. It reads sequentially, so consecutive limited readers over the same
// body are consecutive slices of it. Slicing rather than handing over the whole
// body in one call is what keeps a multi-gigabyte entry inside the store's
// per-part ceiling.
func (s *Server) streamBody(ctx context.Context, upload objectstore.Upload, body io.Reader, size int64) error {
	part := s.config.Store.PartBytes
	if part <= 0 {
		part = 32 << 20
	}
	for remaining := size; remaining > 0; {
		length := part
		if remaining < length {
			length = remaining
		}
		if err := upload.AddPart(ctx, io.LimitReader(body, length), length); err != nil {
			return err
		}
		remaining -= length
	}
	return nil
}

func (s *Server) writeBlobCommitted(w http.ResponseWriter, r *http.Request, size int64) {
	s.blobHeaders(w, r)
	// ETag and Last-Modified are what an Azure client expects from a commit.
	// The capture's first, crashing run returned a 201 with an ETag and no
	// x-ms-request-id, so it proves the ETag is not sufficient; it does not
	// establish that the ETag is necessary, and it is cheap to keep.
	w.Header().Set("ETag", fmt.Sprintf("%q", requestID()))
	w.Header().Set("Last-Modified", s.now().UTC().Format(http.TimeFormat))
	w.Header().Set("Content-Length", "0")
	w.WriteHeader(http.StatusCreated)
}

func (s *Server) writeBlobError(w http.ResponseWriter, r *http.Request, status int, code, message string) {
	s.blobHeaders(w, r)
	w.Header().Set("x-ms-error-code", code)
	w.Header().Set("Content-Type", "application/xml")
	w.WriteHeader(status)
	_, _ = fmt.Fprintf(w, "<?xml version=\"1.0\" encoding=\"utf-8\"?><Error><Code>%s</Code><Message>%s</Message></Error>",
		code, message)
}

// requestID is a UUID-shaped identifier. Azure's is a UUID and the client only
// ever prints it, so what matters is that it is present and unique.
func requestID() string {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return fmt.Sprintf("%016x-0000-4000-8000-000000000000", time.Now().UnixNano())
	}
	raw[6] = (raw[6] & 0x0f) | 0x40
	raw[8] = (raw[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", raw[0:4], raw[4:6], raw[6:8], raw[8:10], raw[10:16])
}
