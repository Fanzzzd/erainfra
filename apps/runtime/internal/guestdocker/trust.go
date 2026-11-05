package guestdocker

import (
	"bytes"
	"encoding/pem"
	"path"
	"strings"
)

// CAFileName is the basename of the interceptor's CA wherever it is copied:
// on the guest under /usr/local/share/ca-certificates, and inside a buildx
// builder under /etc/buildkit/certs/<cache host>/, where buildx keeps the
// basename of every registry CA it copies.
const CAFileName = "erainfra-cache.crt"

// TrustsCA reports whether a container's environment points a TLS stack at a
// file, readable inside the container, that holds the interceptor's CA.
//
// It is the gate for pinning the cache host inside a container, and it errs
// toward no: a container judged untrusting keeps reaching GitHub directly,
// which is always safe, while a container wrongly judged trusting would fail
// TLS on every cache and artifact call. Three variables count, because they
// are how the three client stacks that reach the cache host take an extra CA:
//
//   - SSL_CERT_FILE: OpenSSL and Go read the named bundle.
//   - SSL_CERT_DIR: OpenSSL and Go read every listed directory, colon
//     separated; the CA is looked for under its own basename in each.
//   - NODE_EXTRA_CA_CERTS: Node adds the named file to its bundled roots.
//
// A variable naming a relative path is ignored: it resolves against a working
// directory the guest cannot know.
func TrustsCA(env []string, readFile func(path string) ([]byte, error), caPEM []byte) bool {
	want := certificatesIn(caPEM)
	if len(want) != 1 {
		return false
	}
	for _, candidate := range candidatePaths(env) {
		content, err := readFile(candidate)
		if err != nil {
			continue
		}
		for _, der := range certificatesIn(content) {
			if bytes.Equal(der, want[0]) {
				return true
			}
		}
	}
	return false
}

func candidatePaths(env []string) []string {
	var paths []string
	add := func(p string) {
		if path.IsAbs(p) {
			paths = append(paths, path.Clean(p))
		}
	}
	for _, entry := range env {
		name, value, ok := strings.Cut(entry, "=")
		if !ok || value == "" {
			continue
		}
		switch name {
		case "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS":
			add(value)
		case "SSL_CERT_DIR":
			for _, dir := range strings.Split(value, ":") {
				if dir != "" {
					add(path.Join(dir, CAFileName))
				}
			}
		}
	}
	return paths
}

func certificatesIn(content []byte) [][]byte {
	var ders [][]byte
	for {
		var block *pem.Block
		block, content = pem.Decode(content)
		if block == nil {
			return ders
		}
		if block.Type == "CERTIFICATE" {
			ders = append(ders, block.Bytes)
		}
	}
}
