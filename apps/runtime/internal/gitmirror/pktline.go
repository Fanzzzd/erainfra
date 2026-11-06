package gitmirror

import (
	"errors"
	"strconv"
	"strings"
)

// fetchRequest is what the mirror needs to know about a protocol v2 request
// before deciding to answer it locally: that it is a fetch, and which objects
// it wants.
type fetchRequest struct {
	command string
	wants   []string
	// wantRefs is set when the client names a ref instead of an object. The
	// mirror answers only object wants: a ref's value is GitHub's to say.
	wantRefs bool
	// depth is the client's "deepen <n>", or 0 when it asked for whole
	// history (or limited it by date or ref instead, which the mirror
	// satisfies by holding the whole history).
	depth int
}

var errMalformedRequest = errors.New("gitmirror: malformed pkt-line request")

// parseRequest reads a protocol v2 request body (gitprotocol-v2(5)): a
// command, capabilities, a delimiter, arguments and a flush. It reads only as
// far as the flush, which is the whole of a stateless request.
func parseRequest(body []byte) (fetchRequest, error) {
	var request fetchRequest
	for len(body) > 0 {
		if len(body) < 4 {
			return fetchRequest{}, errMalformedRequest
		}
		length, err := strconv.ParseUint(string(body[:4]), 16, 16)
		if err != nil {
			return fetchRequest{}, errMalformedRequest
		}
		switch length {
		case 0: // flush-pkt ends the request
			return request, nil
		case 1, 2: // delim-pkt and response-end-pkt
			body = body[4:]
			continue
		case 3:
			return fetchRequest{}, errMalformedRequest
		}
		if int(length) > len(body) {
			return fetchRequest{}, errMalformedRequest
		}
		line := strings.TrimSuffix(string(body[4:length]), "\n")
		body = body[length:]
		switch {
		case strings.HasPrefix(line, "command="):
			request.command = strings.TrimPrefix(line, "command=")
		case strings.HasPrefix(line, "deepen "):
			depth, err := strconv.Atoi(strings.TrimPrefix(line, "deepen "))
			if err != nil || depth < 1 {
				return fetchRequest{}, errMalformedRequest
			}
			request.depth = depth
		case strings.HasPrefix(line, "want-ref "):
			request.wantRefs = true
		case strings.HasPrefix(line, "want "):
			oid := strings.TrimPrefix(line, "want ")
			if !isObjectID(oid) {
				return fetchRequest{}, errMalformedRequest
			}
			request.wants = append(request.wants, oid)
		}
	}
	return fetchRequest{}, errMalformedRequest
}

// isObjectID accepts a full SHA-1 or SHA-256 object name in lower-case hex,
// which is the only form git puts on a want line. Anything else is not passed
// to a git command line.
func isObjectID(value string) bool {
	if len(value) != 40 && len(value) != 64 {
		return false
	}
	for _, r := range value {
		if (r < '0' || r > '9') && (r < 'a' || r > 'f') {
			return false
		}
	}
	return true
}
