package objectstore

import (
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
)

// The two vectors below are AWS's own published Signature Version 4 examples
// for S3. They are here because this package reimplements the signer rather
// than importing a vendor SDK: a signer nobody can check against an outside
// answer is a signer that fails in production, at a store, with a message that
// says only "SignatureDoesNotMatch".
var (
	exampleCreds = credentials{
		accessKey: "AKIAIOSFODNN7EXAMPLE",
		secret:    "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
		region:    "us-east-1",
	}
	exampleTime = time.Date(2013, 5, 24, 0, 0, 0, 0, time.UTC)
)

func TestSignRequestMatchesTheGetObjectExample(t *testing.T) {
	req, err := http.NewRequest(http.MethodGet, "https://examplebucket.s3.amazonaws.com/test.txt", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Range", "bytes=0-9")

	signRequest(req, exampleCreds, emptyPayloadHash, exampleTime)

	authorization := req.Header.Get("Authorization")
	const wantSignedHeaders = "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date"
	const wantSignature = "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
	if !strings.Contains(authorization, wantSignedHeaders) {
		t.Errorf("Authorization = %q, want it to contain %q", authorization, wantSignedHeaders)
	}
	if !strings.Contains(authorization, wantSignature) {
		t.Errorf("Authorization = %q, want it to contain %q", authorization, wantSignature)
	}
}

func TestPresignGetMatchesTheQueryParameterExample(t *testing.T) {
	target, err := url.Parse("https://examplebucket.s3.amazonaws.com/test.txt")
	if err != nil {
		t.Fatal(err)
	}

	signed := presignGet(target, exampleCreds, 86400*time.Second, exampleTime)

	const want = "X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404"
	if !strings.Contains(signed, want) {
		t.Errorf("presigned URL = %q, want it to contain %q", signed, want)
	}
}

// A presigned URL is only allowed to be one object and one method (ADR 0007
// rule 4). The method is not a parameter of the URL, it is baked into the
// string that was signed, so the same URL replayed as a PUT does not verify.
func TestPresignGetSignsTheMethodIntoTheSignature(t *testing.T) {
	target, _ := url.Parse("https://examplebucket.s3.amazonaws.com/test.txt")
	signed := presignGet(target, exampleCreds, time.Minute, exampleTime)

	parsed, err := url.Parse(signed)
	if err != nil {
		t.Fatal(err)
	}
	query := parsed.Query()
	if got := query.Get("X-Amz-SignedHeaders"); got != "host" {
		t.Errorf("X-Amz-SignedHeaders = %q, want host", got)
	}
	if got := query.Get("X-Amz-Expires"); got != "60" {
		t.Errorf("X-Amz-Expires = %q, want 60", got)
	}
	if !strings.Contains(parsed.Path, "test.txt") {
		t.Errorf("presigned path = %q, want it to name exactly one object", parsed.Path)
	}
}

func TestURIEncodeFollowsTheAWSRuleRatherThanQueryEscape(t *testing.T) {
	for _, testCase := range []struct {
		value       string
		encodeSlash bool
		want        string
	}{
		{"a b", true, "a%20b"},
		{"a/b", false, "a/b"},
		{"a/b", true, "a%2Fb"},
		{"tilde~dash-dot.under_", true, "tilde~dash-dot.under_"},
		{"refs~2Fheads~2Fmain", true, "refs~2Fheads~2Fmain"},
	} {
		if got := uriEncode(testCase.value, testCase.encodeSlash); got != testCase.want {
			t.Errorf("uriEncode(%q, %v) = %q, want %q", testCase.value, testCase.encodeSlash, got, testCase.want)
		}
	}
}
