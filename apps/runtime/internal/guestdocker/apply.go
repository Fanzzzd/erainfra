package guestdocker

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/Fanzzzd/erainfra/apps/runtime/internal/registrymirror"
)

// MirrorSetup is how the guest applies a registry mirror to its dockerd.
type MirrorSetup struct {
	URL string
	// DaemonJSON is dockerd's configuration file, /etc/docker/daemon.json.
	DaemonJSON string
	// Reload makes dockerd re-read DaemonJSON: systemctl reload docker.service,
	// which sends the SIGHUP dockerd reloads registry-mirrors on.
	Reload func(ctx context.Context) error
	// Client probes the mirror. Nil means a client with a short timeout and
	// no proxy.
	Client *http.Client
}

// mirrorProbeTimeout bounds the reachability check. The guest's network policy
// drops what it does not allow rather than refusing it, so an unallowed mirror
// looks like a hang, and dockerd would wait out its own dial timeout before
// falling back on every pull. Three seconds once at claim is the cheaper place
// to find that out.
const mirrorProbeTimeout = 3 * time.Second

// ApplyMirror points dockerd at the mirror, or changes nothing and says why.
//
// It probes the mirror first and configures nothing if it does not answer:
// dockerd falls back to Docker Hub when a mirror fails, but a mirror that
// never answers costs every pull a dial timeout before that fallback. Any
// HTTP answer from /v2/ counts, a 401 included, because a registry that asks
// for credentials is still a registry dockerd can talk to.
//
// If the reload fails, the previous daemon.json is put back, so the next
// dockerd restart does not pick up a mirror this Attempt decided not to use.
func ApplyMirror(ctx context.Context, s MirrorSetup) error {
	if err := registrymirror.Validate(s.URL); err != nil {
		return err
	}
	if s.DaemonJSON == "" || s.Reload == nil {
		return errors.New("guestdocker: a daemon.json path and a reload are required")
	}
	if err := ProbeMirror(ctx, s.Client, s.URL); err != nil {
		return err
	}
	previous, err := os.ReadFile(s.DaemonJSON)
	existed := err == nil
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("read %s: %w", s.DaemonJSON, err)
	}
	rendered, err := RenderDaemonJSON(previous, s.URL)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.DaemonJSON), 0o755); err != nil {
		return fmt.Errorf("create %s: %w", filepath.Dir(s.DaemonJSON), err)
	}
	if err := os.WriteFile(s.DaemonJSON, rendered, 0o644); err != nil {
		return fmt.Errorf("write %s: %w", s.DaemonJSON, err)
	}
	if err := s.Reload(ctx); err != nil {
		var restoreErr error
		if existed {
			restoreErr = os.WriteFile(s.DaemonJSON, previous, 0o644)
		} else {
			restoreErr = os.Remove(s.DaemonJSON)
		}
		return errors.Join(fmt.Errorf("reload dockerd: %w", err), restoreErr)
	}
	return nil
}

// ProbeMirror reports whether anything answers HTTP at the mirror's /v2/.
func ProbeMirror(ctx context.Context, client *http.Client, mirrorURL string) error {
	if client == nil {
		client = &http.Client{Timeout: mirrorProbeTimeout, Transport: &http.Transport{Proxy: nil}}
	}
	ctx, cancel := context.WithTimeout(ctx, mirrorProbeTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, registrymirror.Canonical(mirrorURL)+"v2/", nil)
	if err != nil {
		return err
	}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("registry mirror %s did not answer: %w", mirrorURL, err)
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	return resp.Body.Close()
}

// BuildkitdDefaultPath is where buildx looks for the default BuildKit
// configuration when neither BUILDX_CONFIG nor DOCKER_CONFIG is set, relative
// to the user's home.
const BuildkitdDefaultPath = ".docker/buildx/buildkitd.default.toml"

// WriteBuildkitdConfig writes the runner user's default BuildKit
// configuration, owned by that user, or writes nothing when there is nothing
// to configure. Directories it creates are owned by the user too, since the
// docker CLI and buildx will write their own state beside it.
func WriteBuildkitdConfig(home string, uid, gid int, c BuildkitdConfig) (bool, error) {
	content, ok, err := RenderBuildkitdConfig(c)
	if err != nil || !ok {
		return false, err
	}
	path := filepath.Join(home, BuildkitdDefaultPath)
	for _, dir := range []struct {
		path string
		mode os.FileMode
	}{
		// ~/.docker later holds config.json and its credentials.
		{filepath.Join(home, ".docker"), 0o700},
		{filepath.Dir(path), 0o755},
	} {
		if err := os.Mkdir(dir.path, dir.mode); err != nil {
			if !errors.Is(err, os.ErrExist) {
				return false, fmt.Errorf("create %s: %w", dir.path, err)
			}
			continue
		}
		if err := os.Chown(dir.path, uid, gid); err != nil {
			return false, fmt.Errorf("chown %s: %w", dir.path, err)
		}
	}
	if err := os.WriteFile(path, content, 0o644); err != nil {
		return false, fmt.Errorf("write %s: %w", path, err)
	}
	if err := os.Chown(path, uid, gid); err != nil {
		return false, fmt.Errorf("chown %s: %w", path, err)
	}
	return true, nil
}
