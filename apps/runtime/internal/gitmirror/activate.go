package gitmirror

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// ActivateConfig is how a guest points its git at a running Service.
type ActivateConfig struct {
	// SystemRoots is the system CA bundle, copied into CABundle so that git
	// still verifies the real github.com if something sends it around the
	// proxy.
	SystemRoots string
	// CABundle is where the system roots plus the per-guest CA are written.
	CABundle string
	// CADir is a directory written with the per-guest CA alone, which git's
	// http.sslCAPath names. It keeps the proxy trusted by a job that points
	// GIT_SSL_CAINFO at a bundle of its own (see caPathName).
	CADir string
	// ConfigFile is where the git configuration from [GitConfig] is written.
	ConfigFile string
	// CAPEM is the per-guest CA the proxy's leaf chains to.
	CAPEM []byte
	// Include makes the system git configuration include ConfigFile. Git
	// skips an include whose file does not exist, so removing ConfigFile is
	// all it takes to turn the proxy off again.
	Include func(ctx context.Context, configFile string) error
	Logf    func(format string, args ...any)
}

// Activate writes the git configuration that routes https://github.com/
// through s and returns the function that removes it. It also removes it on
// its own when s stops serving, so git never keeps dialing a proxy that is
// gone. On error nothing is left behind.
func Activate(ctx context.Context, s *Service, cfg ActivateConfig) (func(), error) {
	switch {
	case cfg.SystemRoots == "", cfg.CABundle == "", cfg.CADir == "", cfg.ConfigFile == "", len(cfg.CAPEM) == 0, cfg.Include == nil:
		return nil, errors.New("gitmirror: activation needs roots, a bundle path, a CA directory, a config path, the CA and an include")
	}
	caName, err := caPathName(cfg.CAPEM)
	if err != nil {
		return nil, err
	}
	logf := cfg.Logf
	if logf == nil {
		logf = func(string, ...any) {}
	}
	roots, err := os.ReadFile(cfg.SystemRoots)
	if err != nil {
		return nil, fmt.Errorf("gitmirror: read the system roots: %w", err)
	}
	bundle := append(bytes.TrimRight(roots, "\n"), '\n')
	bundle = append(bundle, cfg.CAPEM...)
	if err := writeFile(cfg.CABundle, bundle); err != nil {
		return nil, err
	}
	// The directory holds this guest's CA and nothing else: an older file
	// left by an earlier run of the guest unit names a CA whose key is gone.
	if err := os.RemoveAll(cfg.CADir); err != nil {
		_ = os.Remove(cfg.CABundle)
		return nil, fmt.Errorf("gitmirror: clear %s: %w", cfg.CADir, err)
	}
	if err := writeFile(filepath.Join(cfg.CADir, caName), cfg.CAPEM); err != nil {
		_ = os.Remove(cfg.CABundle)
		return nil, err
	}
	if err := writeFile(cfg.ConfigFile, []byte(GitConfig(s.ProxyURL(), cfg.CABundle, cfg.CADir))); err != nil {
		_ = os.Remove(cfg.CABundle)
		_ = os.RemoveAll(cfg.CADir)
		return nil, err
	}
	var once sync.Once
	deactivate := func() {
		once.Do(func() {
			if err := os.Remove(cfg.ConfigFile); err != nil && !errors.Is(err, os.ErrNotExist) {
				logf("git mirror: could not remove %s; git may keep using a stopped proxy: %v", cfg.ConfigFile, err)
			}
		})
	}
	if err := cfg.Include(ctx, cfg.ConfigFile); err != nil {
		deactivate()
		_ = os.Remove(cfg.CABundle)
		_ = os.RemoveAll(cfg.CADir)
		return nil, fmt.Errorf("gitmirror: include %s in the system git configuration: %w", cfg.ConfigFile, err)
	}
	go func() {
		err := s.Wait()
		deactivate()
		logf("git mirror: proxy stopped, git goes to GitHub directly: %v", err)
	}()
	return deactivate, nil
}

func writeFile(path string, content []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("gitmirror: create %s: %w", filepath.Dir(path), err)
	}
	// World-readable on purpose: the job's git runs as the runner user, and
	// neither file holds a secret. The leaf's key stays in this process.
	if err := os.WriteFile(path, content, 0o644); err != nil {
		return fmt.Errorf("gitmirror: write %s: %w", path, err)
	}
	return nil
}
