package firecracker

import (
	"os"
	"path/filepath"
	"testing"
)

// The fixture mirrors what host-local actually writes on a Worker: one file
// per allocated IP whose content is "<containerID>\r\n<ifname>", next to its
// own bookkeeping files, under <dataDir>/<network-name>/.
func writeReservationDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	for name, content := range map[string]string{
		"10.241.0.27":         "attempt-a\r\neth0",
		"10.241.0.28":         "attempt-b\r\neth0",
		"last_reserved_ip.0":  "10.241.0.28",
		"lock":                "",
		"not-an-address.conf": "unrelated",
	} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func TestReadReservationsParsesOnlyAddressFiles(t *testing.T) {
	reservations, err := readReservations(writeReservationDir(t))
	if err != nil {
		t.Fatal(err)
	}
	if len(reservations) != 2 {
		t.Fatalf(
			"want the 2 address files, not host-local's bookkeeping; got %d: %v",
			len(reservations), reservations,
		)
	}
	byIP := map[string]string{}
	for _, reservation := range reservations {
		byIP[reservation.IP] = reservation.ContainerID
	}
	// The container ID is the Attempt ID, and it must survive host-local's
	// CRLF line ending: a trailing \r would break the CNI DEL and the netns
	// path derived from it.
	if byIP["10.241.0.27"] != "attempt-a" || byIP["10.241.0.28"] != "attempt-b" {
		t.Fatalf("reservations misparsed: %v", byIP)
	}
}

func TestReadReservationsToleratesAFreshHost(t *testing.T) {
	// Before the first Attempt the network directory does not exist. That is
	// not an error, and it must not fail recovery or readiness.
	reservations, err := readReservations(filepath.Join(t.TempDir(), "never", "created"))
	if err != nil {
		t.Fatal(err)
	}
	if len(reservations) != 0 {
		t.Fatalf("a missing directory holds no reservations, got %v", reservations)
	}
}

func TestReadReservationsReportsAnUnreadableOwner(t *testing.T) {
	// A reservation whose container ID cannot be recovered still occupies an
	// address. It must be listed — recovery deletes the file even when it
	// cannot run a CNI DEL for it — never silently skipped.
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "10.241.0.40"), []byte("\r\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	reservations, err := readReservations(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(reservations) != 1 || reservations[0].ContainerID != "" {
		t.Fatalf("want one ownerless reservation, got %v", reservations)
	}
}

func TestReservationDirFollowsTheRenderedConflist(t *testing.T) {
	// The recovery path and the ptp plugin must look at the same directory:
	// host-local appends the network name to the dataDir from the conflist.
	if got := reservationDir("/var/lib/runner-center/cni/networks", "runner-center"); got !=
		"/var/lib/runner-center/cni/networks/runner-center" {
		t.Fatalf("unexpected reservation directory %q", got)
	}
}
