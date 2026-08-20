package cacheca

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"math/big"
	"net"
	"net/url"
	"testing"
	"time"
)

const testLifetime = 2 * time.Hour

func mustMint(t *testing.T) (*Authority, time.Time) {
	t.Helper()
	now := time.Date(2026, 8, 20, 12, 0, 0, 0, time.UTC)
	auth, err := Mint(now, testLifetime)
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	return auth, now
}

func rootPool(t *testing.T, pemBytes []byte) *x509.CertPool {
	t.Helper()
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(pemBytes) {
		t.Fatal("trust anchor PEM did not parse into a pool")
	}
	return pool
}

func parseLeaf(t *testing.T, pemBytes []byte) *x509.Certificate {
	t.Helper()
	block, _ := pem.Decode(pemBytes)
	if block == nil {
		t.Fatal("leaf PEM did not decode")
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		t.Fatalf("parse leaf: %v", err)
	}
	return cert
}

// The whole point: the interceptor's leaf, presented for the cache host, is
// trusted by a guest that holds only the CA.
func TestHonestLeafVerifiesForCacheHost(t *testing.T) {
	auth, now := mustMint(t)
	leaf := parseLeaf(t, auth.LeafCertPEM)

	_, err := leaf.Verify(x509.VerifyOptions{
		Roots:       rootPool(t, auth.TrustAnchorPEM),
		DNSName:     CacheHost,
		CurrentTime: now,
		KeyUsages:   []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	})
	if err != nil {
		t.Fatalf("honest leaf for %s did not verify: %v", CacheHost, err)
	}
}

// The interceptor has to be able to actually serve the pair.
func TestLeafPEMFormsAServingKeyPair(t *testing.T) {
	auth, _ := mustMint(t)
	if _, err := tls.X509KeyPair(auth.LeafCertPEM, auth.LeafKeyPEM); err != nil {
		t.Fatalf("leaf cert/key are not a usable TLS pair: %v", err)
	}
}

// A guest that trusts this CA must not, even so, accept a certificate for any
// other host. This is the leaked-CA blast-radius property, and it is only real
// if Go actually enforces the DNS name constraint — so forge a leaf for another
// host with the real CA key and require rejection.
func TestForgedLeafForAnotherHostIsRejected(t *testing.T) {
	now := time.Date(2026, 8, 20, 12, 0, 0, 0, time.UTC)
	ca, caKey, err := newCA(now, testLifetime)
	if err != nil {
		t.Fatalf("newCA: %v", err)
	}

	forged := forgeLeaf(t, ca, caKey, now, &x509.Certificate{
		Subject:  pkix.Name{CommonName: "evil.example.com"},
		DNSNames: []string{"evil.example.com"},
	})
	assertRejected(t, forged, ca, now, "evil.example.com")
}

// Every non-DNS SAN type is excluded, so a forged leaf carrying one is refused.
// These prove the ExcludedIPRanges / ExcludedEmailAddresses / ExcludedURIDomains
// values actually take effect — the "" exclusion is easy to get wrong.
func TestForgedLeafWithForbiddenSANTypesIsRejected(t *testing.T) {
	now := time.Date(2026, 8, 20, 12, 0, 0, 0, time.UTC)
	uri, _ := url.Parse("https://evil.example.com/")

	cases := map[string]x509.Certificate{
		"ipv4 SAN":  {Subject: pkix.Name{CommonName: CacheHost}, IPAddresses: []net.IP{net.IPv4(10, 0, 0, 1)}},
		"ipv6 SAN":  {Subject: pkix.Name{CommonName: CacheHost}, IPAddresses: []net.IP{net.ParseIP("2001:db8::1")}},
		"email SAN": {Subject: pkix.Name{CommonName: CacheHost}, EmailAddresses: []string{"root@evil.example.com"}},
		"uri SAN":   {Subject: pkix.Name{CommonName: CacheHost}, URIs: []*url.URL{uri}},
	}
	for name, tmpl := range cases {
		t.Run(name, func(t *testing.T) {
			ca, caKey, err := newCA(now, testLifetime)
			if err != nil {
				t.Fatalf("newCA: %v", err)
			}
			tmpl := tmpl
			forged := forgeLeaf(t, ca, caKey, now, &tmpl)
			assertRejected(t, forged, ca, now, "")
		})
	}
}

// MaxPathLenZero: the CA cannot sign another CA, so the constraints cannot be
// escaped by minting an unconstrained intermediate under it.
func TestForgedIntermediateIsRejected(t *testing.T) {
	now := time.Date(2026, 8, 20, 12, 0, 0, 0, time.UTC)
	ca, caKey, err := newCA(now, testLifetime)
	if err != nil {
		t.Fatalf("newCA: %v", err)
	}

	interKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	interTmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(2),
		Subject:               pkix.Name{CommonName: "rogue intermediate"},
		NotBefore:             now.Add(-clockSkew),
		NotAfter:              now.Add(testLifetime),
		KeyUsage:              x509.KeyUsageCertSign,
		BasicConstraintsValid: true,
		IsCA:                  true,
	}
	interDER, err := x509.CreateCertificate(rand.Reader, interTmpl, ca, &interKey.PublicKey, caKey)
	if err != nil {
		t.Fatalf("create intermediate: %v", err)
	}
	inter, _ := x509.ParseCertificate(interDER)

	// The leaf uses the permitted host, so the DNS name constraint is satisfied
	// and the ONLY thing that can reject the chain is the path-length limit.
	leaf := forgeLeaf(t, inter, interKey, now, &x509.Certificate{
		Subject:  pkix.Name{CommonName: CacheHost},
		DNSNames: []string{CacheHost},
	})

	pool := x509.NewCertPool()
	pool.AddCert(ca)
	intermediates := x509.NewCertPool()
	intermediates.AddCert(inter)
	_, err = leaf.Verify(x509.VerifyOptions{
		Roots:         pool,
		Intermediates: intermediates,
		CurrentTime:   now,
	})
	var invalid x509.CertificateInvalidError
	if !errors.As(err, &invalid) || invalid.Reason != x509.TooManyIntermediates {
		t.Fatalf("rejected for %q, want a TooManyIntermediates path-length failure", err)
	}
}

// A permitted DNS domain matches subdomains too, so the exact-host limit is only
// real if descendants are separately excluded. Forge a leaf for a subdomain and
// require the same name-constraint rejection the honest host never triggers.
func TestForgedLeafForASubdomainIsRejected(t *testing.T) {
	now := time.Date(2026, 8, 20, 12, 0, 0, 0, time.UTC)
	ca, caKey, err := newCA(now, testLifetime)
	if err != nil {
		t.Fatalf("newCA: %v", err)
	}
	sub := "child." + CacheHost
	forged := forgeLeaf(t, ca, caKey, now, &x509.Certificate{
		Subject:  pkix.Name{CommonName: sub},
		DNSNames: []string{sub},
	})
	assertRejected(t, forged, ca, now, sub)
}

func TestValidityWindowTracksLifetime(t *testing.T) {
	auth, now := mustMint(t)
	leaf := parseLeaf(t, auth.LeafCertPEM)
	ca := parseLeaf(t, auth.TrustAnchorPEM)

	for _, c := range []*x509.Certificate{ca, leaf} {
		if !c.NotBefore.Equal(now.Add(-clockSkew)) {
			t.Errorf("NotBefore = %v, want %v", c.NotBefore, now.Add(-clockSkew))
		}
		if !c.NotAfter.Equal(now.Add(testLifetime)) {
			t.Errorf("NotAfter = %v, want %v", c.NotAfter, now.Add(testLifetime))
		}
	}
	// A certificate whose window has closed is no longer trusted, so the guest's
	// trust dies with the lifetime even if the material somehow survives.
	if _, err := leaf.Verify(x509.VerifyOptions{
		Roots:       rootPool(t, auth.TrustAnchorPEM),
		DNSName:     CacheHost,
		CurrentTime: now.Add(testLifetime + time.Hour),
	}); err == nil {
		t.Fatal("leaf still verified an hour after it expired")
	}
}

func TestCAConstraintsArePresentAndCritical(t *testing.T) {
	auth, _ := mustMint(t)
	ca := parseLeaf(t, auth.TrustAnchorPEM)

	if !ca.IsCA || !ca.MaxPathLenZero {
		t.Errorf("CA basic constraints: IsCA=%v MaxPathLenZero=%v", ca.IsCA, ca.MaxPathLenZero)
	}
	if len(ca.PermittedDNSDomains) != 1 || ca.PermittedDNSDomains[0] != CacheHost {
		t.Errorf("PermittedDNSDomains = %v, want [%s]", ca.PermittedDNSDomains, CacheHost)
	}
	if len(ca.ExcludedIPRanges) == 0 {
		t.Error("ExcludedIPRanges is empty; an IP SAN would be unconstrained")
	}
	// RFC 5280 SHOULD mark name constraints critical, so a validator that cannot
	// enforce them refuses the certificate rather than ignoring the limits.
	const nameConstraintsOID = "2.5.29.30"
	found := false
	for _, ext := range ca.Extensions {
		if ext.Id.String() == nameConstraintsOID {
			found = true
			if !ext.Critical {
				t.Error("name constraints extension is not marked critical")
			}
		}
	}
	if !found {
		t.Error("CA carries no name constraints extension")
	}
}

func TestMintRejectsNonPositiveLifetime(t *testing.T) {
	now := time.Date(2026, 8, 20, 12, 0, 0, 0, time.UTC)
	for _, d := range []time.Duration{0, -time.Second} {
		if _, err := Mint(now, d); err == nil {
			t.Errorf("Mint with lifetime %v returned no error", d)
		}
	}
}

// forgeLeaf signs an attacker-chosen leaf template with the CA's own key,
// filling in the fields Mint would otherwise control, so a test can prove the
// constraints reject names the honest leaf never carries.
func forgeLeaf(t *testing.T, ca *x509.Certificate, caKey *ecdsa.PrivateKey, now time.Time, tmpl *x509.Certificate) *x509.Certificate {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl.SerialNumber = big.NewInt(99)
	tmpl.NotBefore = now.Add(-clockSkew)
	tmpl.NotAfter = now.Add(testLifetime)
	tmpl.KeyUsage = x509.KeyUsageDigitalSignature
	tmpl.ExtKeyUsage = []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, ca, &key.PublicKey, caKey)
	if err != nil {
		t.Fatalf("forge leaf: %v", err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatalf("parse forged leaf: %v", err)
	}
	return cert
}

func assertRejected(t *testing.T, leaf, ca *x509.Certificate, now time.Time, dnsName string) {
	t.Helper()
	pool := x509.NewCertPool()
	pool.AddCert(ca)
	opts := x509.VerifyOptions{Roots: pool, CurrentTime: now}
	if dnsName != "" {
		opts.DNSName = dnsName
	}
	_, err := leaf.Verify(opts)
	if err == nil {
		t.Fatal("a leaf the CA's name constraints should forbid verified anyway")
	}
	// Prove the rejection is the name constraint, not some incidental failure:
	// the leaf is otherwise valid and its hostname, when checked, matches.
	var invalid x509.CertificateInvalidError
	if !errors.As(err, &invalid) || invalid.Reason != x509.CANotAuthorizedForThisName {
		t.Fatalf("rejected for %q, want a CANotAuthorizedForThisName name-constraint failure", err)
	}
}
