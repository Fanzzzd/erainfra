package firecracker

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/firecracker-microvm/firecracker-go-sdk/client/models"
)

// asyncIoEngineKernelFloor is the oldest host kernel on which Firecracker's
// Async block engine (io_uring) is supported. Below it Firecracker refuses the
// drive at boot, so the choice has to be made host-side and reported, not
// configured.
var asyncIoEngineKernelFloor = kernelVersion{major: 5, minor: 10, patch: 51}

type kernelVersion struct {
	major, minor, patch int
}

func (v kernelVersion) String() string {
	return fmt.Sprintf("%d.%d.%d", v.major, v.minor, v.patch)
}

func (v kernelVersion) atLeast(floor kernelVersion) bool {
	if v.major != floor.major {
		return v.major > floor.major
	}
	if v.minor != floor.minor {
		return v.minor > floor.minor
	}
	return v.patch >= floor.patch
}

// parseKernelRelease reads the numeric prefix of a uname release such as
// "5.4.0-216-generic", "6.1.141" or "5.10.51+". A missing patch component is
// zero; anything that does not start with major.minor is not a version.
func parseKernelRelease(release string) (kernelVersion, bool) {
	numeric := strings.TrimSpace(release)
	if end := strings.IndexFunc(numeric, func(r rune) bool {
		return (r < '0' || r > '9') && r != '.'
	}); end >= 0 {
		numeric = numeric[:end]
	}
	parts := strings.Split(numeric, ".")
	if len(parts) < 2 || len(parts) > 3 {
		return kernelVersion{}, false
	}
	var fields [3]int
	for i, part := range parts {
		value, err := strconv.Atoi(part)
		if err != nil || value < 0 {
			return kernelVersion{}, false
		}
		fields[i] = value
	}
	return kernelVersion{major: fields[0], minor: fields[1], patch: fields[2]}, true
}

// rootfsIoEngine picks the block engine for the guest's root drive from the
// host kernel release and says why, in one line an operator can read off the
// readiness report. Async is the throughput engine and the default wherever the
// host kernel allows it; Sync is the fallback that keeps an older host admitting
// jobs instead of failing every boot.
func rootfsIoEngine(hostKernelRelease string) (engine string, detail string) {
	version, ok := parseKernelRelease(hostKernelRelease)
	switch {
	case !ok:
		return models.DriveIoEngineSync, fmt.Sprintf(
			"Sync: host kernel release %q is not a version, so the io_uring floor %s cannot be checked",
			hostKernelRelease, asyncIoEngineKernelFloor,
		)
	case !version.atLeast(asyncIoEngineKernelFloor):
		return models.DriveIoEngineSync, fmt.Sprintf(
			"Sync: host kernel %s is below %s, the floor for Firecracker's io_uring engine",
			version, asyncIoEngineKernelFloor,
		)
	default:
		return models.DriveIoEngineAsync, fmt.Sprintf(
			"Async (io_uring): host kernel %s meets the %s floor",
			version, asyncIoEngineKernelFloor,
		)
	}
}
