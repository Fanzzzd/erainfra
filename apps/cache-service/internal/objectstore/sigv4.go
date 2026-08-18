package objectstore

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Signature Version 4, the request-signing scheme every S3-compatible store
// speaks. It is implemented here rather than pulled in from a vendor SDK for
// two reasons: ADR 0007's store contract is one endpoint/bucket/key/secret and
// no vendor name, and every S3 call this service makes has to be bounded by a
// deadline we control (the dangerous outage shape is accept-and-never-answer).
// A signer of this size is cheaper to keep honest than an SDK's retry and
// timeout defaults are to audit.

const (
	algorithm       = "AWS4-HMAC-SHA256"
	service         = "s3"
	unsignedPayload = "UNSIGNED-PAYLOAD"
	// emptyPayloadHash is sha256 of zero bytes, which is what a GET, HEAD or
	// DELETE hashes to.
	emptyPayloadHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
	isoLayout        = "20060102T150405Z"
	dateLayout       = "20060102"
)

type credentials struct {
	accessKey string
	secret    string
	region    string
}

// signRequest signs req in place with the header form of SigV4. payloadHash is
// either a hex sha256 of the body or unsignedPayload; a streaming body of known
// length cannot be hashed without buffering it, and over TLS the transport
// already covers integrity, so uploads pass unsignedPayload.
func signRequest(req *http.Request, creds credentials, payloadHash string, now time.Time) {
	now = now.UTC()
	amzDate := now.Format(isoLayout)
	scope := now.Format(dateLayout) + "/" + creds.region + "/" + service + "/aws4_request"

	req.Header.Set("X-Amz-Date", amzDate)
	req.Header.Set("X-Amz-Content-Sha256", payloadHash)
	if req.Host == "" {
		req.Host = req.URL.Host
	}

	signedHeaders, canonicalHeaders := canonicalHeaders(req)
	canonical := strings.Join([]string{
		req.Method,
		canonicalURI(req.URL),
		canonicalQuery(req.URL.Query()),
		canonicalHeaders,
		signedHeaders,
		payloadHash,
	}, "\n")

	signature := hex.EncodeToString(hmacSHA256(signingKey(creds, now), stringToSign(amzDate, scope, canonical)))
	req.Header.Set("Authorization", algorithm+
		" Credential="+creds.accessKey+"/"+scope+
		", SignedHeaders="+signedHeaders+
		", Signature="+signature)
}

// presignGet returns a URL that carries its own credential in the query string
// and expires. ADR 0007 rule 4 constrains what may be handed to a job: one
// object, one method, short-lived. All three are properties of this function —
// the method is baked into the signature, the object is the path, and
// X-Amz-Expires is the lifetime.
func presignGet(target *url.URL, creds credentials, ttl time.Duration, now time.Time) string {
	now = now.UTC()
	amzDate := now.Format(isoLayout)
	scope := now.Format(dateLayout) + "/" + creds.region + "/" + service + "/aws4_request"

	query := target.Query()
	query.Set("X-Amz-Algorithm", algorithm)
	query.Set("X-Amz-Credential", creds.accessKey+"/"+scope)
	query.Set("X-Amz-Date", amzDate)
	query.Set("X-Amz-Expires", strconv.Itoa(int(ttl.Seconds())))
	query.Set("X-Amz-SignedHeaders", "host")

	canonical := strings.Join([]string{
		http.MethodGet,
		canonicalURI(target),
		canonicalQuery(query),
		"host:" + target.Host + "\n",
		"host",
		unsignedPayload,
	}, "\n")

	query.Set("X-Amz-Signature", hex.EncodeToString(
		hmacSHA256(signingKey(creds, now), stringToSign(amzDate, scope, canonical))))

	signed := *target
	signed.RawQuery = canonicalQuery(query)
	return signed.String()
}

func stringToSign(amzDate, scope, canonical string) string {
	sum := sha256.Sum256([]byte(canonical))
	return strings.Join([]string{algorithm, amzDate, scope, hex.EncodeToString(sum[:])}, "\n")
}

func signingKey(creds credentials, now time.Time) []byte {
	key := hmacSHA256([]byte("AWS4"+creds.secret), now.UTC().Format(dateLayout))
	key = hmacSHA256(key, creds.region)
	key = hmacSHA256(key, service)
	return hmacSHA256(key, "aws4_request")
}

func hmacSHA256(key []byte, data string) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(data))
	return mac.Sum(nil)
}

// signedHeaderNames is what gets covered beyond the x-amz-* family. Host is
// mandatory; the other two are signed when present so that a store which
// enforces them sees them covered. Nothing else is: Go's transport adds
// Accept-Encoding and a proxy may add more, and a signature that covers headers
// we do not control breaks in transit rather than at the door.
var signedHeaderNames = map[string]bool{"host": true, "content-type": true, "range": true}

// canonicalHeaders returns the signed-header list and the canonical header
// block.
func canonicalHeaders(req *http.Request) (string, string) {
	names := []string{"host"}
	values := map[string]string{"host": req.Host}
	for name, header := range req.Header {
		lower := strings.ToLower(name)
		if !strings.HasPrefix(lower, "x-amz-") && !signedHeaderNames[lower] {
			continue
		}
		if lower == "host" {
			continue
		}
		names = append(names, lower)
		values[lower] = strings.Join(trimAll(header), ",")
	}
	sort.Strings(names)

	var block strings.Builder
	for _, name := range names {
		block.WriteString(name)
		block.WriteString(":")
		block.WriteString(values[name])
		block.WriteString("\n")
	}
	return strings.Join(names, ";"), block.String()
}

func trimAll(values []string) []string {
	trimmed := make([]string, len(values))
	for i, value := range values {
		trimmed[i] = strings.TrimSpace(value)
	}
	return trimmed
}

// canonicalURI encodes each path segment per RFC 3986 and keeps the separators.
// S3 signs the path exactly once, unlike most other AWS services.
func canonicalURI(target *url.URL) string {
	path := target.EscapedPath()
	if path == "" {
		return "/"
	}
	segments := strings.Split(path, "/")
	for i, segment := range segments {
		decoded, err := url.PathUnescape(segment)
		if err != nil {
			decoded = segment
		}
		segments[i] = uriEncode(decoded, false)
	}
	return strings.Join(segments, "/")
}

func canonicalQuery(query url.Values) string {
	keys := make([]string, 0, len(query))
	for key := range query {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	pairs := make([]string, 0, len(keys))
	for _, key := range keys {
		values := append([]string(nil), query[key]...)
		sort.Strings(values)
		for _, value := range values {
			pairs = append(pairs, uriEncode(key, true)+"="+uriEncode(value, true))
		}
	}
	return strings.Join(pairs, "&")
}

// uriEncode is AWS's own percent-encoding rule: unreserved characters pass
// through, everything else is encoded, and "/" is encoded only outside a path.
// Go's url.QueryEscape is not a substitute — it encodes a space as "+", which
// the signature would then disagree with.
func uriEncode(value string, encodeSlash bool) string {
	var out strings.Builder
	for i := 0; i < len(value); i++ {
		c := value[i]
		switch {
		case (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
			c == '-' || c == '_' || c == '.' || c == '~':
			out.WriteByte(c)
		case c == '/' && !encodeSlash:
			out.WriteByte(c)
		default:
			out.WriteString("%")
			out.WriteString(strings.ToUpper(hex.EncodeToString([]byte{c})))
		}
	}
	return out.String()
}
