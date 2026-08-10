package executor

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestReportIsReadyOnlyWhenEveryCheckPassed(t *testing.T) {
	var report Report
	if report.Ready() {
		t.Fatal("a Worker that ran no checks must not be advertised as ready")
	}

	report.Pass(CheckKVM, "/dev/kvm")
	report.Pass(CheckNetPolicy, "denied")
	if !report.Ready() {
		t.Fatal("a report whose checks all passed must be ready")
	}

	report.Fail(CheckStorage, errors.New("thin-pool is full"))
	if report.Ready() {
		t.Fatal("one failed check must withdraw readiness entirely")
	}
}

func TestFailureSummaryNamesEveryBrokenPrerequisite(t *testing.T) {
	var report Report
	report.Pass(CheckKVM, "/dev/kvm")
	report.Fail(CheckCNIPlugins, errors.New("tc-redirect-tap missing"))
	report.Fail(CheckNetPolicy, errors.New("east-west drop removed"))

	summary := report.FailureSummary()
	for _, expected := range []string{
		CheckCNIPlugins,
		"tc-redirect-tap missing",
		CheckNetPolicy,
		"east-west drop removed",
	} {
		if !strings.Contains(summary, expected) {
			t.Fatalf("summary %q does not mention %q", summary, expected)
		}
	}
	if strings.Contains(summary, CheckKVM) {
		t.Fatalf("summary %q should not mention a check that passed", summary)
	}
	if new(Report).FailureSummary() != "" {
		t.Fatal("a report with no failures must summarize to nothing")
	}
}

func TestReportSurvivesJSONRoundTrip(t *testing.T) {
	report := Report{
		Isolation: IsolationFirecracker,
		Boundary:  BoundaryGuestKernel,
		Hardware:  Hardware{Arch: "amd64", CPUs: 64, MemoryMiB: 257_000, KVM: true, Virtualization: "vmx"},
		Storage:   Storage{Snapshotter: "devmapper", PoolTotalMiB: 51_200, PoolFreeMiB: 40_960},
		Network:   Network{PolicyName: "runner-center", Subnet: "10.241.0.0/16", EgressMode: "public"},
		Cache:     Cache{Scope: "immutable-image", SharedWritable: false},
	}
	report.Pass(CheckKVM, "/dev/kvm")

	encoded, err := json.Marshal(report)
	if err != nil {
		t.Fatalf("encode report: %v", err)
	}
	var decoded Report
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("decode report: %v", err)
	}
	if !decoded.Ready() || decoded.Boundary != BoundaryGuestKernel || decoded.Hardware.CPUs != 64 {
		t.Fatalf("report did not survive the control-plane hop: %+v", decoded)
	}
	if decoded.Cache.SharedWritable {
		t.Fatal("cache sharing must not be lost in transport; it is a security claim")
	}
}
