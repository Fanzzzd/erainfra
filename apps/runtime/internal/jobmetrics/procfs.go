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

// userHZ is the unit of utime and stime in /proc/<pid>/stat. It is part of
// the kernel ABI, fixed at 100 on every architecture Linux exposes to user
// space whatever CONFIG_HZ the kernel was built with, which is why Go has no
// sysconf(_SC_CLK_TCK) call and does not need one here.
const userHZ = 100

// VMMSource reads one Firecracker microVM from the outside: the VMM process's
// own kernel accounting, its tap device, and the serial console the host
// captures.
//
// The VMM is the guest as far as the host kernel is concerned. Its utime and
// stime are every vCPU thread plus device emulation; its resident set is the
// guest memory the host has had to back; its block I/O is the root drive's
// traffic, since Firecracker serves the drive from this process. None of it
// passes through the guest.
type VMMSource struct {
	// ProcRoot is /proc, or a fixture directory in tests.
	ProcRoot string
	PID      int
	// TapName is the tap device the VMM attaches to. It lives in the VM's
	// network namespace, not the host's, so it is read through the VMM's own
	// /proc/<pid>/net/dev rather than /sys/class/net. Empty leaves network
	// unmeasured.
	TapName string
	// Console is the guest's serial console log, scanned for the kernel's
	// out-of-memory lines. Nil leaves OOM kills unknown.
	Console *ConsoleOOMScanner
}

func (s *VMMSource) Kind() string { return "firecracker-vmm" }

func (s *VMMSource) Read(now time.Time) (Reading, error) {
	dir := filepath.Join(s.ProcRoot, strconv.Itoa(s.PID))
	if processGone(dir) {
		return Reading{}, ErrGone
	}
	reading := Reading{At: now}
	stat, err := os.ReadFile(filepath.Join(dir, "stat"))
	if err != nil {
		return Reading{}, fmt.Errorf("read VMM stat: %w", err)
	}
	ticks, err := parseProcStatCPUTicks(stat)
	if err != nil {
		return Reading{}, err
	}
	reading.CPUMicros = ticks * (1_000_000 / userHZ)

	status, err := os.ReadFile(filepath.Join(dir, "status"))
	if err != nil {
		return Reading{}, fmt.Errorf("read VMM status: %w", err)
	}
	reading.MemoryBytes, reading.MemoryPeakBytes, err = parseProcStatusMemory(status)
	if err != nil {
		return Reading{}, err
	}

	// /proc/<pid>/io needs ptrace-read access to the VMM, which the root
	// runtime has. A missing file costs the disk numbers, not the reading.
	if io, err := os.ReadFile(filepath.Join(dir, "io")); err == nil {
		if read, write, err := parseProcIO(io); err == nil {
			reading.HasDisk = true
			reading.DiskReadBytes, reading.DiskWriteBytes = read, write
		}
	}

	if s.TapName != "" {
		if netdev, err := os.ReadFile(filepath.Join(dir, "net", "dev")); err == nil {
			if counters, err := ParseNetDev(netdev); err == nil {
				if tap, ok := counters[s.TapName]; ok {
					// A tap's counters are the host's side of the wire: what the
					// host wrote to it is what the guest received, and what the
					// guest sent arrives as the tap's receive. Swap them so every
					// executor reports traffic from the job's point of view.
					reading.HasNetwork = true
					reading.NetRxBytes = tap.TxBytes
					reading.NetTxBytes = tap.RxBytes
				}
			}
		}
	}

	if s.Console != nil {
		if kills, err := s.Console.Scan(); err == nil {
			reading.HasOOM = true
			reading.OOMKills = kills
		}
	}
	return reading, nil
}

// parseProcStatCPUTicks returns utime + stime from /proc/<pid>/stat, summed
// over every thread of the process. The command name in field 2 may contain
// spaces and parentheses, so fields are counted from the last ')'.
func parseProcStatCPUTicks(stat []byte) (uint64, error) {
	end := bytes.LastIndexByte(stat, ')')
	if end < 0 {
		return 0, errors.New("malformed /proc stat: no command name")
	}
	fields := strings.Fields(string(stat[end+1:]))
	// fields[0] is field 3 (state); utime and stime are fields 14 and 15.
	if len(fields) < 13 {
		return 0, errors.New("malformed /proc stat: too few fields")
	}
	utime, err := strconv.ParseUint(fields[11], 10, 64)
	if err != nil {
		return 0, fmt.Errorf("malformed /proc stat utime: %w", err)
	}
	stime, err := strconv.ParseUint(fields[12], 10, 64)
	if err != nil {
		return 0, fmt.Errorf("malformed /proc stat stime: %w", err)
	}
	return utime + stime, nil
}

// parseProcStatusMemory returns VmRSS and VmHWM, the resident set and its
// high-water mark, in bytes.
func parseProcStatusMemory(status []byte) (rss uint64, hwm uint64, err error) {
	var haveRSS bool
	scanner := bufio.NewScanner(bytes.NewReader(status))
	for scanner.Scan() {
		key, value, ok := strings.Cut(scanner.Text(), ":")
		if !ok || (key != "VmRSS" && key != "VmHWM") {
			continue
		}
		fields := strings.Fields(value)
		if len(fields) != 2 || fields[1] != "kB" {
			return 0, 0, fmt.Errorf("malformed /proc status %s: %q", key, value)
		}
		kib, parseErr := strconv.ParseUint(fields[0], 10, 64)
		if parseErr != nil {
			return 0, 0, fmt.Errorf("malformed /proc status %s: %w", key, parseErr)
		}
		if key == "VmRSS" {
			rss, haveRSS = kib*1024, true
		} else {
			hwm = kib * 1024
		}
	}
	if !haveRSS {
		return 0, 0, errors.New("/proc status has no VmRSS; the process has exited")
	}
	return rss, hwm, nil
}

// parseProcIO returns read_bytes and write_bytes: bytes the process caused to
// be fetched from, and dirtied for, the storage layer. rchar and wchar are not
// used: they count every read(2) and write(2), including the ones the page
// cache answered, which is not the device traffic a disk chart should show.
// The kernel sums both fields over every thread of the process, so io_uring
// worker threads serving the root drive are included.
func parseProcIO(io []byte) (read uint64, write uint64, err error) {
	var haveRead, haveWrite bool
	scanner := bufio.NewScanner(bytes.NewReader(io))
	for scanner.Scan() {
		key, value, ok := strings.Cut(scanner.Text(), ":")
		if !ok {
			continue
		}
		parsed, parseErr := strconv.ParseUint(strings.TrimSpace(value), 10, 64)
		switch key {
		case "read_bytes":
			read, haveRead, err = parsed, true, parseErr
		case "write_bytes":
			write, haveWrite, err = parsed, true, parseErr
		default:
			continue
		}
		if err != nil {
			return 0, 0, fmt.Errorf("malformed /proc io %s: %w", key, err)
		}
	}
	if !haveRead || !haveWrite {
		return 0, 0, errors.New("/proc io has no read_bytes/write_bytes")
	}
	return read, write, nil
}

// InterfaceCounters is one row of /proc/net/dev.
type InterfaceCounters struct {
	RxBytes uint64
	TxBytes uint64
}

// ParseNetDev reads /proc/<pid>/net/dev, which lists the interfaces of that
// process's network namespace. Reading it through a process is what makes a
// container's eth0 or a microVM's tap visible from the host namespace.
func ParseNetDev(netdev []byte) (map[string]InterfaceCounters, error) {
	counters := make(map[string]InterfaceCounters)
	scanner := bufio.NewScanner(bytes.NewReader(netdev))
	for scanner.Scan() {
		name, rest, ok := strings.Cut(scanner.Text(), ":")
		if !ok {
			continue
		}
		name = strings.TrimSpace(name)
		if strings.Contains(name, "|") {
			continue // a header line
		}
		fields := strings.Fields(rest)
		if len(fields) < 16 {
			return nil, fmt.Errorf("malformed net/dev row for %s", name)
		}
		rx, err := strconv.ParseUint(fields[0], 10, 64)
		if err != nil {
			return nil, fmt.Errorf("malformed net/dev rx for %s: %w", name, err)
		}
		tx, err := strconv.ParseUint(fields[8], 10, 64)
		if err != nil {
			return nil, fmt.Errorf("malformed net/dev tx for %s: %w", name, err)
		}
		counters[name] = InterfaceCounters{RxBytes: rx, TxBytes: tx}
	}
	return counters, scanner.Err()
}
