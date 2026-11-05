package jobmetrics

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

const gib = 1 << 30

func TestVMMSourceReadsTheProcessFromOutsideTheGuest(t *testing.T) {
	source := &VMMSource{
		ProcRoot: "testdata/proc",
		PID:      4242,
		TapName:  "tap0",
		Console:  &ConsoleOOMScanner{Path: "testdata/console/console.log"},
	}
	if source.Kind() != "firecracker-vmm" {
		t.Fatalf("kind = %q", source.Kind())
	}
	now := time.Unix(1_700_000_000, 0)
	reading, err := source.Read(now)
	if err != nil {
		t.Fatal(err)
	}
	if !reading.At.Equal(now) {
		t.Errorf("At = %v, want %v", reading.At, now)
	}
	// utime 12345 + stime 678 ticks at USER_HZ 100, counted from the last ')'
	// of a command name that itself contains one.
	if want := uint64(13023 * 10_000); reading.CPUMicros != want {
		t.Errorf("CPUMicros = %d, want %d", reading.CPUMicros, want)
	}
	if reading.MemoryBytes != 2*gib || reading.MemoryPeakBytes != 3*gib {
		t.Errorf("memory = %d peak %d, want VmRSS 2 GiB and VmHWM 3 GiB", reading.MemoryBytes, reading.MemoryPeakBytes)
	}
	if !reading.HasDisk || reading.DiskReadBytes != 524288000 || reading.DiskWriteBytes != 104857600 {
		t.Errorf("disk = %+v; want read_bytes/write_bytes, not rchar/wchar", reading)
	}
	// The tap's own counters are the host's side: its transmit is what the
	// guest received.
	if !reading.HasNetwork || reading.NetRxBytes != 9_000_000 || reading.NetTxBytes != 2_000_000 {
		t.Errorf("network rx %d tx %d, want the tap's tx as rx and its rx as tx", reading.NetRxBytes, reading.NetTxBytes)
	}
	if !reading.HasOOM || reading.OOMKills != 2 {
		t.Errorf("OOM = %v/%d, want both kernel OOM forms counted once each", reading.HasOOM, reading.OOMKills)
	}
}

func TestVMMSourceWithoutATapLeavesNetworkUnmeasured(t *testing.T) {
	reading, err := (&VMMSource{ProcRoot: "testdata/proc", PID: 4242}).Read(time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if reading.HasNetwork || reading.HasOOM {
		t.Errorf("network %v OOM %v; want both unknown, not zero", reading.HasNetwork, reading.HasOOM)
	}
	reading, err = (&VMMSource{ProcRoot: "testdata/proc", PID: 4242, TapName: "tap9"}).Read(time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if reading.HasNetwork {
		t.Error("a tap that is not in the namespace must not read as zero traffic")
	}
}

func TestAnExitedProcessIsGoneNotFailed(t *testing.T) {
	_, err := (&VMMSource{ProcRoot: "testdata/proc", PID: 1}).Read(time.Now())
	if !errors.Is(err, ErrGone) {
		t.Errorf("VMM err = %v, want ErrGone", err)
	}
	_, err = (&CgroupSource{ProcRoot: "testdata/proc", PID: 1, V2: "testdata/cgroup-v2"}).Read(time.Now())
	if !errors.Is(err, ErrGone) {
		t.Errorf("cgroup err = %v, want ErrGone", err)
	}
}

func TestCgroupV2Container(t *testing.T) {
	source, err := ResolveCgroup("testdata/proc", "testdata/cgroup-v2", 777)
	if err != nil {
		t.Fatal(err)
	}
	if source.Kind() != "cgroup-v2" {
		t.Fatalf("kind = %q", source.Kind())
	}
	if want := filepath.Join("testdata/cgroup-v2", "system.slice", "docker-abc123.scope"); source.V2 != want {
		t.Fatalf("V2 = %q, want %q", source.V2, want)
	}
	reading, err := source.Read(time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if reading.CPUMicros != 9876543 {
		t.Errorf("CPUMicros = %d", reading.CPUMicros)
	}
	// 3 GiB charged, 1 GiB of it inactive page cache: the working set is 2.
	if reading.MemoryBytes != 2*gib {
		t.Errorf("MemoryBytes = %d, want the working set", reading.MemoryBytes)
	}
	if reading.MemoryPeakBytes != 0 {
		t.Errorf("MemoryPeakBytes = %d; memory.peak counts page cache and must not be used", reading.MemoryPeakBytes)
	}
	if !reading.HasOOM || reading.OOMKills != 1 {
		t.Errorf("OOM = %v/%d, want oom_kill, not oom", reading.HasOOM, reading.OOMKills)
	}
	if !reading.HasDisk || reading.DiskReadBytes != 31000 || reading.DiskWriteBytes != 42000 {
		t.Errorf("disk = %d/%d, want every device summed", reading.DiskReadBytes, reading.DiskWriteBytes)
	}
	if !reading.HasNetwork || reading.NetRxBytes != 4_000_000 || reading.NetTxBytes != 1_000_000 {
		t.Errorf("network = %d/%d, want eth0 without lo", reading.NetRxBytes, reading.NetTxBytes)
	}
}

func TestCgroupV1HybridContainer(t *testing.T) {
	source, err := ResolveCgroup("testdata/proc", "testdata/cgroup-v1", 888)
	if err != nil {
		t.Fatal(err)
	}
	if source.Kind() != "cgroup-v1" {
		t.Fatalf("kind = %q; a hybrid host must use its v1 controllers", source.Kind())
	}
	if want := filepath.Join("testdata/cgroup-v1", "cpu,cpuacct", "docker", "def456"); source.V1CPU != want {
		t.Errorf("V1CPU = %q, want the co-mounted directory %q", source.V1CPU, want)
	}
	reading, err := source.Read(time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if reading.CPUMicros != 4_000_000 {
		t.Errorf("CPUMicros = %d, want cpuacct.usage nanoseconds in microseconds", reading.CPUMicros)
	}
	if reading.MemoryBytes != 1_500_000_000 {
		t.Errorf("MemoryBytes = %d, want usage less total_inactive_file", reading.MemoryBytes)
	}
	if !reading.HasOOM || reading.OOMKills != 3 {
		t.Errorf("OOM = %v/%d", reading.HasOOM, reading.OOMKills)
	}
	if !reading.HasDisk || reading.DiskReadBytes != 4196 || reading.DiskWriteBytes != 8392 {
		t.Errorf("disk = %d/%d, want Read and Write rows summed over devices", reading.DiskReadBytes, reading.DiskWriteBytes)
	}
	if reading.NetRxBytes != 12345 || reading.NetTxBytes != 54321 {
		t.Errorf("network = %d/%d", reading.NetRxBytes, reading.NetTxBytes)
	}
}

func TestResolveCgroupRefusesAPartialV1Membership(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "9"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "9", "cgroup"), []byte("11:memory:/docker/x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := ResolveCgroup(dir, dir, 9); err == nil {
		t.Error("a v1 membership without cpuacct must not resolve to a source that reads no CPU")
	}
}

func TestConsoleScannerCarriesAnUnterminatedLine(t *testing.T) {
	path := filepath.Join(t.TempDir(), "console.log")
	original, err := os.ReadFile("testdata/console/console.log")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, original, 0o600); err != nil {
		t.Fatal(err)
	}
	scanner := &ConsoleOOMScanner{Path: path}
	if kills, err := scanner.Scan(); err != nil || kills != 2 {
		t.Fatalf("first scan = %d, %v; want 2", kills, err)
	}
	if kills, _ := scanner.Scan(); kills != 2 {
		t.Fatalf("an unchanged console must not recount: %d", kills)
	}
	appendTo(t, path, "led process 99 (cc1plus) total-vm:1kB\n")
	if kills, _ := scanner.Scan(); kills != 3 {
		t.Fatalf("the line split across scans must count once: %d", kills)
	}
	if err := os.WriteFile(path, []byte("[ 1.0] Out of memory: Killed process 7 (x)\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if kills, _ := scanner.Scan(); kills != 4 {
		t.Fatalf("a truncated console is read from the start: %d", kills)
	}
}

func appendTo(t *testing.T, path string, text string) {
	t.Helper()
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close() //nolint:errcheck // test helper; the write error is checked
	if _, err := file.WriteString(text); err != nil {
		t.Fatal(err)
	}
}
