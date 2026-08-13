package main

// WebSocket variant of the relay: lets the relay sit BEHIND a Cloudflare tunnel
// (cloudflared only carries HTTP/WS, not raw TCP). Both agents connect OUTBOUND over
// wss:// to the tunnel URL — exactly the "only the CF tunnel is reachable, no public
// IP" topology. Data path: agent -> CF edge -> cloudflared -> relay -> ... -> agent.

import (
	"fmt"
	"net"
	"net/http"
	"sync"
	"sync/atomic"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}

type wsRelayState struct {
	mu      sync.Mutex
	control map[string]*wsCtrl
	data    map[string]*websocket.Conn
	req     map[string]*websocket.Conn
}
type wsCtrl struct {
	c  *websocket.Conn
	mu sync.Mutex
}

func wsrelay(addr string) {
	st := &wsRelayState{control: map[string]*wsCtrl{}, data: map[string]*websocket.Conn{}, req: map[string]*websocket.Conn{}}
	http.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		c, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		q := r.URL.Query()
		switch q.Get("role") {
		case "reg":
			key := q.Get("key")
			cc := &wsCtrl{c: c}
			st.mu.Lock()
			st.control[key] = cc
			st.mu.Unlock()
			for { // hold open; drop on close
				if _, _, err := c.ReadMessage(); err != nil {
					break
				}
			}
			st.mu.Lock()
			if st.control[key] == cc {
				delete(st.control, key)
			}
			st.mu.Unlock()
			c.Close()
		case "data":
			sid := q.Get("sid")
			st.mu.Lock()
			if rq, ok := st.req[sid]; ok {
				delete(st.req, sid)
				st.mu.Unlock()
				bridgeWS(c, rq)
			} else {
				st.data[sid] = c
				st.mu.Unlock()
			}
		case "req":
			key, sid := q.Get("key"), q.Get("sid")
			st.mu.Lock()
			cc := st.control[key]
			st.mu.Unlock()
			if cc == nil {
				c.Close()
				return
			}
			cc.mu.Lock()
			cc.c.WriteMessage(websocket.TextMessage, []byte("NEW "+sid))
			cc.mu.Unlock()
			st.mu.Lock()
			if dp, ok := st.data[sid]; ok {
				delete(st.data, sid)
				st.mu.Unlock()
				bridgeWS(dp, c)
			} else {
				st.req[sid] = c
				st.mu.Unlock()
			}
		default:
			c.Close()
		}
	})
	fmt.Println("wsrelay listening", addr)
	must(http.ListenAndServe(addr, nil))
}

func bridgeWS(a, b *websocket.Conn) {
	go func() {
		for {
			_, d, e := a.ReadMessage()
			if e != nil {
				break
			}
			if b.WriteMessage(websocket.BinaryMessage, d) != nil {
				break
			}
		}
		a.Close()
		b.Close()
	}()
	for {
		_, d, e := b.ReadMessage()
		if e != nil {
			break
		}
		if a.WriteMessage(websocket.BinaryMessage, d) != nil {
			break
		}
	}
	a.Close()
	b.Close()
}

// pump a TCP conn <-> a WS conn (one writer per ws conn).
func bridgeTCPWS(tcp net.Conn, ws *websocket.Conn) {
	go func() {
		for {
			_, d, e := ws.ReadMessage()
			if e != nil {
				break
			}
			if _, e := tcp.Write(d); e != nil {
				break
			}
		}
		tcp.Close()
		ws.Close()
	}()
	buf := make([]byte, 32*1024)
	for {
		n, e := tcp.Read(buf)
		if n > 0 {
			if w := ws.WriteMessage(websocket.BinaryMessage, buf[:n]); w != nil {
				break
			}
		}
		if e != nil {
			break
		}
	}
	tcp.Close()
	ws.Close()
}

func wsdial(url string) (*websocket.Conn, error) {
	c, _, err := websocket.DefaultDialer.Dial(url, nil)
	return c, err
}

func wsdbagent(wsURL, key, target string) {
	c, err := wsdial(wsURL + "/ws?role=reg&key=" + key)
	must(err)
	fmt.Println("ws-dbagent registered", key, "-> target", target, "via", wsURL)
	for {
		_, msg, err := c.ReadMessage()
		if err != nil {
			fmt.Println("ws-dbagent control closed:", err)
			return
		}
		var w, sid string
		fmt.Sscanf(string(msg), "%s %s", &w, &sid)
		if w == "NEW" && sid != "" {
			go func(sid string) {
				dc, err := wsdial(wsURL + "/ws?role=data&sid=" + sid)
				if err != nil {
					return
				}
				tc, err := net.Dial("tcp", target)
				if err != nil {
					dc.Close()
					return
				}
				bridgeTCPWS(tc, dc)
			}(sid)
		}
	}
}

func wsbackendagent(wsURL, key, listen string) {
	ln, err := net.Listen("tcp", listen)
	must(err)
	fmt.Println("ws-backendagent listening", listen, "-> key", key, "via", wsURL)
	for {
		lc, err := ln.Accept()
		if err != nil {
			continue
		}
		go func(lc net.Conn) {
			sid := fmt.Sprintf("s%d", atomic.AddInt64(&sidCounter, 1))
			rc, err := wsdial(wsURL + "/ws?role=req&key=" + key + "&sid=" + sid)
			if err != nil {
				lc.Close()
				return
			}
			bridgeTCPWS(lc, rc)
		}(lc)
	}
}
