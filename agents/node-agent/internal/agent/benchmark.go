package agent

import (
	"net"
	"time"
)

// BenchmarkResult is a network-path measurement between this machine and a peer.
// ponytail: TCP connect RTT only — the verifiable MVP. Throughput needs a cooperating
// echo/iperf peer; add that when the fabric benchmark endpoint exists (M10).
type BenchmarkResult struct {
	Target    string  `json:"target"`
	Reachable bool    `json:"reachable"`
	Samples   int     `json:"samples"`
	RTTms     float64 `json:"rttMs"` // average over successful samples
	MinRTTms  float64 `json:"minRttMs"`
}

// BenchmarkTCP measures TCP connect latency to target ("host:port") over N samples.
func BenchmarkTCP(target string, samples int, timeout time.Duration) BenchmarkResult {
	if samples <= 0 {
		samples = 3
	}
	res := BenchmarkResult{Target: target, Samples: samples}
	var sum, min float64
	ok := 0
	for i := 0; i < samples; i++ {
		start := time.Now()
		conn, err := net.DialTimeout("tcp", target, timeout)
		if err != nil {
			continue
		}
		rtt := float64(time.Since(start).Microseconds()) / 1000.0
		_ = conn.Close()
		ok++
		sum += rtt
		if min == 0 || rtt < min {
			min = rtt
		}
	}
	if ok > 0 {
		res.Reachable = true
		res.RTTms = sum / float64(ok)
		res.MinRTTms = min
	}
	return res
}
