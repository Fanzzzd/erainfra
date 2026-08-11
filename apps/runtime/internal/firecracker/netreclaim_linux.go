//go:build linux

package firecracker

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/Fanzzzd/runner-center/apps/runtime/internal/netpolicy"
	"github.com/containernetworking/cni/libcni"
	"golang.org/x/sys/unix"
)

// reclaimNetwork releases every guest address reservation left in this
// Profile's network, together with the iptables rules and network namespace
// each one carried.
//
// Only Recover may call it: it assumes no guest is running, which Recover
// guarantees by holding the single-daemon lock after destroying every lease.
// The release normally happens inside firecracker-go-sdk's teardown, which
// never runs when systemd kills the runtime's control group, so a restarted
// Worker would otherwise lose one address from the guest subnet per Attempt
// that was live at the kill — unbounded, and host-local eventually refuses to
// allocate (#24).
//
// The real CNI DEL is the right tool, not raw file deletion: with the SDK's
// cached ADD result the firewall and ptp plugins remove their own iptables
// rules, and host-local frees the address. Files are removed by hand only as
// the backstop when a DEL fails, because a stale rule is bounded clutter but
// a stale reservation is a permanently lost address.
func (r *Runtime) reclaimNetwork(ctx context.Context) error {
	reservations, err := readReservations(
		reservationDir(netpolicy.CNIDataDir, r.config.Network.Name),
	)
	if err != nil {
		return fmt.Errorf("list guest address reservations: %w", err)
	}
	if len(reservations) == 0 {
		return nil
	}
	var cleanupErrors []error
	networkConf, err := libcni.LoadConfList(r.config.CNIConfigDir, r.config.Network.Name)
	if err != nil {
		// Without the conflist no plugin can run; removing the files still
		// reclaims the addresses, which is the unbounded half of the leak.
		cleanupErrors = append(cleanupErrors, fmt.Errorf("load CNI network for recovery: %w", err))
	}
	for _, reservation := range reservations {
		if networkConf != nil && reservation.ContainerID != "" {
			cacheDir := filepath.Join(cniCacheRoot, reservation.ContainerID)
			plugin := libcni.NewCNIConfigWithCacheDir([]string{r.config.CNIBinDir}, cacheDir, nil)
			runtimeConf := &libcni.RuntimeConf{
				ContainerID: reservation.ContainerID,
				NetNS:       filepath.Join(netNSDir, reservation.ContainerID),
				IfName:      guestInterfaceName,
			}
			if err := plugin.DelNetworkList(ctx, networkConf, runtimeConf); err != nil {
				cleanupErrors = append(cleanupErrors, fmt.Errorf(
					"release guest network for %s: %w", reservation.ContainerID, err,
				))
			}
			if err := os.RemoveAll(cacheDir); err != nil {
				cleanupErrors = append(cleanupErrors, err)
			}
			removeNetNS(filepath.Join(netNSDir, reservation.ContainerID))
		}
		// Whatever the plugins managed, the reservation itself must not
		// survive recovery: no guest is running, so no reservation is owned.
		if err := os.Remove(reservation.Path); err != nil && !errors.Is(err, os.ErrNotExist) {
			cleanupErrors = append(cleanupErrors, fmt.Errorf(
				"remove stale address reservation %s: %w", reservation.IP, err,
			))
		}
	}
	return errors.Join(cleanupErrors...)
}

// removeNetNS undoes the SDK's netns mount for one VM. Best-effort: the
// namespace may already be gone, and a leftover mount point is harmless next
// to a leaked address.
func removeNetNS(path string) {
	_ = unix.Unmount(path, unix.MNT_DETACH)
	_ = os.Remove(path)
}
