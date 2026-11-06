package gitmirror

import (
	"bytes"
	"crypto/sha1" //nolint:gosec // OpenSSL's subject hash is defined over SHA-1; it names a file, it secures nothing
	"crypto/x509"
	"encoding/asn1"
	"encoding/binary"
	"encoding/pem"
	"errors"
	"fmt"
	"slices"
	"strings"
	"unicode"
)

// caPathName is the file name the per-guest CA is written under in the
// directory git's http.sslCAPath names: OpenSSL's "<subject hash>.0", which is
// how OpenSSL and LibreSSL find a CA in a directory. GnuTLS, which Ubuntu's
// git uses, reads every file in the directory whatever its name.
//
// That directory is what keeps the proxy working for a job that sets
// GIT_SSL_CAINFO. The variable replaces git's http.sslCAInfo, the bundle the
// guest writes, so a job that points it at its own bundle would no longer
// trust the proxy's leaf and every fetch of github.com would fail. libcurl
// trusts a CA file and a CA directory together, and the variable leaves the
// directory alone.
func caPathName(caPEM []byte) (string, error) {
	block, _ := pem.Decode(caPEM)
	if block == nil || block.Type != "CERTIFICATE" {
		return "", errors.New("gitmirror: the CA is not a PEM certificate")
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return "", fmt.Errorf("gitmirror: parse the CA: %w", err)
	}
	hash, err := subjectHash(cert.RawSubject)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%08x.0", hash), nil
}

// ASN.1 string tags OpenSSL canonicalizes in a name.
const (
	tagUTF8String      = 12
	tagPrintableString = 19
	tagIA5String       = 22
)

// subjectHash is OpenSSL's X509_NAME_hash: the first four bytes, read little
// endian, of the SHA-1 of the name's canonical encoding. The canonical
// encoding is each relative distinguished name's SET, concatenated without the
// outer SEQUENCE, with every string value re-encoded as a UTF8String that is
// lower-cased and has its whitespace trimmed and collapsed (x509_name_canon in
// crypto/x509/x_name.c). Only the string types a minted CA's name uses are
// handled; any other makes this an error, and the guest goes without the
// directory rather than write a file under the wrong name.
func subjectHash(rawSubject []byte) (uint32, error) {
	var rdns []asn1.RawValue
	if rest, err := asn1.Unmarshal(rawSubject, &rdns); err != nil || len(rest) > 0 {
		return 0, errors.New("gitmirror: the CA's subject is not a name")
	}
	var canonical []byte
	for _, rdn := range rdns {
		var attributes []struct {
			Type  asn1.ObjectIdentifier
			Value asn1.RawValue
		}
		if rest, err := asn1.UnmarshalWithParams(rdn.FullBytes, &attributes, "set"); err != nil || len(rest) > 0 {
			return 0, errors.New("gitmirror: the CA's subject has a malformed component")
		}
		var encoded [][]byte
		for _, attribute := range attributes {
			value := attribute.Value
			if value.Class == asn1.ClassUniversal {
				switch value.Tag {
				case tagUTF8String, tagPrintableString, tagIA5String:
					canon, err := asn1.MarshalWithParams(canonicalString(string(value.Bytes)), "utf8")
					if err != nil {
						return 0, err
					}
					value = asn1.RawValue{FullBytes: canon}
				default:
					return 0, fmt.Errorf("gitmirror: the CA's subject uses ASN.1 string type %d", value.Tag)
				}
			}
			der, err := asn1.Marshal(struct {
				Type  asn1.ObjectIdentifier
				Value asn1.RawValue
			}{attribute.Type, value})
			if err != nil {
				return 0, err
			}
			encoded = append(encoded, der)
		}
		// DER orders a SET OF by its encoded members.
		slices.SortFunc(encoded, bytes.Compare)
		set, err := asn1.Marshal(asn1.RawValue{
			Class: asn1.ClassUniversal, Tag: asn1.TagSet, IsCompound: true, Bytes: bytes.Join(encoded, nil),
		})
		if err != nil {
			return 0, err
		}
		canonical = append(canonical, set...)
	}
	digest := sha1.Sum(canonical) //nolint:gosec // see the import
	return binary.LittleEndian.Uint32(digest[:4]), nil
}

// canonicalString is asn1_string_canon's rule for a value: leading and
// trailing whitespace dropped, every inner run of it made one space, and ASCII
// letters lower-cased.
func canonicalString(value string) string {
	fields := strings.FieldsFunc(value, func(r rune) bool { return r < 0x80 && unicode.IsSpace(r) })
	joined := strings.Join(fields, " ")
	return strings.Map(func(r rune) rune {
		if r >= 'A' && r <= 'Z' {
			return r + ('a' - 'A')
		}
		return r
	}, joined)
}
