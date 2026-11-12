package firecracker

import (
	"strings"
	"testing"
)

func TestCheckThinPoolZeroing(t *testing.T) {
	cases := []struct {
		name  string
		table string
		fails string
	}{
		{name: "zeroing on, no features", table: "0 838860800 thin-pool 7:7 7:6 128 32768 0 \n"},
		{name: "zeroing on, other features", table: "0 131072 thin-pool 7:4 7:9 128 1024 1 error_if_no_space"},
		{
			// The table ubuntu0 ran until 2026-11-12, trailing space included.
			name:  "skip_block_zeroing",
			table: "0 838860800 thin-pool 7:7 7:6 128 32768 1 skip_block_zeroing \n",
			fails: "skips zeroing new blocks",
		},
		{
			name:  "skip_block_zeroing among others",
			table: "0 131072 thin-pool 7:4 7:9 128 1024 2 error_if_no_space skip_block_zeroing",
			fails: "skips zeroing new blocks",
		},
		{name: "not a pool", table: "0 131072 thin 253:1 0", fails: "not a thin-pool"},
		{name: "empty", table: "", fails: "not a thin-pool"},
		{
			name:  "feature count beyond the line",
			table: "0 131072 thin-pool 7:4 7:9 128 1024 2 error_if_no_space",
			fails: "malformed feature list",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := checkThinPoolZeroing(tc.table)
			switch {
			case tc.fails == "" && err != nil:
				t.Fatalf("want pass, got %v", err)
			case tc.fails != "" && (err == nil || !strings.Contains(err.Error(), tc.fails)):
				t.Fatalf("want an error containing %q, got %v", tc.fails, err)
			}
		})
	}
}
