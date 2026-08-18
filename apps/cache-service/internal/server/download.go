package server

import (
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/Fanzzzd/erainfra/apps/cache-service/internal/objectstore"
)

// serveDownload streams an entry's bytes through this service.
//
// It exists only for ERAINFRA_CACHE_DOWNLOAD_MODE=proxy. The default is a
// presigned store URL, because every download in the capture is a plain GET
// with no Range and no x-ms-range header (L006, L012, L030, L040, L073, L116)
// and a presigned S3 GET satisfies exactly that. The proxy is for the
// deployment where the store's endpoint is routable from this service and not
// from the jobs.
//
// It answers the whole object and ignores Range. The capture notes that all
// eight blob GETs in it carried no Range and no x-ms-range but that "larger or
// resumed transfers may range-request; that is unmeasured". Ignoring a Range
// header is legal — the client gets 200 and the whole body rather than 206 —
// so an unmeasured range request costs bandwidth here, not correctness. The
// presigned path, which is the default, supports ranges natively.
func (s *Server) serveDownload(w http.ResponseWriter, r *http.Request, rest string) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"message": "downloads are GET"})
		return
	}
	name, _, _ := strings.Cut(rest, "/")
	subject, ok := s.verifyName("download", name)
	if !ok {
		writeJSON(w, http.StatusForbidden, map[string]string{"message": "this download URL is not valid or has expired"})
		return
	}
	blob, err := hex.DecodeString(subject)
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]string{"message": "this download URL is not valid"})
		return
	}

	ctx, cancel := s.deadline(w, r, s.config.TransferTimeout)
	defer cancel()

	body, size, err := s.index.OpenBlob(ctx, string(blob))
	if err != nil {
		if errors.Is(err, objectstore.ErrNotFound) {
			writeJSON(w, http.StatusNotFound, map[string]string{"message": "no such cache entry"})
			return
		}
		s.logger.Error("proxied download failed", "error", err)
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"message": "cache store unavailable"})
		return
	}
	defer body.Close()

	w.Header().Set("Content-Type", "application/octet-stream")
	if size >= 0 {
		w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	}
	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodHead {
		return
	}
	if _, err := io.Copy(w, body); err != nil {
		s.logger.Warn("proxied download stopped early", "error", err)
	}
}
