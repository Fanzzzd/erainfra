package jobmetrics

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// CgroupSource reads a container through its cgroup, on either hierarchy.
//
// The fleet's Workers are cgroup v1 hybrid and current distributions are
// cgroup v2, so both are first-class: which one applies is read from the
// container's own /proc/<pid>/cgroup, never assumed from the host. The
// container's network is read from /proc/<pid>/net/dev, its namespace's
// interfaces, since cgroups do not account network traffic.
type CgroupSource struct {
	ProcRoot string
	PID      int
	// V2 is the container's directory in the unified hierarchy; empty on a
	// v1 host.
	V2 string
	// The v1 controller directories; empty on a v2 host.
	V1CPU    string
	V1Memory string
	V1Blkio  string
}

// ResolveCgroup finds the cgroup a process lives in. cgroupRoot is
// /sys/fs/cgroup; procRoot is /proc. A host with v1 controllers mounted uses
// them even when it also mounts the unified hierarchy (a hybrid host): Docker
// places containers under the v1 controllers there, and the unified tree
// holds no controllers to read.
func ResolveCgroup(procRoot string, cgroupRoot string, pid int) (*CgroupSource, error) {
	membership, err := os.ReadFile(filepath.Join(procRoot, strconv.Itoa(pid), "cgroup"))
	if err != nil {
		return nil, fmt.Errorf("read process cgroup: %w", err)
	}
	source := &CgroupSource{ProcRoot: procRoot, PID: pid}
	var unified string
	scanner := bufio.NewScanner(bytes.NewReader(membership))
	for scanner.Scan() {
		// hierarchy-ID:controller-list:path; the path may itself contain ':'.
		parts := strings.SplitN(scanner.Text(), ":", 3)
		if len(parts) != 3 {
			continue
		}
		controllers, path := parts[1], parts[2]
		if parts[0] == "0" && controllers == "" {
			unified = path
			continue
		}
		for _, controller := range strings.Split(controllers, ",") {
			directory := v1Directory(cgroupRoot, controllers, controller, path)
			switch controller {
			case "cpuacct":
				source.V1CPU = directory
			case "memory":
				source.V1Memory = directory
			case "blkio":
				source.V1Blkio = directory
			}
		}
	}
	if source.V1Memory != "" || source.V1CPU != "" {
		if source.V1Memory == "" || source.V1CPU == "" {
			return nil, errors.New("process is in a v1 hierarchy without both the memory and cpuacct controllers")
		}
		return source, nil
	}
	if unified == "" {
		return nil, errors.New("process cgroup lists neither v1 controllers nor a unified path")
	}
	source.V2 = filepath.Join(cgroupRoot, filepath.FromSlash(unified))
	return source, nil
}

// v1Directory is where a v1 controller's files for path live. systemd mounts
// co-mounted controllers under their joined name (cpu,cpuacct) and links each
// single name to it; the joined name is tried first because it is the mount.
func v1Directory(root string, joined string, controller string, path string) string {
	for _, name := range []string{joined, controller} {
		candidate := filepath.Join(root, name, filepath.FromSlash(path))
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}
	return filepath.Join(root, controller, filepath.FromSlash(path))
}

func (s *CgroupSource) Kind() string {
	if s.V2 != "" {
		return "cgroup-v2"
	}
	return "cgroup-v1"
}

func (s *CgroupSource) Read(now time.Time) (Reading, error) {
	if processGone(filepath.Join(s.ProcRoot, strconv.Itoa(s.PID))) {
		return Reading{}, ErrGone
	}
	var reading Reading
	var err error
	if s.V2 != "" {
		reading, err = readCgroupV2(s.V2)
	} else {
		reading, err = readCgroupV1(s.V1CPU, s.V1Memory, s.V1Blkio)
	}
	if err != nil {
		return Reading{}, err
	}
	reading.At = now
	netdev, err := os.ReadFile(filepath.Join(s.ProcRoot, strconv.Itoa(s.PID), "net", "dev"))
	if err == nil {
		if counters, err := ParseNetDev(netdev); err == nil {
			reading.HasNetwork = true
			for name, counter := range counters {
				if name == "lo" {
					continue
				}
				reading.NetRxBytes += counter.RxBytes
				reading.NetTxBytes += counter.TxBytes
			}
		}
	}
	return reading, nil
}

func readCgroupV2(dir string) (Reading, error) {
	var reading Reading
	cpu, err := readKeyed(filepath.Join(dir, "cpu.stat"))
	if err != nil {
		return Reading{}, err
	}
	usage, ok := cpu["usage_usec"]
	if !ok {
		return Reading{}, errors.New("cpu.stat has no usage_usec")
	}
	reading.CPUMicros = usage
	current, err := readUint(filepath.Join(dir, "memory.current"))
	if err != nil {
		return Reading{}, err
	}
	memoryStat, err := readKeyed(filepath.Join(dir, "memory.stat"))
	if err != nil {
		return Reading{}, err
	}
	reading.MemoryBytes = workingSet(current, memoryStat["inactive_file"])
	if events, err := readKeyed(filepath.Join(dir, "memory.events")); err == nil {
		if kills, ok := events["oom_kill"]; ok {
			reading.HasOOM, reading.OOMKills = true, kills
		}
	}
	if ioStat, err := os.ReadFile(filepath.Join(dir, "io.stat")); err == nil {
		reading.HasDisk = true
		reading.DiskReadBytes, reading.DiskWriteBytes = parseIOStat(ioStat)
	}
	return reading, nil
}

func readCgroupV1(cpuDir string, memoryDir string, blkioDir string) (Reading, error) {
	var reading Reading
	nanos, err := readUint(filepath.Join(cpuDir, "cpuacct.usage"))
	if err != nil {
		return Reading{}, err
	}
	reading.CPUMicros = nanos / 1000
	usage, err := readUint(filepath.Join(memoryDir, "memory.usage_in_bytes"))
	if err != nil {
		return Reading{}, err
	}
	memoryStat, err := readKeyed(filepath.Join(memoryDir, "memory.stat"))
	if err != nil {
		return Reading{}, err
	}
	inactive, ok := memoryStat["total_inactive_file"]
	if !ok {
		inactive = memoryStat["inactive_file"]
	}
	reading.MemoryBytes = workingSet(usage, inactive)
	// oom_kill joined memory.oom_control in Linux 4.13; older kernels only
	// say whether the cgroup is under OOM right now, which is not a count.
	if control, err := readKeyed(filepath.Join(memoryDir, "memory.oom_control")); err == nil {
		if kills, ok := control["oom_kill"]; ok {
			reading.HasOOM, reading.OOMKills = true, kills
		}
	}
	if blkioDir != "" {
		if serviced, err := os.ReadFile(filepath.Join(blkioDir, "blkio.throttle.io_service_bytes")); err == nil {
			reading.HasDisk = true
			reading.DiskReadBytes, reading.DiskWriteBytes = parseBlkioServiceBytes(serviced)
		}
	}
	return reading, nil
}

// workingSet is charged memory less the inactive page cache, the number
// `docker stats` and Kubernetes report. The kernel reclaims inactive file
// pages before it OOM-kills anything, so counting them would show every job
// that reads a large checkout as close to its limit when it is not.
func workingSet(charged uint64, inactiveFile uint64) uint64 {
	if inactiveFile > charged {
		return 0
	}
	return charged - inactiveFile
}

// parseIOStat sums rbytes and wbytes over every device in a v2 io.stat:
// "8:0 rbytes=1 wbytes=2 rios=3 wios=4 dbytes=0 dios=0".
func parseIOStat(stat []byte) (read uint64, write uint64) {
	for _, line := range strings.Split(string(stat), "\n") {
		for _, field := range strings.Fields(line) {
			key, value, ok := strings.Cut(field, "=")
			if !ok {
				continue
			}
			parsed, err := strconv.ParseUint(value, 10, 64)
			if err != nil {
				continue
			}
			switch key {
			case "rbytes":
				read += parsed
			case "wbytes":
				write += parsed
			}
		}
	}
	return read, write
}

// parseBlkioServiceBytes sums the Read and Write rows over every device in a
// v1 blkio.throttle.io_service_bytes: "8:0 Read 4096". The trailing "Total"
// row has no device and is skipped by the three-field shape.
func parseBlkioServiceBytes(serviced []byte) (read uint64, write uint64) {
	for _, line := range strings.Split(string(serviced), "\n") {
		fields := strings.Fields(line)
		if len(fields) != 3 {
			continue
		}
		parsed, err := strconv.ParseUint(fields[2], 10, 64)
		if err != nil {
			continue
		}
		switch fields[1] {
		case "Read":
			read += parsed
		case "Write":
			write += parsed
		}
	}
	return read, write
}

// readKeyed parses a flat-keyed cgroup file ("key value" per line).
func readKeyed(path string) (map[string]uint64, error) {
	contents, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", filepath.Base(path), err)
	}
	values := make(map[string]uint64)
	for _, line := range strings.Split(string(contents), "\n") {
		fields := strings.Fields(line)
		if len(fields) != 2 {
			continue
		}
		parsed, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil {
			continue
		}
		values[fields[0]] = parsed
	}
	return values, nil
}

func readUint(path string) (uint64, error) {
	contents, err := os.ReadFile(path)
	if err != nil {
		return 0, fmt.Errorf("read %s: %w", filepath.Base(path), err)
	}
	parsed, err := strconv.ParseUint(strings.TrimSpace(string(contents)), 10, 64)
	if err != nil {
		return 0, fmt.Errorf("malformed %s: %w", filepath.Base(path), err)
	}
	return parsed, nil
}
