package objectstore

import (
	"crypto/sha256"
	"encoding/hex"
)

func hashOf(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}
