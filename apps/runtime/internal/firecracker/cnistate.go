package firecracker

import (
	"errors"
	"io/fs"
	"net"
	"os"
	"path/filepath"
	"strings"
)

// The names firecracker-go-sdk derives from a Machine's VMID, which Runner
// Center sets to the Attempt ID. Recovery reconstructs them to release what
// the SDK's own teardown would have released had the runtime not been killed.
const (
	// guestInterfaceName is the interface CNI configures inside the guest's
	// network namespace.
	guestInterfaceName = "eth0"
	// cniCacheRoot is the SDK's default libcni cache directory; the cached ADD
	// result under <root>/<containerID> is what lets a later DEL tear down the
	// firewall and masquerade rules the plugins created.
	cniCacheRoot = "/var/lib/cni"
	// netNSDir is where the SDK mounts each VM's network namespace.
	netNSDir = "/var/run/netns"
)

// A cniReservation is one address file written by the host-local IPAM plugin
// under the network's data directory: the file is named after the allocated
// IP and its first line is the owning container ID — for EraInfra, the
// Attempt ID.
type cniReservation struct {
	IP          string
	ContainerID string
	Path        string
}

// reservationDir is where host-local records this network's allocations:
// dataDir from the rendered conflist, plus the network name.
func reservationDir(dataDir, networkName string) string {
	return filepath.Join(dataDir, networkName)
}

// readReservations lists the addresses currently reserved for guests.
//
// The directory also holds host-local's bookkeeping ("lock",
// "last_reserved_ip.<range>"); only entries whose name parses as an IP are
// reservations. A file that cannot be read or holds no container ID is still
// reported — it occupies an address either way — with an empty ContainerID.
func readReservations(dir string) ([]cniReservation, error) {
	entries, err := os.ReadDir(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var reservations []cniReservation
	for _, entry := range entries {
		if entry.IsDir() || net.ParseIP(entry.Name()) == nil {
			continue
		}
		reservation := cniReservation{
			IP:   entry.Name(),
			Path: filepath.Join(dir, entry.Name()),
		}
		// host-local writes "<containerID>\r\n<ifname>".
		if content, readErr := os.ReadFile(reservation.Path); readErr == nil {
			id, _, _ := strings.Cut(string(content), "\n")
			reservation.ContainerID = strings.TrimSpace(id)
		}
		reservations = append(reservations, reservation)
	}
	return reservations, nil
}
