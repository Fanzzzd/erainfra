package gitmirror

import (
	"bufio"
	"crypto/tls"
	"net"
	"net/http"
	"strings"
	"sync"
)

// connectProxy is the front of the proxy: git, configured with
// http.https://github.com/.proxy, opens a CONNECT tunnel to github.com:443
// here, and the tunnel is handed, wrapped in TLS with the per-guest leaf, to
// the server that reads git's requests.
//
// It tunnels to github.com and nowhere else. git only sends this proxy what
// that one setting names, so any other CONNECT is something else on the guest
// trying to use it, and is refused rather than relayed.
type connectProxy struct {
	host  string
	tls   *tls.Config
	inner *connListener
	logf  func(string, ...any)
}

func (p *connectProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodConnect {
		http.Error(w, "this proxy only tunnels git to github.com", http.StatusMethodNotAllowed)
		return
	}
	if !strings.EqualFold(r.Host, p.host) {
		p.logf("git mirror: refused a tunnel to %q; the proxy only tunnels to %s", r.Host, p.host)
		http.Error(w, "this proxy only tunnels to "+p.host, http.StatusForbidden)
		return
	}
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "tunnel unavailable", http.StatusInternalServerError)
		return
	}
	conn, buffered, err := hijacker.Hijack()
	if err != nil {
		return
	}
	if _, err := buffered.WriteString("HTTP/1.1 200 Connection established\r\n\r\n"); err != nil {
		_ = conn.Close()
		return
	}
	if err := buffered.Flush(); err != nil {
		_ = conn.Close()
		return
	}
	tunnel := conn
	if buffered.Reader.Buffered() > 0 {
		// A client that sent its TLS hello without waiting for the 200 left
		// those bytes in the server's reader, not on the socket.
		tunnel = &bufferedConn{Conn: conn, reader: buffered.Reader}
	}
	p.inner.deliver(tls.Server(tunnel, p.tls))
}

type bufferedConn struct {
	net.Conn
	reader *bufio.Reader
}

func (c *bufferedConn) Read(b []byte) (int, error) { return c.reader.Read(b) }

// connListener is a net.Listener fed by the CONNECT handler, so that an
// ordinary http.Server serves what comes through each tunnel.
type connListener struct {
	addr  net.Addr
	conns chan net.Conn
	done  chan struct{}
	once  sync.Once
}

func newConnListener(addr net.Addr) *connListener {
	return &connListener{addr: addr, conns: make(chan net.Conn), done: make(chan struct{})}
}

func (l *connListener) deliver(conn net.Conn) {
	select {
	case l.conns <- conn:
	case <-l.done:
		_ = conn.Close()
	}
}

func (l *connListener) Accept() (net.Conn, error) {
	select {
	case conn := <-l.conns:
		return conn, nil
	case <-l.done:
		return nil, net.ErrClosed
	}
}

func (l *connListener) Close() error {
	l.once.Do(func() { close(l.done) })
	return nil
}

func (l *connListener) Addr() net.Addr { return l.addr }
