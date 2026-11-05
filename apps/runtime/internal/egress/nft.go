package egress

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os/exec"
	"strings"

	"github.com/Fanzzzd/erainfra/apps/runtime/internal/netpolicy"
)

// NftApplier drives the kernel through the nft binary, the same one Preflight
// lists the live table with. A batch on stdin is one netlink transaction, which
// is what makes "add, delete, add" an atomic timeout refresh; doing this over a
// netlink library instead would mean re-deriving nft's concatenated-key
// encoding by hand for no gain at the rate a job resolves names.
type NftApplier struct {
	Binary string
}

func (n NftApplier) Apply(ctx context.Context, batch string) error {
	if strings.TrimSpace(batch) == "" {
		return nil
	}
	command := exec.CommandContext(ctx, n.Binary, "-f", "-")
	command.Stdin = strings.NewReader(batch)
	if output, err := command.CombinedOutput(); err != nil {
		return fmt.Errorf("nft: %s: %w", strings.TrimSpace(string(output)), err)
	}
	return nil
}

func (n NftApplier) ListSet(ctx context.Context, set string) ([]byte, error) {
	output, err := exec.CommandContext(
		ctx, n.Binary, "--json", "list", "set", "inet", netpolicy.TableName, set,
	).Output()
	if err != nil {
		var exitError *exec.ExitError
		if errors.As(err, &exitError) && len(exitError.Stderr) > 0 {
			return nil, fmt.Errorf("list nftables set %s: %s", set, strings.TrimSpace(string(exitError.Stderr)))
		}
		return nil, fmt.Errorf("list nftables set %s: %w", set, err)
	}
	return output, nil
}

// Listen opens the resolver's UDP and TCP sockets on address. control lets
// the Linux build bind the guest gateway address before any guest link holds
// it; see listen_linux.go.
func Listen(ctx context.Context, address string) (net.PacketConn, net.Listener, error) {
	config := net.ListenConfig{Control: listenControl}
	packet, err := config.ListenPacket(ctx, "udp4", address)
	if err != nil {
		return nil, nil, fmt.Errorf("listen for guest DNS on udp %s: %w", address, err)
	}
	stream, err := config.Listen(ctx, "tcp4", address)
	if err != nil {
		_ = packet.Close()
		return nil, nil, fmt.Errorf("listen for guest DNS on tcp %s: %w", address, err)
	}
	return packet, stream, nil
}
