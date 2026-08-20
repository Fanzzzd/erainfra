// Package cacheca mints the per-guest ephemeral certificate authority that makes
// the job-cache interceptor (ADR 0008) safe to trust.
//
// The interceptor impersonates GitHub's cache host inside the guest, so the
// guest has to trust a certificate the interceptor holds the key to. A
// fleet-wide CA whose key leaked would let its holder impersonate that host to
// every guest for as long as the CA lived. A CA minted fresh at each guest boot,
// keyed only on the host, and discarded with the guest collapses that blast
// radius to one VM's lifetime — and because the CA is name-constrained to the
// single cache host and excludes every other name type, even within that
// lifetime it can vouch for nothing else a guest would reach.
//
// The name constraints are load-bearing rather than decorative, but they only
// bite on a conforming validator. ADR 0008 records the guest-side version floors
// (.NET >= 6, OpenSSL >= 3.0.15, Go >= 1.25.8/1.26.1, Node via
// NODE_EXTRA_CA_CERTS) under which the constraints are enforced; a validator
// below them may ignore the constraints and must not be trusted with this CA.
package cacheca

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"time"
)

// CacheHost is the one name the interceptor answers for. GitHub serves Actions
// cache v2 and Artifacts v4 from this single host (ADR 0008); the interceptor
// serves the CacheService path and forwards everything else to the real host.
const CacheHost = "results-receiver.actions.githubusercontent.com"

// clockSkew backdates NotBefore so a guest whose clock trails the host's does
// not reject a certificate as not-yet-valid. It is small on purpose: this cert
// is served to untrusted code, so its validity window should not be padded more
// than a boot's worth of skew needs.
const clockSkew = 5 * time.Minute

// Authority is a guest's throwaway CA and the single leaf it exists to sign.
// The CA private key is never part of it: Mint signs the one leaf and discards
// the CA key, so nothing that outlives the call can mint a second certificate.
type Authority struct {
	// TrustAnchorPEM is the CA certificate the guest installs as a trusted root.
	TrustAnchorPEM []byte
	// LeafCertPEM is the certificate the interceptor presents for CacheHost.
	LeafCertPEM []byte
	// LeafKeyPEM is the interceptor's private key. It never enters the guest.
	LeafKeyPEM []byte
}

// Mint creates a fresh Authority valid for [now-clockSkew, now+lifetime]. The
// lifetime should track the guest's, not exceed it: the whole point is that the
// material dies with the VM.
func Mint(now time.Time, lifetime time.Duration) (*Authority, error) {
	if lifetime <= 0 {
		return nil, errors.New("cacheca: certificate lifetime must be positive")
	}

	caCert, caKey, err := newCA(now, lifetime)
	if err != nil {
		return nil, err
	}

	leafKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("cacheca: generate leaf key: %w", err)
	}
	leafCert, err := signLeaf(caCert, caKey, &leafKey.PublicKey, now, lifetime, CacheHost)
	if err != nil {
		return nil, err
	}
	// caKey leaves scope here and is never returned: the CA can sign nothing more.

	leafKeyDER, err := x509.MarshalPKCS8PrivateKey(leafKey)
	if err != nil {
		return nil, fmt.Errorf("cacheca: marshal leaf key: %w", err)
	}
	return &Authority{
		TrustAnchorPEM: pemBlock("CERTIFICATE", caCert.Raw),
		LeafCertPEM:    pemBlock("CERTIFICATE", leafCert.Raw),
		LeafKeyPEM:     pemBlock("PRIVATE KEY", leafKeyDER),
	}, nil
}

// newCA builds the name-constrained CA. It permits exactly one DNS name and
// excludes every IP, email and URI, so a leaf for anything but CacheHost fails
// on a validator that enforces name constraints. MaxPathLenZero forbids it from
// signing another CA, so the constraints cannot be widened by an intermediate.
func newCA(now time.Time, lifetime time.Duration) (*x509.Certificate, *ecdsa.PrivateKey, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, fmt.Errorf("cacheca: generate CA key: %w", err)
	}
	serial, err := randomSerial()
	if err != nil {
		return nil, nil, err
	}
	template := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: "EraInfra cache interceptor (ephemeral)"},
		NotBefore:             now.Add(-clockSkew),
		NotAfter:              now.Add(lifetime),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		BasicConstraintsValid: true,
		IsCA:                  true,
		MaxPathLen:            0,
		MaxPathLenZero:        true,
		PermittedDNSDomains:   []string{CacheHost},
		// A permitted DNS domain without a leading dot matches the host AND its
		// subdomains, so the permit above would also let a leaf for
		// `child.<host>` through. The leading-dot exclusion matches subdomains
		// but not the bare host, so the two together mean "exactly this host".
		ExcludedDNSDomains: []string{"." + CacheHost},
		// Everything below forbids a leaf from carrying that name type at all: the
		// leaf Mint signs never does, and a leaked CA cannot add one on a
		// conforming validator. An excluded range that covers the whole space is
		// how "no name of this type is permitted" is spelled in RFC 5280.
		ExcludedIPRanges: []*net.IPNet{
			{IP: net.IPv4zero, Mask: net.CIDRMask(0, 32)},
			{IP: net.IPv6zero, Mask: net.CIDRMask(0, 128)},
		},
		ExcludedEmailAddresses:      []string{""},
		ExcludedURIDomains:          []string{""},
		PermittedDNSDomainsCritical: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		return nil, nil, fmt.Errorf("cacheca: create CA certificate: %w", err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, nil, fmt.Errorf("cacheca: parse CA certificate: %w", err)
	}
	return cert, key, nil
}

// signLeaf issues the interceptor's server certificate for one DNS name and
// nothing else: no IP, email or URI SAN, so the CA's exclusions never even come
// into play for the honest leaf.
func signLeaf(
	ca *x509.Certificate,
	caKey *ecdsa.PrivateKey,
	leafPub *ecdsa.PublicKey,
	now time.Time,
	lifetime time.Duration,
	dnsName string,
) (*x509.Certificate, error) {
	serial, err := randomSerial()
	if err != nil {
		return nil, err
	}
	template := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: dnsName},
		NotBefore:    now.Add(-clockSkew),
		NotAfter:     now.Add(lifetime),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:     []string{dnsName},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, ca, leafPub, caKey)
	if err != nil {
		return nil, fmt.Errorf("cacheca: create leaf certificate: %w", err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, fmt.Errorf("cacheca: parse leaf certificate: %w", err)
	}
	return cert, nil
}

func randomSerial() (*big.Int, error) {
	// 128 bits, per CA/Browser Forum guidance and to make collision within a
	// fleet's worth of boots a non-event.
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return nil, fmt.Errorf("cacheca: generate serial: %w", err)
	}
	return serial, nil
}

func pemBlock(kind string, der []byte) []byte {
	return pem.EncodeToMemory(&pem.Block{Type: kind, Bytes: der})
}
