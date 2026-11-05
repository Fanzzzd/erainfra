package hostspin

import (
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const host = "results-receiver.actions.githubusercontent.com"

var addr = net.ParseIP("100.64.0.1")

// The guest's /etc/hosts as the image ships it plus the hostname line
// runner-center-guest adds at boot.
const guestHosts = "127.0.0.1\tlocalhost\n::1\tlocalhost ip6-localhost ip6-loopback\n127.0.1.1\trc-a\n"

func TestPinAppendsOneMarkedLineAndParsesBack(t *testing.T) {
	out, changed, err := Pin([]byte(guestHosts), addr, host)
	if err != nil || !changed {
		t.Fatalf("Pin = changed %v, err %v", changed, err)
	}
	want := guestHosts + "100.64.0.1\t" + host + "\t" + Marker + "\n"
	if string(out) != want {
		t.Fatalf("pinned file:\n%q\nwant:\n%q", out, want)
	}
	if !Pinned(out) || Pinned([]byte(guestHosts)) {
		t.Fatal("Pinned does not read back what Pin wrote")
	}
}

func TestPinIsIdempotent(t *testing.T) {
	once, _, err := Pin([]byte(guestHosts), addr, host)
	if err != nil {
		t.Fatal(err)
	}
	twice, changed, err := Pin(once, addr, host)
	if err != nil {
		t.Fatal(err)
	}
	if changed || string(twice) != string(once) {
		t.Fatalf("a second Pin changed the file:\n%q", twice)
	}
}

// A unit that crashed after pinning and restarted with a different address
// must not leave two answers for one name.
func TestPinReplacesAStalePinOfOurs(t *testing.T) {
	stale := guestHosts + "100.64.0.9\t" + host + "\t" + Marker + "\n"
	out, changed, err := Pin([]byte(stale), addr, host)
	if err != nil || !changed {
		t.Fatalf("Pin = changed %v, err %v", changed, err)
	}
	if strings.Contains(string(out), "100.64.0.9") || strings.Count(string(out), Marker) != 1 {
		t.Fatalf("stale pin survived:\n%s", out)
	}
}

// A job that maps the name itself (docker run --add-host, or an edit to the
// guest's own file) made that decision on purpose.
func TestPinDefersToAnEntryItDidNotWrite(t *testing.T) {
	claimed := guestHosts + "140.82.112.21  RESULTS-RECEIVER.actions.githubusercontent.com\n"
	if _, _, err := Pin([]byte(claimed), addr, host); !errors.Is(err, ErrClaimedByOther) {
		t.Fatalf("Pin over a foreign entry: err = %v, want ErrClaimedByOther", err)
	}
	// A comment that merely mentions the name is not an entry.
	commented := guestHosts + "# 140.82.112.21 " + host + "\n"
	if _, _, err := Pin([]byte(commented), addr, host); err != nil {
		t.Fatalf("a comment blocked the pin: %v", err)
	}
}

func TestPinRefusesWhatIsNotAnIPv4AddressOrAHostname(t *testing.T) {
	if _, _, err := Pin([]byte(guestHosts), net.ParseIP("::1"), host); err == nil {
		t.Fatal("pinned to IPv6 in a guest that boots with ipv6.disable=1")
	}
	if _, _, err := Pin([]byte(guestHosts), addr, "a b"); err == nil {
		t.Fatal("pinned a name with whitespace in it")
	}
}

func TestUnpinRemovesOnlyOurLines(t *testing.T) {
	// A Docker host-network container's hosts file is a copy of the guest's,
	// so it carries the pin in the middle, followed by Docker's own lines.
	mixed := "127.0.0.1\tlocalhost\n100.64.0.1\t" + host + "\t" + Marker + "\n172.17.0.2\tabc123\n"
	out, changed := Unpin([]byte(mixed))
	if !changed {
		t.Fatal("Unpin reported no change")
	}
	if string(out) != "127.0.0.1\tlocalhost\n172.17.0.2\tabc123\n" {
		t.Fatalf("Unpin left:\n%q", out)
	}
	again, changed := Unpin(out)
	if changed || string(again) != string(out) {
		t.Fatal("a second Unpin changed the file")
	}
}

func TestPinFileRewritesInPlaceSoABindMountSeesIt(t *testing.T) {
	path := filepath.Join(t.TempDir(), "hosts")
	if err := os.WriteFile(path, []byte(guestHosts), 0o644); err != nil {
		t.Fatal(err)
	}
	before, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := PinFile(path, addr, host); err != nil {
		t.Fatal(err)
	}
	after, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if !os.SameFile(before, after) {
		t.Fatal("PinFile replaced the file; a container's bind mount would keep the old inode")
	}
	content, _ := os.ReadFile(path)
	if !Pinned(content) {
		t.Fatalf("file not pinned:\n%s", content)
	}
	if err := UnpinFile(path); err != nil {
		t.Fatal(err)
	}
	content, _ = os.ReadFile(path)
	if string(content) != guestHosts {
		t.Fatalf("UnpinFile did not restore the original:\n%q", content)
	}
}

func TestUnpinFileOfAGoneContainerIsNotAnError(t *testing.T) {
	if err := UnpinFile(filepath.Join(t.TempDir(), "removed", "hosts")); err != nil {
		t.Fatalf("UnpinFile on a missing file = %v", err)
	}
}
