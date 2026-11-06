package gitmirror

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Fanzzzd/erainfra/apps/runtime/internal/cacheca"
)

// The CA directory's file name is OpenSSL's own subject hash, or OpenSSL-based
// git builds would not find the CA in it.
func TestCAPathNameIsOpenSSLsSubjectHash(t *testing.T) {
	openssl, err := exec.LookPath("openssl")
	if err != nil {
		t.Skip("openssl is not installed")
	}
	minted, err := cacheca.MintFor(GitHubHost, time.Now(), time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	cases := map[string][]byte{"the minted CA": minted.TrustAnchorPEM}
	for name, subject := range map[string]pkix.Name{
		"case and spacing":   {CommonName: "  EraInfra   In-Guest\tCA  "},
		"several components": {Country: []string{"SG"}, Organization: []string{"Era Infra"}, CommonName: "Guest CA"},
		"UTF-8 value":        {CommonName: "Ëra CA"},
	} {
		cases[name] = selfSigned(t, subject)
	}
	for name, caPEM := range cases {
		path := filepath.Join(t.TempDir(), "ca.pem")
		if err := os.WriteFile(path, caPEM, 0o600); err != nil {
			t.Fatal(err)
		}
		output, err := exec.CommandContext(context.Background(), openssl, "x509", "-noout", "-subject_hash", "-in", path).Output()
		if err != nil {
			t.Fatalf("%s: openssl: %v", name, err)
		}
		got, err := caPathName(caPEM)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if want := strings.TrimSpace(string(output)) + ".0"; got != want {
			t.Errorf("%s: name %s, openssl says %s", name, got, want)
		}
	}
}

func selfSigned(t *testing.T, subject pkix.Name) []byte {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: subject,
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
}
