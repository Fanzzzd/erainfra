package firecracker

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/Fanzzzd/erainfra/apps/runtime/internal/executor"
)

// The control plane places Attempts against the storage a default Worker
// reports, read from this exact file (packages/backend/tests/isolation.test.ts),
// so a field renamed on one side fails a test on the other. Regenerate it with
// ERAINFRA_UPDATE_GOLDEN=1 go test ./apps/runtime/internal/firecracker/.
func TestStorageJSONMatchesTheGoldenFileTheControlPlaneReads(t *testing.T) {
	storage := executor.Storage{
		Snapshotter:    "devmapper",
		PoolName:       DefaultConfig().ThinPoolName,
		PoolTotalMiB:   102_400,
		PoolFreeMiB:    81_920,
		PoolReserveMiB: DefaultConfig().MinPoolFreeMiB,
		// Two live guests, one past its reserve and one that wrote 2 GiB.
		PoolReserveUsedMiB: reserveUsedMiB(
			[]int64{20 << 30, 2 << 30}, DefaultConfig().MinPoolFreeMiB,
		),
	}
	encoded, err := json.MarshalIndent(storage, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	encoded = append(encoded, '\n')
	golden := filepath.Join("testdata", "storage.golden.json")
	if os.Getenv("ERAINFRA_UPDATE_GOLDEN") == "1" {
		if err := os.MkdirAll("testdata", 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(golden, encoded, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(golden)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(encoded, want) {
		t.Fatalf("storage JSON changed; regenerate %s and check the control plane still accepts it:\n%s", golden, encoded)
	}
}
