package firecracker

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// checkThinPoolZeroing checks the thin pool's `dmsetup table` line and returns
// an error when the pool hands out new blocks without zeroing them.
//
// The pool allocates 64 KiB blocks. A guest that writes part of a newly
// provisioned block can read the rest of it, and with skip_block_zeroing the
// rest still holds whatever an earlier Attempt wrote there before its snapshot
// was deleted. Zeroing is what keeps "nothing writable survives an Attempt"
// (ADR 0002) true at the block layer. Discard is not a substitute: a discarded
// block is not guaranteed to read back as zeroes.
//
// A thin-pool table line is:
//
//	<start> <length> thin-pool <metadata dev> <data dev> <block size> <low water mark> <#features> [<feature>...]
func checkThinPoolZeroing(table string) error {
	fields := strings.Fields(table)
	if len(fields) < 8 || fields[2] != "thin-pool" {
		return fmt.Errorf("%q is not a thin-pool table line", strings.TrimSpace(table))
	}
	count, err := strconv.Atoi(fields[7])
	if err != nil || count < 0 || len(fields) < 8+count {
		return fmt.Errorf("thin-pool table line has a malformed feature list: %q", strings.TrimSpace(table))
	}
	for _, feature := range fields[8 : 8+count] {
		if feature == "skip_block_zeroing" {
			return errors.New(
				"thin-pool skips zeroing new blocks, so a guest can read data an earlier Attempt left in them; " +
					"reload the pool table without skip_block_zeroing",
			)
		}
	}
	return nil
}
