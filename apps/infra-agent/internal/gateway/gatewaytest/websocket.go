// Package gatewaytest has a minimal RFC 6455 echo endpoint and client for testing the gateway
// proxy without a WebSocket dependency. Text frames up to 125 bytes only.
package gatewaytest

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha1" //nolint:gosec // RFC 6455 defines Sec-WebSocket-Accept with SHA-1.
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"
)

const wsGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

func accept(key string) string {
	h := sha1.Sum([]byte(key + wsGUID)) //nolint:gosec // see import
	return base64.StdEncoding.EncodeToString(h[:])
}

// EchoWebSocket upgrades and echoes text frames back, prefixed with prefix and the Host header
// it saw ("<prefix><host> <msg>"), until the client closes.
func EchoWebSocket(prefix string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
			http.Error(w, "websocket only", http.StatusBadRequest)
			return
		}
		conn, rw, err := http.NewResponseController(w).Hijack()
		if err != nil {
			return
		}
		defer func() { _ = conn.Close() }()
		_, _ = fmt.Fprintf(rw, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n", accept(r.Header.Get("Sec-WebSocket-Key")))
		_ = rw.Flush()
		for {
			msg, err := readFrame(rw.Reader)
			if err != nil {
				return
			}
			if err := writeFrame(rw.Writer, []byte(prefix+r.Host+" "+string(msg)), false); err != nil {
				return
			}
			if rw.Flush() != nil {
				return
			}
		}
	}
}

// RoundTrip dials addr, upgrades to a WebSocket for host, sends msg and returns the echo.
func RoundTrip(ctx context.Context, addr, host, msg string) (string, error) {
	conn, err := (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "tcp", addr)
	if err != nil {
		return "", err
	}
	defer func() { _ = conn.Close() }()
	_ = conn.SetDeadline(time.Now().Add(15 * time.Second))
	nonce := make([]byte, 16)
	_, _ = rand.Read(nonce)
	key := base64.StdEncoding.EncodeToString(nonce)
	if _, err := fmt.Fprintf(conn, "GET /ws HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n", host, key); err != nil {
		return "", err
	}
	br := bufio.NewReader(conn)
	resp, err := http.ReadResponse(br, nil)
	if err != nil {
		return "", err
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusSwitchingProtocols || resp.Header.Get("Sec-WebSocket-Accept") != accept(key) {
		return "", fmt.Errorf("upgrade refused: %s", resp.Status)
	}
	bw := bufio.NewWriter(conn)
	if err := writeFrame(bw, []byte(msg), true); err != nil {
		return "", err
	}
	if err := bw.Flush(); err != nil {
		return "", err
	}
	got, err := readFrame(br)
	return string(got), err
}

func writeFrame(w *bufio.Writer, payload []byte, mask bool) error {
	if len(payload) > 125 {
		return errors.New("test frames are at most 125 bytes")
	}
	b := []byte{0x81, byte(len(payload))}
	if !mask {
		b = append(b, payload...)
		_, err := w.Write(b)
		return err
	}
	b[1] |= 0x80
	m := make([]byte, 4)
	_, _ = rand.Read(m)
	b = append(b, m...)
	for i, c := range payload {
		b = append(b, c^m[i%4])
	}
	_, err := w.Write(b)
	return err
}

func readFrame(r *bufio.Reader) ([]byte, error) {
	head := make([]byte, 2)
	if _, err := io.ReadFull(r, head); err != nil {
		return nil, err
	}
	if head[0]&0x0f != 1 {
		return nil, errors.New("not a text frame")
	}
	n := int(head[1] & 0x7f)
	if n > 125 {
		return nil, errors.New("test frames are at most 125 bytes")
	}
	var m []byte
	if head[1]&0x80 != 0 {
		m = make([]byte, 4)
		if _, err := io.ReadFull(r, m); err != nil {
			return nil, err
		}
	}
	payload := make([]byte, n)
	if _, err := io.ReadFull(r, payload); err != nil {
		return nil, err
	}
	for i := range payload {
		if m != nil {
			payload[i] ^= m[i%4]
		}
	}
	return payload, nil
}
