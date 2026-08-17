//go:build linux

package firecracker

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"

	"github.com/Fanzzzd/erainfra/apps/runtime/internal/executor"
	"golang.org/x/sys/unix"
)

// hostHardware measures what the Worker can actually offer. Nothing here is
// declared by an operator: a Profile that promises four vCPUs on a host that
// has two is a scheduling bug the control plane must be able to see.
func hostHardware(kvmUsable bool) executor.Hardware {
	hardware := executor.Hardware{
		Arch: runtime.GOARCH,
		CPUs: runtime.NumCPU(),
		KVM:  kvmUsable,
	}
	var info unix.Sysinfo_t
	if err := unix.Sysinfo(&info); err == nil {
		hardware.MemoryMiB = int64(info.Totalram) * int64(info.Unit) / (1024 * 1024)
	}
	hardware.CPUModel, hardware.Virtualization = cpuInfo()
	return hardware
}

// cpuInfo reads the model name and the virtualization extension the host
// advertises. An empty extension on x86 means KVM cannot be hardware accelerated
// even if /dev/kvm happens to exist.
func cpuInfo() (model string, virtualization string) {
	file, err := os.Open("/proc/cpuinfo")
	if err != nil {
		return "", ""
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		key, value, found := strings.Cut(scanner.Text(), ":")
		if !found {
			continue
		}
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		switch key {
		case "model name", "Model":
			if model == "" {
				model = value
			}
		case "flags", "Features":
			for _, flag := range strings.Fields(value) {
				if flag == "vmx" || flag == "svm" {
					virtualization = flag
				}
			}
		}
		if model != "" && virtualization != "" {
			break
		}
	}
	return model, virtualization
}

// thinPoolStorage reports the copy-on-write headroom left in the device-mapper
// thin-pool.
//
// `dmsetup status` prints, for a thin-pool target:
//
//	<start> <length> thin-pool <txn id> <md used>/<md total> <data used>/<data total> ...
//
// The data fraction is what a new Attempt consumes, and <length> is the pool's
// size in 512-byte sectors.
func thinPoolStorage(ctx context.Context, snapshotter string, poolName string) (executor.Storage, error) {
	storage := executor.Storage{Snapshotter: snapshotter, PoolName: poolName}
	output, err := exec.CommandContext(ctx, "dmsetup", "status", poolName).Output()
	if err != nil {
		return storage, fmt.Errorf("read thin-pool %q status: %w", poolName, err)
	}
	fields := strings.Fields(string(output))
	if len(fields) < 6 || fields[2] != "thin-pool" {
		return storage, fmt.Errorf("device %q is not a thin-pool", poolName)
	}
	sectors, err := strconv.ParseInt(fields[1], 10, 64)
	if err != nil {
		return storage, fmt.Errorf("parse thin-pool size: %w", err)
	}
	used, total, err := parseFraction(fields[5])
	if err != nil {
		return storage, fmt.Errorf("parse thin-pool data usage: %w", err)
	}
	if total <= 0 {
		return storage, errors.New("thin-pool reports no data capacity")
	}
	storage.PoolTotalMiB = sectors / 2048
	storage.PoolFreeMiB = storage.PoolTotalMiB * (total - used) / total
	return storage, nil
}

func parseFraction(value string) (int64, int64, error) {
	left, right, found := strings.Cut(value, "/")
	if !found {
		return 0, 0, fmt.Errorf("%q is not a used/total fraction", value)
	}
	used, err := strconv.ParseInt(left, 10, 64)
	if err != nil {
		return 0, 0, err
	}
	total, err := strconv.ParseInt(right, 10, 64)
	if err != nil {
		return 0, 0, err
	}
	return used, total, nil
}
