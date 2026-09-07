package firecracker

import (
	"strings"
	"testing"

	"github.com/firecracker-microvm/firecracker-go-sdk/client/models"
)

func TestRootfsIoEngineFollowsTheHostKernelFloor(t *testing.T) {
	cases := []struct {
		release string
		engine  string
	}{
		// ubuntu0 today: Ubuntu 20.04 GA kernel.
		{"5.4.0-216-generic", models.DriveIoEngineSync},
		// One patch below the floor still cannot use io_uring.
		{"5.10.50", models.DriveIoEngineSync},
		{"5.10.51", models.DriveIoEngineAsync},
		{"5.10.51+", models.DriveIoEngineAsync},
		// Ubuntu 20.04 HWE and 22.04 GA kernels.
		{"5.15.0-1071-generic", models.DriveIoEngineAsync},
		// The guest kernel line, as a host would report it.
		{"6.1.141", models.DriveIoEngineAsync},
		// Major alone outranks minor and patch.
		{"6.0.0", models.DriveIoEngineAsync},
		{"4.19.300", models.DriveIoEngineSync},
	}
	for _, c := range cases {
		engine, detail := rootfsIoEngine(c.release)
		if engine != c.engine {
			t.Errorf("%q: want %s, got %s (%s)", c.release, c.engine, engine, detail)
		}
		if !strings.HasPrefix(detail, engine) {
			t.Errorf("%q: the detail must lead with the engine so the report reads at a glance, got %q", c.release, detail)
		}
		if !strings.Contains(detail, asyncIoEngineKernelFloor.String()) {
			t.Errorf("%q: the detail must name the floor an operator would upgrade to, got %q", c.release, detail)
		}
	}
}

func TestRootfsIoEngineFallsBackToSyncOnAnUnreadableRelease(t *testing.T) {
	for _, release := range []string{"", "generic", "5", "-1.2.3", "5.x.1"} {
		engine, detail := rootfsIoEngine(release)
		if engine != models.DriveIoEngineSync {
			t.Errorf("%q: an unparseable release must not enable io_uring, got %s", release, engine)
		}
		if !strings.Contains(detail, "not a version") {
			t.Errorf("%q: the detail must say the release was unreadable, got %q", release, detail)
		}
	}
}

func TestParseKernelReleaseReadsOnlyTheNumericPrefix(t *testing.T) {
	cases := map[string]kernelVersion{
		"5.4.0-216-generic":   {5, 4, 0},
		"5.15.0-1071-generic": {5, 15, 0},
		"6.1.141":             {6, 1, 141},
		"5.10":                {5, 10, 0},
		"6.8.0-45-generic ":   {6, 8, 0},
	}
	for release, want := range cases {
		got, ok := parseKernelRelease(release)
		if !ok || got != want {
			t.Errorf("%q: want %v, got %v (ok=%v)", release, want, got, ok)
		}
	}
	for _, release := range []string{"5.4.0.1", "a.b", "5", ""} {
		if _, ok := parseKernelRelease(release); ok {
			t.Errorf("%q must not parse as a kernel version", release)
		}
	}
}
