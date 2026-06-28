package agent

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// The data plane: a SECOND outbound socket to the hub (`/data`) over which the hub reverse-proxies
// inbound HTTP for this node's apps. Unlike the control channel, requests are handled CONCURRENTLY
// (a goroutine per stream id, a write mutex for replies) — a proxy can't serialize on one slow
// upstream. The fetch target is always loopback + a port THIS agent recorded at deploy; the hub's
// frame only names the app, so it can never point us at an arbitrary host (no SSRF).

const (
	dataMaxBody      = 10 << 20 // 10MB request/response body cap (matches the hub)
	dataPingEvery    = 20 * time.Second
	dataReadDeadline = 60 * time.Second // dropped if no frame/pong within this — fixes dead-NAT black holes
)

type dataReqMsg struct {
	Type    string            `json:"type"`
	ID      string            `json:"id"`
	App     string            `json:"app"`
	Method  string            `json:"method"`
	Path    string            `json:"path"`
	Headers map[string]string `json:"headers"`
	Body    string            `json:"body"` // base64
}

// dataConn wraps the socket with a write mutex (gorilla forbids concurrent writers).
type dataConn struct {
	c  *websocket.Conn
	mu sync.Mutex
}

func (d *dataConn) writeJSON(v any) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.c.WriteJSON(v)
}

func (d *dataConn) ping() error {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.c.WriteControl(websocket.PingMessage, nil, time.Now().Add(5*time.Second))
}

var dataClient = &http.Client{Timeout: 30 * time.Second}

// ConnectData dials the hub's data channel and serves reverse-proxied requests forever, reconnecting
// on drop (mirrors Connect's backoff). reg supplies app->port; nil-safe (proxying just 502s).
func ConnectData(hubURL, token, agentID string, reg *Registry) {
	for {
		if err := connectDataOnce(hubURL, token, agentID, reg); err != nil {
			fmt.Printf("[agent/data] disconnected: %v — retrying in 3s\n", err)
		}
		time.Sleep(3 * time.Second)
	}
}

func connectDataOnce(hubURL, token, agentID string, reg *Registry) error {
	h := http.Header{}
	if token != "" {
		h.Set("Authorization", "Bearer "+token)
	}
	c, _, err := websocket.DefaultDialer.Dial(hubURL, h)
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	defer c.Close()
	c.SetReadLimit(dataMaxBody + (1 << 20)) // body + framing headroom; bounds memory on a hostile peer
	d := &dataConn{c: c}
	if err := d.writeJSON(map[string]any{"type": "hello", "agentId": agentID}); err != nil {
		return fmt.Errorf("hello: %w", err)
	}
	fmt.Printf("[agent/data] connected to %s as %q\n", hubURL, agentID)

	// Liveness: extend the read deadline on every frame/pong; a ticker pings so the hub does the same.
	_ = c.SetReadDeadline(time.Now().Add(dataReadDeadline))
	c.SetPongHandler(func(string) error { return c.SetReadDeadline(time.Now().Add(dataReadDeadline)) })
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		t := time.NewTicker(dataPingEvery)
		defer t.Stop()
		for {
			select {
			case <-stop:
				return
			case <-t.C:
				if err := d.ping(); err != nil {
					return
				}
			}
		}
	}()

	for {
		var m dataReqMsg
		if err := c.ReadJSON(&m); err != nil {
			return fmt.Errorf("read: %w", err)
		}
		_ = c.SetReadDeadline(time.Now().Add(dataReadDeadline))
		if m.Type != "req" {
			continue
		}
		go handleProxyReq(d, m, reg) // concurrent: one slow upstream must not block other streams
	}
}

func handleProxyReq(d *dataConn, m dataReqMsg, reg *Registry) {
	sendErr := func(e string) { _ = d.writeJSON(map[string]any{"type": "err", "id": m.ID, "error": e}) }

	if reg == nil {
		sendErr("no registry")
		return
	}
	port, ok := reg.Port(m.App)
	if !ok {
		sendErr("app not deployed here: " + m.App)
		return
	}
	body, err := base64.StdEncoding.DecodeString(m.Body)
	if err != nil {
		sendErr("bad body encoding")
		return
	}
	// Target is ALWAYS loopback + the agent-recorded port. The hub frame never carries a host:port.
	url := fmt.Sprintf("http://127.0.0.1:%d%s", port, m.Path)
	req, err := http.NewRequest(strings.ToUpper(m.Method), url, bytes.NewReader(body))
	if err != nil {
		sendErr("bad request: " + err.Error())
		return
	}
	for k, v := range m.Headers {
		if strings.ContainsAny(k, "\r\n") || strings.ContainsAny(v, "\r\n") {
			continue // defense in depth (the hub already strips CRLF)
		}
		if strings.EqualFold(k, "Host") || strings.EqualFold(k, "X-Forwarded-Host") {
			req.Host = v // let the app see its real hostname
			continue
		}
		req.Header.Set(k, v)
	}

	resp, err := dataClient.Do(req)
	if err != nil {
		sendErr("upstream: " + err.Error())
		return
	}
	defer resp.Body.Close()
	rb, err := io.ReadAll(io.LimitReader(resp.Body, dataMaxBody))
	if err != nil {
		sendErr("read upstream: " + err.Error())
		return
	}
	headers := map[string]string{}
	for k, vs := range resp.Header {
		headers[k] = strings.Join(vs, ", ")
	}
	_ = d.writeJSON(map[string]any{
		"type": "resp", "id": m.ID, "status": resp.StatusCode,
		"headers": headers, "body": base64.StdEncoding.EncodeToString(rb),
	})
}
