// Package hostspin pins one hostname to one address in a hosts file, and takes
// the pin back out, without touching any line it did not write.
//
// It is how the guest points GitHub's cache host at its in-guest interceptor
// (ADR 0008 §1). The pin is a name, not a packet rule, for three reasons
// measured against the guest this runs in:
//
//   - The pinned Firecracker guest kernel has no xt_owner, xt_mark or
//     xt_cgroup and no module loading, so an iptables rule cannot tell the
//     interceptor's own upstream connection from a client's. A name pin needs
//     no such match: the interceptor reaches GitHub through a resolver that
//     never reads this file.
//   - The cache host is a CNAME onto a GitHub load balancer whose A record has
//     a TTL under a minute and rotates between addresses. A rule written for
//     the addresses seen at boot misses the next one a client resolves; a name
//     pin cannot be outrun.
//   - Every Docker container has its own hosts file, so the pin reaches a
//     container only where the guest writes it, which is only where the guest
//     has verified the container trusts the interceptor's CA (see
//     guestdocker). A packet rule reaches every container whether it trusts
//     the CA or not, and a container that does not would fail TLS instead of
//     reaching GitHub.
//
// Files are rewritten in place, never replaced by rename. Docker bind-mounts a
// container's hosts file by inode, so a renamed replacement would never be
// seen inside the container.
package hostspin

import (
	"bytes"
	"errors"
	"fmt"
	"net"
	"os"
	"strings"
)

// Marker ends every line this package writes. A line is ours if and only if
// it ends with it, so removing the pin never removes an operator's or a job's
// own entry, and a copy of the guest's file that Docker made for a
// host-network container carries the marker with it and can be cleaned the
// same way.
const Marker = "# erainfra-cache-interceptor"

// ErrClaimedByOther means the file already maps the host with a line this
// package did not write: a job's own --add-host, or an operator's entry. The
// pin defers to it rather than overriding a decision someone made on purpose.
var ErrClaimedByOther = errors.New("hosts file already maps the name with an entry erainfra did not write")

// Line is the exact text a pin adds.
func Line(addr net.IP, host string) string {
	return fmt.Sprintf("%s\t%s\t%s", addr, host, Marker)
}

// Pin returns content with one pinned line for host at addr, and whether it
// changed. A file already carrying exactly that pin is returned unchanged; a
// stale pin of ours for another address is replaced; a line someone else wrote
// for host is left alone and reported as ErrClaimedByOther.
func Pin(content []byte, addr net.IP, host string) ([]byte, bool, error) {
	if addr == nil || addr.To4() == nil {
		return nil, false, errors.New("hostspin: pin address must be IPv4")
	}
	if host == "" || strings.ContainsAny(host, " \t\r\n#") {
		return nil, false, fmt.Errorf("hostspin: %q is not a hostname", host)
	}
	want := Line(addr, host)
	lines := splitLines(content)
	kept := make([]string, 0, len(lines)+1)
	already := false
	for _, line := range lines {
		if isOurs(line) {
			if line == want && !already {
				already = true
				kept = append(kept, line)
			}
			continue
		}
		if names(line, host) {
			return nil, false, ErrClaimedByOther
		}
		kept = append(kept, line)
	}
	if !already {
		kept = append(kept, want)
	}
	out := joinLines(kept)
	return out, !bytes.Equal(out, content), nil
}

// Unpin returns content with every line this package wrote removed, and
// whether it changed.
func Unpin(content []byte) ([]byte, bool) {
	lines := splitLines(content)
	kept := make([]string, 0, len(lines))
	for _, line := range lines {
		if !isOurs(line) {
			kept = append(kept, line)
		}
	}
	if len(kept) == len(lines) {
		return content, false
	}
	return joinLines(kept), true
}

// Pinned reports whether content carries a pin of ours.
func Pinned(content []byte) bool {
	for _, line := range splitLines(content) {
		if isOurs(line) {
			return true
		}
	}
	return false
}

// PinFile pins host to addr in the file at path, in place.
func PinFile(path string, addr net.IP, host string) error {
	return rewrite(path, func(content []byte) ([]byte, bool, error) { return Pin(content, addr, host) })
}

// UnpinFile removes every pin of ours from the file at path, in place. A file
// that no longer exists has no pin, so that is not an error: a container that
// was removed took its hosts file with it.
func UnpinFile(path string) error {
	err := rewrite(path, func(content []byte) ([]byte, bool, error) {
		out, changed := Unpin(content)
		return out, changed, nil
	})
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func rewrite(path string, edit func([]byte) ([]byte, bool, error)) error {
	content, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	out, changed, err := edit(content)
	if err != nil || !changed {
		return err
	}
	// O_TRUNC on the existing file keeps its inode and its mode, which is what
	// a bind mount of it needs. os.WriteFile opens exactly that way.
	if err := os.WriteFile(path, out, 0o644); err != nil {
		return fmt.Errorf("hostspin: write %s: %w", path, err)
	}
	return nil
}

func isOurs(line string) bool { return strings.HasSuffix(strings.TrimRight(line, " \t\r"), Marker) }

// names reports whether a hosts-file line maps host, ignoring comments and
// case, the way a resolver reads it.
func names(line, host string) bool {
	if hash := strings.IndexByte(line, '#'); hash >= 0 {
		line = line[:hash]
	}
	fields := strings.Fields(line)
	if len(fields) < 2 {
		return false
	}
	for _, name := range fields[1:] {
		if strings.EqualFold(name, host) {
			return true
		}
	}
	return false
}

func splitLines(content []byte) []string {
	text := strings.TrimSuffix(string(content), "\n")
	if text == "" {
		return nil
	}
	return strings.Split(text, "\n")
}

func joinLines(lines []string) []byte {
	if len(lines) == 0 {
		return nil
	}
	return []byte(strings.Join(lines, "\n") + "\n")
}
