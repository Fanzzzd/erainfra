package config

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestLoadReadsWorkerLabelsNormalized(t *testing.T) {
	settings := dedicatedControllerSettings(t)
	settings["WORKER_LABELS"] = " gpu, NVMe ,gpu,,hk "
	cfg := loadWith(t, "ERAINFRA_", settings)
	if want := []string{"gpu", "nvme", "hk"}; !reflect.DeepEqual(cfg.WorkerLabels, want) {
		t.Fatalf("WorkerLabels = %v, want %v", cfg.WorkerLabels, want)
	}
	if err := cfg.Validate(); err != nil {
		t.Fatal(err)
	}
	// The scale set still answers to its own labels only: a pin is not a runs-on label.
	if !reflect.DeepEqual(cfg.Labels, []string{"linux-js", "firecracker"}) {
		t.Fatalf("Labels = %v", cfg.Labels)
	}
}

func TestValidateRefusesABadWorkerLabel(t *testing.T) {
	for _, labels := range [][]string{
		{"has space"},
		{"-leading"},
		{"semi;colon"},
		{strings.Repeat("a", 64)},
		strings.Split("a,b,c,d,e,f,g,h,i,j,k,l,m,n,o,p,q", ","),
	} {
		cfg := validConfig()
		cfg.WorkerLabels = labels
		err := cfg.Validate()
		if err == nil || !strings.Contains(err.Error(), "RC_WORKER_LABELS") {
			t.Errorf("%v: Validate = %v, want an RC_WORKER_LABELS error", labels, err)
		}
	}
}

func TestProfileSpecPublishesWorkerLabelsOnlyWhenPinned(t *testing.T) {
	cfg := validConfig()
	body, err := json.Marshal(cfg.ProfileSpec())
	if err != nil {
		t.Fatal(err)
	}
	// An unpinned Profile sends exactly what it sent before the field existed.
	if strings.Contains(string(body), "workerLabels") {
		t.Fatalf("unpinned spec carries workerLabels: %s", body)
	}

	cfg.WorkerLabels = []string{"gpu"}
	body, err = json.Marshal(cfg.ProfileSpec())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), `"workerLabels":["gpu"]`) {
		t.Fatalf("pinned spec = %s", body)
	}
}

func TestStandbyTakesTheWorkerLabelsFromConvex(t *testing.T) {
	standby := Config{Profile: "erainfra-4vcpu-ubuntu-2404", ConvexURL: "https://example.convex.cloud", MachineToken: strings.Repeat("a", 32)}
	spec := validConfig().ProfileSpec()
	spec.WorkerLabels = []string{"gpu"}
	cfg, err := standby.WithProfile(&spec)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(cfg.WorkerLabels, []string{"gpu"}) {
		t.Fatalf("WorkerLabels = %v", cfg.WorkerLabels)
	}
}
