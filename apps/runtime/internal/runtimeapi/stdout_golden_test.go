package runtimeapi

import (
	"bytes"
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Fanzzzd/erainfra/apps/runtime/internal/executor"
	"github.com/Fanzzzd/erainfra/apps/runtime/internal/netpolicy"
	"github.com/Fanzzzd/erainfra/internal/golden"
)

// The Action Runner Agent parses what `runner-center-runtime preflight` and
// `prune-images` print. Each test sends a document through the service's
// handler and client and prints it with WriteDocument, as the command does.
// The Agent's tests read the files: readiness.test.ts for the preflight report
// and image-prune.test.ts for the prune result. `prepare`, `admission` and
// `sample` have goldens next to their producers. Regenerate them with
// ERAINFRA_UPDATE_GOLDEN=1 go test ./apps/runtime/internal/runtimeapi/.

// reportExecutor answers preflight with a fixed Report.
type reportExecutor struct {
	*fakeExecutor
	report executor.Report
}

func (r *reportExecutor) Preflight(context.Context, netpolicy.ProfileEgress) (executor.Report, error) {
	return r.report, nil
}

// TestPreflightOutputMatchesTheGoldenFileTheAgentReads records the report of
// a ready Firecracker Worker serving an allowlist Profile on a host with an
// allowed LAN destination.
func TestPreflightOutputMatchesTheGoldenFileTheAgentReads(t *testing.T) {
	report := executor.Report{
		Isolation: executor.IsolationFirecracker,
		Boundary:  executor.BoundaryGuestKernel,
		Hardware: executor.Hardware{
			Arch: "amd64", CPUs: 32, MemoryMiB: 128_000,
			CPUModel: "AMD EPYC 7543 32-Core Processor", Virtualization: "AMD-V", KVM: true,
		},
		Storage: executor.Storage{
			Snapshotter: "devmapper", PoolName: "runner-center-thinpool",
			PoolTotalMiB: 102_400, PoolFreeMiB: 81_920, PoolReserveMiB: 4_096, PoolReserveUsedMiB: 1_024,
		},
		Network: executor.Network{
			PolicyName:          "runner-center",
			PolicyHash:          "sha256:" + strings.Repeat("d", 64),
			Subnet:              "10.241.0.0/16",
			EgressMode:          "allowlist",
			AllowedDestinations: []string{"192.168.50.10/32"},
			Egress: &executor.Egress{
				Mode: "allowlist", HostMode: "public", ProfileMode: "allowlist",
				Presets: []string{"github"}, Domains: []string{"registry.example.com"},
				CIDRs: []string{"203.0.113.0/24"}, AllowedDomainCount: 20,
			},
		},
		Cache: executor.Cache{Scope: "immutable-image", SharedWritable: false},
	}
	report.Pass(executor.CheckKVM, "/dev/kvm is usable")
	report.Pass(executor.CheckNetPolicy, "runner-center policy loaded")
	report.Pass(executor.CheckStorage, "81920 MiB free")

	got, err := unixClient(t, &reportExecutor{fakeExecutor: &fakeExecutor{}, report: report}).
		Preflight(t.Context(), netpolicy.ProfileEgress{})
	if err != nil {
		t.Fatal(err)
	}
	var stdout bytes.Buffer
	if err := WriteDocument(&stdout, got); err != nil {
		t.Fatal(err)
	}
	golden.Check(
		t,
		filepath.Join("testdata", "preflight.golden.json"),
		stdout.Bytes(),
		"the Action Runner Agent's readiness tests",
	)
}

func TestPruneImagesOutputMatchesTheGoldenFileTheAgentReads(t *testing.T) {
	current := "ghcr.io/fanzzzd/runner-center-ubuntu-24.04-full@sha256:" + strings.Repeat("7", 64)
	got, err := unixClient(t, &pruningExecutor{fakeExecutor: &fakeExecutor{}}).
		PruneImages(t.Context(), []string{current})
	if err != nil {
		t.Fatal(err)
	}
	var stdout bytes.Buffer
	if err := WriteDocument(&stdout, got); err != nil {
		t.Fatal(err)
	}
	golden.Check(
		t,
		filepath.Join("testdata", "prune-images.golden.json"),
		stdout.Bytes(),
		"the Action Runner Agent's image prune tests",
	)
}
