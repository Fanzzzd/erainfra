// Package gateway is the public ingress proxy a gateway Node runs behind cloudflared (ADR 0016
// phase 3b). It routes `<label>.<zone>` to the loopback port where the Node's erainfra-mesh link
// for that App listens, and it never reaches anything that is not on loopback.
//
// Two processes share one file. The Infra Agent (root, holds the Convex credential) writes the
// route table it receives in its revisioned Node state; the proxy (`infra-agent gateway`, an
// unprivileged user with no credential) reads it. The file is the last copy ADR 0016 promises:
// while Convex is unreachable, or after either process restarts, the proxy keeps serving it.
package gateway

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
)

// MaxRoutes bounds a table. Convex sends at most 100 routes (infra/ingress.ts).
const MaxRoutes = 1000

// maxTableBytes bounds what the proxy reads from the routes file.
const maxTableBytes = 1 << 20

// Table is the routes file, version 1.
type Table struct {
	V        int    `json:"v"`
	Revision string `json:"revision"`
	// Gateway is false when Convex does not mark this Node a gateway; Routes is then empty.
	Gateway bool    `json:"gateway"`
	Routes  []Route `json:"routes"`
}

// Route maps one first-level label to a loopback upstream. A nil Upstream is an App whose Node
// the gateway cannot reach right now: the proxy answers 503, not 404.
type Route struct {
	Host     string  `json:"host"`
	Upstream *string `json:"upstream"`
}

var labelPattern = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)

// ValidLabel reports whether s is a lowercase first-level DNS label.
func ValidLabel(s string) bool { return labelPattern.MatchString(s) }

// ValidUpstream reports whether s is a loopback IP and port. The proxy dials nothing else, so a
// bad table cannot turn it into a way to reach other hosts.
func ValidUpstream(s string) bool {
	host, port, err := net.SplitHostPort(s)
	if err != nil {
		return false
	}
	p, err := strconv.Atoi(port)
	ip := net.ParseIP(host)
	return err == nil && p >= 1 && p <= 65535 && ip != nil && ip.IsLoopback()
}

// Validate checks a table before either side uses it.
func (t Table) Validate() error {
	if t.V != 1 {
		return errors.New("routes table must be v1")
	}
	if len(t.Routes) > MaxRoutes {
		return fmt.Errorf("routes table has more than %d routes", MaxRoutes)
	}
	if !t.Gateway && len(t.Routes) > 0 {
		return errors.New("routes table carries routes for a Node that is not a gateway")
	}
	seen := map[string]bool{}
	for _, r := range t.Routes {
		if !ValidLabel(r.Host) || seen[r.Host] {
			return fmt.Errorf("invalid or duplicate route host %q", r.Host)
		}
		seen[r.Host] = true
		if r.Upstream != nil && !ValidUpstream(*r.Upstream) {
			return fmt.Errorf("route %s: upstream must be a loopback address", r.Host)
		}
	}
	return nil
}

// WriteTable replaces path atomically: a reader sees the old table or the new one, never a torn
// one, and a crash leaves one of the two. The file is 0644 so the proxy's user can read it; keep
// it in a directory only root and that user can enter (docs/infra-management.md).
func WriteTable(path string, t Table) error {
	if err := t.Validate(); err != nil {
		return err
	}
	if t.Routes == nil {
		t.Routes = []Route{}
	}
	b, err := json.Marshal(t)
	if err != nil {
		return err
	}
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".routes-*.json")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer func() { _ = os.Remove(name) }()
	if _, err := tmp.Write(append(b, '\n')); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Chmod(0o644); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(name, path); err != nil {
		return err
	}
	return syncDir(dir)
}

// ReadTable reads and validates a routes file.
func ReadTable(path string) (Table, error) {
	f, err := os.Open(path)
	if err != nil {
		return Table{}, err
	}
	defer func() { _ = f.Close() }()
	b, err := io.ReadAll(io.LimitReader(f, maxTableBytes+1))
	if err != nil {
		return Table{}, err
	}
	if len(b) > maxTableBytes {
		return Table{}, errors.New("routes file is larger than 1 MiB")
	}
	var t Table
	if err := json.Unmarshal(b, &t); err != nil {
		return Table{}, fmt.Errorf("routes file is not valid JSON: %w", err)
	}
	return t, t.Validate()
}

// syncDir makes the rename durable. Windows cannot fsync a directory, and NTFS renames are
// already journaled, so the error is ignored there.
func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer func() { _ = d.Close() }()
	if err := d.Sync(); err != nil && runtime.GOOS != "windows" {
		return err
	}
	return nil
}
