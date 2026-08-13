package agent

import (
	"net"
	"testing"
	"time"
)

func TestCollectResources(t *testing.T) {
	r := CollectResources()
	if r.CPUCount < 1 {
		t.Fatalf("expected at least 1 CPU, got %d", r.CPUCount)
	}
	if r.GoOS == "" || r.GoArch == "" {
		t.Fatal("expected GOOS/GOARCH to be populated")
	}
}

func TestBuildHeartbeat(t *testing.T) {
	hb := BuildHeartbeat("sg-worker-1", []Role{RoleWorker}, "0.1.0")
	if hb.MachineName != "sg-worker-1" || hb.AgentVersion != "0.1.0" {
		t.Fatalf("unexpected heartbeat: %+v", hb)
	}
	if hb.Resources.CPUCount < 1 {
		t.Fatal("heartbeat should carry resource report")
	}
	if hb.At.IsZero() {
		t.Fatal("heartbeat should be timestamped")
	}
}

func TestBenchmarkTCPReachableAndUnreachable(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			c.Close()
		}
	}()

	ok := BenchmarkTCP(ln.Addr().String(), 3, time.Second)
	if !ok.Reachable {
		t.Fatalf("expected reachable target, got %+v", ok)
	}
	if ok.RTTms < 0 {
		t.Fatalf("expected non-negative rtt, got %v", ok.RTTms)
	}

	bad := BenchmarkTCP("127.0.0.1:1", 2, 200*time.Millisecond)
	if bad.Reachable {
		t.Fatalf("expected unreachable for closed port, got %+v", bad)
	}
}
