//go:build linux

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

// Lazy writeback.
//
// The root drive is a per-Attempt thin snapshot that the runtime deletes when
// the VM ends, so a page the guest writes back to it is disk traffic nobody
// reads. On a Worker whose pool shares one disk, that traffic is what slows
// the other guests: a 4 vCPU job writing a cold pnpm store (about 2.5 GiB)
// raised ubuntu0's io pressure to 42 %, and a read stuck behind such writes
// took 15.4 s against 1.4 s a moment later (PR #351, run 43278982420).
//
// The kernel defaults start writeback at 10 % of memory and expire dirty
// pages after 30 s. These values keep a job's writes in the guest's page cache
// instead: writeback starts at half of memory, a writer is throttled only at
// 80 %, and a page waits an hour before age alone sends it to disk. The same
// probe measured 102 MiB written to the drive instead of 9015 MiB, and the
// host's io pressure stayed under 5 %. Memory pressure still writes pages back
// as it always does, so a job that writes more than memory holds runs as it
// did before rather than failing: no space limit, unlike a tmpfs.
var lazyWriteback = []struct {
	name  string
	value string
}{
	// dirty_ratio first: the kernel clamps a background ratio above it.
	{"dirty_ratio", "80"},
	{"dirty_background_ratio", "50"},
	{"dirty_expire_centisecs", "360000"},
	{"dirty_writeback_centisecs", "6000"},
}

const procSysVM = "/proc/sys/vm"

// configureLazyWriteback writes lazyWriteback under vmDir, normally
// /proc/sys/vm. It stops at the first failure and names the setting.
func configureLazyWriteback(vmDir string) error {
	for _, setting := range lazyWriteback {
		if err := writeExisting(filepath.Join(vmDir, setting.name), setting.value+"\n"); err != nil {
			return fmt.Errorf("set vm.%s=%s: %w", setting.name, setting.value, err)
		}
	}
	return nil
}

// writeExisting writes value to a file that must already exist, as every
// /proc/sys entry does, so a wrong path fails instead of creating a file.
func writeExisting(path, value string) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_TRUNC, 0)
	if err != nil {
		return err
	}
	if _, err := file.WriteString(value); err != nil {
		file.Close() //nolint:errcheck // the write error is the one to report
		return err
	}
	return file.Close()
}

// resetWithoutSync ends the VM with the reboot system call. It skips the
// sync and the unmount that `systemctl reboot` performs, which would write
// every dirty page to a snapshot about to be deleted: with lazy writeback
// that is gigabytes, all of it competing with the other guests' reads. The
// runner has exited and its results are reported before this runs. With
// reboot=k on the kernel command line, the reset pulses the i8042 line and
// Firecracker exits.
func resetWithoutSync() error {
	return syscall.Reboot(syscall.LINUX_REBOOT_CMD_RESTART)
}
