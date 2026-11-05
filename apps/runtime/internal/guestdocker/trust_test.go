package guestdocker

import (
	"io/fs"
	"testing"
	"time"

	"github.com/Fanzzzd/erainfra/apps/runtime/internal/cacheca"
)

func mintCA(t *testing.T) []byte {
	t.Helper()
	authority, err := cacheca.Mint(time.Now(), time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	return authority.TrustAnchorPEM
}

// files is a container filesystem.
type files map[string][]byte

func (f files) read(path string) ([]byte, error) {
	if content, ok := f[path]; ok {
		return content, nil
	}
	return nil, fs.ErrNotExist
}

const builderCADir = "/etc/buildkit/certs/results-receiver.actions.githubusercontent.com"

func TestTrustsCAThroughEachVariable(t *testing.T) {
	ca := mintCA(t)
	publicBundle := mintCA(t) // stands in for an unrelated root
	bundle := append(append([]byte{}, publicBundle...), ca...)

	cases := map[string]struct {
		env   []string
		files files
	}{
		// The opt-in the docs give for a buildx builder: the builder's own
		// roots stay, and buildx's copy of the CA is added.
		"SSL_CERT_DIR naming the builder's CA directory": {
			env:   []string{"PATH=/usr/bin", "SSL_CERT_DIR=/etc/ssl/certs:" + builderCADir},
			files: files{builderCADir + "/" + CAFileName: ca},
		},
		"SSL_CERT_FILE naming a bundle that holds the CA among others": {
			env:   []string{"SSL_CERT_FILE=/etc/ssl/bundle.pem"},
			files: files{"/etc/ssl/bundle.pem": bundle},
		},
		// The opt-in the docs give for a container: job.
		"NODE_EXTRA_CA_CERTS naming the mounted CA": {
			env:   []string{"NODE_EXTRA_CA_CERTS=/etc/erainfra/" + CAFileName},
			files: files{"/etc/erainfra/" + CAFileName: ca},
		},
	}
	for name, c := range cases {
		if !TrustsCA(c.env, c.files.read, ca) {
			t.Errorf("%s: not judged trusting", name)
		}
	}
}

func TestTrustsCAErrsTowardNo(t *testing.T) {
	ca := mintCA(t)
	other := mintCA(t)
	cases := map[string]struct {
		env   []string
		files files
	}{
		"no variable at all":            {env: []string{"PATH=/usr/bin"}, files: files{builderCADir + "/" + CAFileName: ca}},
		"variable names a missing file": {env: []string{"SSL_CERT_FILE=/nope.pem"}},
		// A CA from another guest, or the previous boot of this one.
		"file holds a different CA": {
			env:   []string{"NODE_EXTRA_CA_CERTS=/ca.pem"},
			files: files{"/ca.pem": other},
		},
		"directory lacks the CA's basename": {
			env:   []string{"SSL_CERT_DIR=/certs"},
			files: files{"/certs/other.crt": ca},
		},
		"relative path": {
			env:   []string{"SSL_CERT_FILE=ca.pem"},
			files: files{"ca.pem": ca},
		},
		"empty value": {env: []string{"SSL_CERT_FILE="}},
		"garbage file": {
			env:   []string{"SSL_CERT_FILE=/ca.pem"},
			files: files{"/ca.pem": []byte("not a certificate")},
		},
	}
	for name, c := range cases {
		if TrustsCA(c.env, c.files.read, ca) {
			t.Errorf("%s: judged trusting", name)
		}
	}
	if TrustsCA([]string{"SSL_CERT_FILE=/ca.pem"}, files{"/ca.pem": ca}.read, nil) {
		t.Error("trusted with no CA to compare against")
	}
}
