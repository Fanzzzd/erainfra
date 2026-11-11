package gitmirror

import (
	"context"
	"fmt"
	"io"
	"os"
	"strings"
	"time"
)

// upstream is the URL the mirror's git fetches repository from.
func (s *Service) upstream(repository string) string {
	return "http://" + s.fwdLn.Addr().String() + "/" + repository
}

// prepare reports whether the mirror can serve repository. Usually prewarm
// has already restored the job's seed; if it has not, the first fetch asks.
func (s *Service) prepare(ctx context.Context, repository string) bool {
	if done, ready := s.preparedFor(repository); done {
		return ready
	}
	s.prepareMu.Lock()
	defer s.prepareMu.Unlock()
	if done, ready := s.preparedFor(repository); done {
		return ready
	}
	s.mu.Lock()
	recentlyAsked := !s.askedAt.IsZero() && s.config.Now().Sub(s.askedAt) < askRetry
	s.mu.Unlock()
	if recentlyAsked {
		return false
	}
	s.load(context.WithoutCancel(ctx))
	_, ready := s.preparedFor(repository)
	return ready
}

// preparedFor reports whether the seed store has answered (done) and, if so,
// whether the mirror holds repository's seed.
func (s *Service) preparedFor(repository string) (done, ready bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.prepared {
		return false, false
	}
	return true, s.ready && strings.EqualFold(s.repository, repository)
}

// load asks the seed store about this job and restores the seed it returns.
// The caller holds prepareMu. The job's repository comes from the store's
// answer, never from a request, so whatever a job asks git to fetch, the seed
// restored is its own repository's.
func (s *Service) load(ctx context.Context) {
	ctx, cancel := context.WithTimeout(ctx, s.config.RestoreTimeout)
	defer cancel()
	info, seed, err := s.config.Seeds.Open(ctx)
	s.mu.Lock()
	if err != nil {
		// Logged once: until the job facts arrive, every ask fails the same way.
		first := s.askedAt.IsZero()
		s.askedAt = s.config.Now()
		s.mu.Unlock()
		if first {
			s.logf("git mirror: the cache service has no answer for this job yet: %v", err)
		}
		return
	}
	s.repository, s.writable, s.seedFound, s.seedCreated = info.Repository, info.Writable, info.Found, info.Created
	s.prepared = true
	s.mu.Unlock()
	if !info.RefusedUntil.IsZero() {
		s.logf("git mirror: the cache service refused %s's last seed as too large; no job builds another before %s",
			info.Repository, info.RefusedUntil.UTC().Format(time.RFC3339))
	}
	if seed == nil {
		s.logf("git mirror: %s has no seed in this job's scope yet; its checkout goes to GitHub directly", info.Repository)
		return
	}

	started := s.config.Now()
	s.writeMu.Lock()
	err = s.restore(ctx, seed)
	s.writeMu.Unlock()
	if err != nil {
		s.logf("git mirror: the seed for %s did not import; its checkout goes to GitHub directly: %v", info.Repository, err)
		return
	}
	s.mu.Lock()
	s.ready = true
	s.mu.Unlock()
	s.logf("git mirror: restored %s's seed from %s in %s", info.Repository,
		info.Created.UTC().Format(time.RFC3339), s.config.Now().Sub(started).Round(time.Millisecond))
}

// prewarm restores the job's seed before anything asks for it, so the
// checkout does not wait on the download and import. The guest starts the
// proxy at claim, a few seconds before the runner reaches its first step; the
// controller's job facts usually arrive in that window, and until they do the
// cache service does not know the job, so this asks again every
// prewarmInterval for up to PrewarmFor.
func (s *Service) prewarm(ctx context.Context) {
	defer s.background.Done()
	deadline := s.config.Now().Add(s.config.PrewarmFor)
	for {
		s.prepareMu.Lock()
		if done, _ := s.preparedFor(""); !done {
			s.load(ctx)
		}
		done, _ := s.preparedFor("")
		s.prepareMu.Unlock()
		if done || !s.config.Now().Before(deadline) {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(prewarmInterval):
		}
	}
}

// restore writes the seed to a file and imports it into a fresh mirror. A
// failure removes the mirror so that a later refresh starts clean.
func (s *Service) restore(ctx context.Context, seed io.ReadCloser) error {
	defer seed.Close() //nolint:errcheck // read-only body; a close error loses nothing
	file, err := os.CreateTemp(s.tmpDir, "seed-*.bundle")
	if err != nil {
		return err
	}
	path := file.Name()
	defer os.Remove(path) //nolint:errcheck // a temporary file in a directory that dies with the guest
	if _, err := io.Copy(file, seed); err != nil {
		_ = file.Close()
		return fmt.Errorf("download the seed: %w", err)
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := s.freshMirror(ctx); err != nil {
		return err
	}
	if err := s.mirror.restore(ctx, path); err != nil {
		_ = os.RemoveAll(s.mirror.dir)
		return err
	}
	return nil
}

func (s *Service) freshMirror(ctx context.Context) error {
	if err := os.RemoveAll(s.mirror.dir); err != nil {
		return err
	}
	return s.mirror.create(ctx)
}

// maybeRefresh starts the one refresh a guest makes, after the job's first
// fetch of its own repository, when this job may save a seed and the seed it
// found is missing or old. It uses the credential that fetch presented: the
// job's own token, scoped by GitHub to this repository and this job. No other
// credential exists in the guest for it to use.
func (s *Service) maybeRefresh(repository, authorization string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	switch {
	case s.closing, s.refreshStarted, !s.prepared, !s.writable, !strings.EqualFold(s.repository, repository):
		return
	case s.seedFound && s.config.Now().Sub(s.seedCreated) < s.config.RefreshAfter:
		return
	}
	s.refreshStarted = true
	s.background.Add(1)
	go func() {
		defer s.background.Done()
		s.refresh(repository, authorization)
	}()
}

func (s *Service) refresh(repository, authorization string) {
	ctx, cancel := context.WithTimeout(s.bgCtx, s.config.RefreshTimeout)
	defer cancel()
	started := s.config.Now()

	s.mu.Lock()
	ready := s.ready
	s.mu.Unlock()
	file, err := os.CreateTemp(s.tmpDir, "refresh-*.bundle")
	if err != nil {
		s.logf("git mirror: refresh of %s could not start: %v", repository, err)
		return
	}
	path := file.Name()
	_ = file.Close()
	defer os.Remove(path) //nolint:errcheck // a temporary file in a directory that dies with the guest

	s.writeMu.Lock()
	err = func() error {
		if !ready {
			if err := s.freshMirror(ctx); err != nil {
				return err
			}
		}
		if err := s.mirror.refresh(ctx, s.upstream(repository), authorization); err != nil {
			return err
		}
		// git bundle create refuses to overwrite nothing; it writes path.
		_ = os.Remove(path)
		return s.mirror.bundle(ctx, path)
	}()
	s.writeMu.Unlock()
	if err != nil {
		s.logf("git mirror: refresh of %s failed; later jobs keep the older seed: %v", repository, err)
		return
	}
	s.mu.Lock()
	s.ready = true
	s.mu.Unlock()

	stat, err := os.Stat(path)
	if err != nil {
		s.logf("git mirror: refresh of %s wrote no bundle: %v", repository, err)
		return
	}
	if err := s.config.Seeds.Save(ctx, path); err != nil {
		s.logf("git mirror: saving %s's seed failed; later jobs keep the older seed: %v", repository, err)
		return
	}
	s.logf("git mirror: saved a %d-byte seed of %s in %s", stat.Size(), repository,
		s.config.Now().Sub(started).Round(time.Millisecond))
}
