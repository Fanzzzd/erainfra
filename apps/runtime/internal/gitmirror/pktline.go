package gitmirror

import (
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
)

// fetchRequest is what the mirror needs to know about a protocol v2 request
// before deciding to answer it locally: that it is a fetch, which objects it
// wants, and whether every argument in it is one the mirror reproduces
// exactly.
type fetchRequest struct {
	command string
	wants   []string
	// shallows are the client's own shallow commits ("shallow <oid>"). The
	// mirror's upload-pack can only compute the client's new boundary from
	// them if it holds each one.
	shallows []string
	// depth is the client's "deepen <n>", or 0 when it asked for whole
	// history (or limited it by date instead, which the mirror satisfies by
	// holding the whole history).
	depth int
	// includeTag is "include-tag": add every annotated tag that points at a
	// sent object. Which tags exist is GitHub's to say, so the mirror answers
	// it only after bringing its own tags in line with GitHub's.
	includeTag bool
	// unsupported is the first line the mirror does not reproduce exactly,
	// empty when there is none. A request with one goes to GitHub.
	unsupported string
}

// infiniteDepth is the "deepen" git sends for --unshallow and --depth with no
// limit: whole history.
const infiniteDepth = 1<<31 - 1

var errMalformedRequest = errors.New("gitmirror: malformed pkt-line request")

// parseRequest reads a protocol v2 request body (gitprotocol-v2(5)): a
// command, capabilities, a delimiter, arguments and a flush. It reads only as
// far as the flush, which is the whole of a stateless request.
//
// Every capability and argument is checked against what the mirror answers
// exactly as GitHub would. The list is an allowlist on purpose: a line git
// adds in some later version, or one this package never thought about, sends
// the request to GitHub rather than being answered without it.
func parseRequest(body []byte) (fetchRequest, error) {
	var request fetchRequest
	unsupported := func(line string) {
		if request.unsupported == "" {
			request.unsupported = line
		}
	}
	arguments := false // past the delim-pkt that ends the capabilities
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
		case 1: // delim-pkt: capabilities end, arguments begin
			arguments = true
			body = body[4:]
			continue
		case 2: // response-end-pkt
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
		if !arguments {
			switch {
			case strings.HasPrefix(line, "command="):
				request.command = strings.TrimPrefix(line, "command=")
			case strings.HasPrefix(line, "agent="), strings.HasPrefix(line, "session-id="):
				// Informational: neither changes what upload-pack sends.
			case line == "object-format=sha1":
				// The mirror is a SHA-1 repository, as every GitHub repository
				// is. Any other object format goes to GitHub.
			default:
				// server-option=, which GitHub may act on and the mirror would
				// ignore, and anything else.
				unsupported(line)
			}
			continue
		}
		name, value, _ := strings.Cut(line, " ")
		switch name {
		case "want":
			if !isObjectID(value) {
				return fetchRequest{}, errMalformedRequest
			}
			request.wants = append(request.wants, value)
		case "have":
			// Negotiation only. A have the mirror lacks costs a larger pack; one
			// GitHub lacks is an object the client already holds.
			if !isObjectID(value) {
				return fetchRequest{}, errMalformedRequest
			}
		case "shallow":
			if !isObjectID(value) {
				return fetchRequest{}, errMalformedRequest
			}
			request.shallows = append(request.shallows, value)
		case "deepen":
			depth, err := strconv.Atoi(value)
			if err != nil || depth < 1 {
				return fetchRequest{}, errMalformedRequest
			}
			request.depth = depth
		case "deepen-since":
			// Computed by upload-pack from commit dates over whole history,
			// which the mirror holds before it answers a request without a
			// depth.
			if _, err := strconv.ParseInt(value, 10, 64); err != nil {
				return fetchRequest{}, errMalformedRequest
			}
		case "done", "thin-pack", "no-progress", "ofs-delta":
			// How the pack is negotiated, encoded and reported. The mirror's
			// upload-pack implements each the way GitHub's does.
			if value != "" {
				unsupported(line)
			}
		case "include-tag":
			if value != "" {
				unsupported(line)
			}
			request.includeTag = true
		case "filter":
			if !exactFilter(value) {
				unsupported(line)
			}
		default:
			// Each of these depends on something only GitHub has:
			//   - want-ref: a ref's current value.
			//   - deepen-relative: depth counted from the client's own shallow
			//     boundary, which the mirror's fetch from GitHub does not share,
			//     so the mirror would answer with less history than asked for.
			//   - deepen-not: a ref name, resolved against GitHub's refs.
			//   - packfile-uris: offloaded packs GitHub may name.
			//   - sideband-all, wait-for-done: response framing the mirror's
			//     upload-pack does not advertise; wait-for-done is push
			//     negotiation, which gains nothing from the mirror anyway.
			// and anything not listed above.
			unsupported(line)
		}
	}
	return fetchRequest{}, errMalformedRequest
}

// exactFilter reports whether the mirror answers a partial clone's filter
// exactly as GitHub does: one GitHub documents accepting, which git applies
// from the wanted objects alone. Anything else (sparse:oid, which reads a
// blob, object:type, combine:, a filter GitHub may refuse) goes to GitHub so
// that GitHub decides.
func exactFilter(spec string) bool {
	switch {
	case spec == "blob:none", spec == "tree:0":
		return true
	case strings.HasPrefix(spec, "blob:limit="):
		limit := strings.TrimPrefix(spec, "blob:limit=")
		limit = strings.TrimRight(limit, "kmgKMG")
		_, err := strconv.ParseUint(limit, 10, 64)
		return err == nil
	}
	return false
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

// readPktLine reads one pkt-line and returns its payload without the newline.
func readPktLine(reader io.Reader) (string, error) {
	var header [4]byte
	if _, err := io.ReadFull(reader, header[:]); err != nil {
		return "", fmt.Errorf("read a pkt-line: %w", err)
	}
	length, err := strconv.ParseUint(string(header[:]), 16, 16)
	if err != nil {
		return "", fmt.Errorf("read a pkt-line: length %q", header[:])
	}
	if length < 4 {
		return "", fmt.Errorf("GitHub answered the special packet %04x", length)
	}
	payload := make([]byte, length-4)
	if _, err := io.ReadFull(reader, payload); err != nil {
		return "", fmt.Errorf("read a pkt-line: %w", err)
	}
	return strings.TrimSuffix(string(payload), "\n"), nil
}
