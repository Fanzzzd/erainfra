package main

// Prototype of the "only a reachable relay exists" architecture:
// two outbound-only peers (db-agent, backend-agent) both dial OUT to a relay
// rendezvous, which bridges them. Proves transparent TCP between peers that
// never connect to each other directly. stdlib only; loopback; safe & disposable.

import (
	"bufio"
	"fmt"
	"io"
	"net"
	"os"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type peer struct {
	c net.Conn
	r *bufio.Reader
}

type ctrlConn struct {
	c  net.Conn
	mu sync.Mutex
}

type relayState struct {
	mu      sync.Mutex
	control map[string]*ctrlConn // key -> db-agent control conn
	data    map[string]peer      // sid -> db-agent data conn waiting
	req     map[string]peer      // sid -> backend conn waiting
}

func main() {
	if len(os.Args) < 2 {
		fmt.Println("usage: plproto <relay|dbagent|backendagent|echoserver|probe> ...")
		os.Exit(1)
	}
	switch os.Args[1] {
	case "relay":
		relay(os.Args[2])
	case "dbagent":
		dbagent(os.Args[2], os.Args[3], os.Args[4])
	case "backendagent":
		backendagent(os.Args[2], os.Args[3], os.Args[4])
	case "echoserver":
		echoserver(os.Args[2])
	case "probe":
		probe(os.Args[2])
	case "wsrelay":
		wsrelay(os.Args[2])
	case "wsdbagent":
		wsdbagent(os.Args[2], os.Args[3], os.Args[4])
	case "wsbackendagent":
		wsbackendagent(os.Args[2], os.Args[3], os.Args[4])
	default:
		fmt.Println("unknown", os.Args[1])
		os.Exit(1)
	}
}

// echo server stands in for the database (any TCP service works — it's byte-transparent).
func echoserver(addr string) {
	ln, err := net.Listen("tcp", addr)
	must(err)
	fmt.Println("echo(DB) listening", addr)
	for {
		c, err := ln.Accept()
		if err != nil {
			continue
		}
		go func(c net.Conn) { defer c.Close(); io.Copy(c, c) }(c)
	}
}

func relay(addr string) {
	st := &relayState{control: map[string]*ctrlConn{}, data: map[string]peer{}, req: map[string]peer{}}
	ln, err := net.Listen("tcp", addr)
	must(err)
	fmt.Println("relay listening", addr)
	for {
		c, err := ln.Accept()
		if err != nil {
			continue
		}
		go st.handle(c)
	}
}

func (st *relayState) handle(c net.Conn) {
	r := bufio.NewReader(c)
	line, err := r.ReadString('\n')
	if err != nil {
		c.Close()
		return
	}
	f := strings.Fields(strings.TrimSpace(line))
	if len(f) == 0 {
		c.Close()
		return
	}
	switch f[0] {
	case "REG": // db-agent control conn, stays open; relay pushes "NEW <sid>" to it
		key := f[1]
		cc := &ctrlConn{c: c}
		st.mu.Lock()
		st.control[key] = cc
		st.mu.Unlock()
		buf := make([]byte, 64)
		for {
			if _, err := c.Read(buf); err != nil {
				break
			}
		}
		st.mu.Lock()
		if st.control[key] == cc {
			delete(st.control, key)
		}
		st.mu.Unlock()
		c.Close()
	case "DATA": // db-agent data conn for a session
		sid := f[1]
		st.mu.Lock()
		if rp, ok := st.req[sid]; ok {
			delete(st.req, sid)
			st.mu.Unlock()
			bridge(peer{c, r}, rp)
		} else {
			st.data[sid] = peer{c, r}
			st.mu.Unlock()
		}
	case "REQ": // backend conn wanting key/session
		key, sid := f[1], f[2]
		st.mu.Lock()
		cc := st.control[key]
		st.mu.Unlock()
		if cc == nil {
			c.Close()
			return
		}
		cc.mu.Lock()
		fmt.Fprintf(cc.c, "NEW %s\n", sid)
		cc.mu.Unlock()
		st.mu.Lock()
		if dp, ok := st.data[sid]; ok {
			delete(st.data, sid)
			st.mu.Unlock()
			bridge(dp, peer{c, r})
		} else {
			st.req[sid] = peer{c, r}
			st.mu.Unlock()
		}
	default:
		c.Close()
	}
}

func bridge(a, b peer) {
	done := make(chan struct{}, 2)
	go func() { io.Copy(a.c, b.r); done <- struct{}{} }()
	go func() { io.Copy(b.c, a.r); done <- struct{}{} }()
	<-done
	a.c.Close()
	b.c.Close()
	<-done
}

var sidCounter int64

func dbagent(relayAddr, key, target string) {
	c, err := net.Dial("tcp", relayAddr)
	must(err)
	fmt.Fprintf(c, "REG %s\n", key)
	fmt.Println("dbagent registered key", key, "-> target", target)
	r := bufio.NewReader(c)
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			fmt.Println("dbagent control closed:", err)
			return
		}
		f := strings.Fields(strings.TrimSpace(line))
		if len(f) == 2 && f[0] == "NEW" {
			go func(sid string) {
				rc, err := net.Dial("tcp", relayAddr)
				if err != nil {
					return
				}
				fmt.Fprintf(rc, "DATA %s\n", sid)
				tc, err := net.Dial("tcp", target)
				if err != nil {
					rc.Close()
					return
				}
				bridge(peer{rc, bufio.NewReader(rc)}, peer{tc, bufio.NewReader(tc)})
			}(f[1])
		}
	}
}

func backendagent(relayAddr, key, listen string) {
	ln, err := net.Listen("tcp", listen)
	must(err)
	fmt.Println("backendagent listening", listen, "-> key", key, "via relay", relayAddr)
	for {
		lc, err := ln.Accept()
		if err != nil {
			continue
		}
		go func(lc net.Conn) {
			sid := fmt.Sprintf("s%d-%d", atomic.AddInt64(&sidCounter, 1), time.Now().UnixNano())
			rc, err := net.Dial("tcp", relayAddr)
			if err != nil {
				lc.Close()
				return
			}
			fmt.Fprintf(rc, "REQ %s %s\n", key, sid)
			bridge(peer{lc, bufio.NewReader(lc)}, peer{rc, bufio.NewReader(rc)})
		}(lc)
	}
}

func probe(addr string) {
	// latency: 200 small round trips
	c, err := net.Dial("tcp", addr)
	must(err)
	r := bufio.NewReader(c)
	n := 200
	ds := make([]float64, 0, n)
	mismatch := 0
	for i := 0; i < n; i++ {
		sent := fmt.Sprintf("ping%d\n", i)
		t := time.Now()
		fmt.Fprint(c, sent)
		got, err := r.ReadString('\n')
		if err != nil {
			fmt.Println("probe read err:", err)
			os.Exit(1)
		}
		if got != sent { // assert byte-for-byte transparency
			mismatch++
		}
		ds = append(ds, float64(time.Since(t).Microseconds()))
	}
	if mismatch == 0 {
		fmt.Printf("  correctness: %d/%d round-trips byte-for-byte ✅\n", n, n)
	} else {
		fmt.Printf("  correctness: %d/%d MISMATCH ❌\n", mismatch, n)
	}
	sort.Float64s(ds)
	var sum float64
	for _, d := range ds {
		sum += d
	}
	fmt.Printf("  latency over %d round-trips: avg=%.0fus p50=%.0fus p99=%.0fus\n", n, sum/float64(n), ds[n/2], ds[n*99/100])
	c.Close()

	// throughput: ~20MB echoed back
	c2, err := net.Dial("tcp", addr)
	must(err)
	const total = 20 * 1024 * 1024
	blk := make([]byte, 64*1024)
	t := time.Now()
	go func() {
		w := 0
		for w < total {
			chunk := min(len(blk), total-w)
			if _, err := c2.Write(blk[:chunk]); err != nil {
				return
			}
			w += chunk
		}
	}()
	got, rbuf := 0, make([]byte, 64*1024)
	for got < total {
		m, err := c2.Read(rbuf)
		if err != nil {
			break
		}
		got += m
	}
	el := time.Since(t).Seconds()
	fmt.Printf("  throughput: %dMB echoed in %.2fs = %.0f Mbit/s\n", total/1024/1024, el, float64(total)*8/1e6/el)
	c2.Close()
}

func must(err error) {
	if err != nil {
		panic(err)
	}
}
