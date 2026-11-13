package firecracker

import (
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/Fanzzzd/erainfra/apps/runtime/internal/executor"
	"github.com/Fanzzzd/erainfra/internal/golden"
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
	golden.Check(t, filepath.Join("testdata", "storage.golden.json"), encoded, "the control plane's tests")
}
