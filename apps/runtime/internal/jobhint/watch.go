package jobhint

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"time"
)

// ErrNoJob is Watch's answer when its context ended before the runner
// started a job. That is the normal end for a runner that exits without one,
// so callers stay quiet about it.
var ErrNoJob = errors.New("the runner started no job")

const (
	// DefaultPoll is how often Watch looks for the Worker log and for more of
	// it. A fifth of a second is noise next to the 7 to 38 s the hint saves.
	DefaultPoll = 200 * time.Millisecond
	// DefaultTimeout bounds reading the job message once the Worker log
	// exists. The Worker logs it within its first second; a log that has not
	// produced a whole message in a minute is not going to.
	DefaultTimeout = time.Minute
	// DefaultMaxBytes bounds how much of the Worker log is read. A job
	// message with a large workflow is tens of KiB, and the live logs put it
	// within the first 400 lines.
	DefaultMaxBytes = 2 << 20
)

// Watcher finds the runner's first Worker log in its diag folder and reads
// the hint from it. Zero fields take the defaults above.
type Watcher struct {
	Dir      string
	Poll     time.Duration
	Timeout  time.Duration
	MaxBytes int64
}

// Watch waits, for as long as ctx allows, for the first Worker_*.log in the
// diag folder, then follows it as the Worker writes it until the job message
// is complete, bounded by Timeout and MaxBytes.
//
// The wait for the log itself is unbounded on purpose: a warm guest's runner
// can sit idle for a long time before GitHub hands it a job, and the hint is
// worth as much then as at boot.
func (w Watcher) Watch(ctx context.Context) (Hint, error) {
	poll := cmp.Or(w.Poll, DefaultPoll)
	path, err := firstWorkerLog(ctx, w.Dir, poll)
	if err != nil {
		return Hint{}, err
	}
	file, err := os.Open(path)
	if err != nil {
		return Hint{}, fmt.Errorf("open the Worker log: %w", err)
	}
	defer file.Close() //nolint:errcheck // read-only file; a close error loses nothing
	ctx, cancel := context.WithTimeout(ctx, cmp.Or(w.Timeout, DefaultTimeout))
	defer cancel()
	reader := io.LimitReader(&follower{ctx: ctx, file: file, poll: poll}, cmp.Or(w.MaxBytes, DefaultMaxBytes))
	hint, err := Parse(reader)
	if err != nil && ctx.Err() != nil {
		return Hint{}, fmt.Errorf("read the job message from %s: %w", filepath.Base(path), ctx.Err())
	}
	if err != nil {
		return Hint{}, fmt.Errorf("read the job message from %s: %w", filepath.Base(path), err)
	}
	return hint, nil
}

// firstWorkerLog polls for the oldest Worker_*.log. The runner names each
// after the UTC time it opened it, so the least name is the first job's; an
// ephemeral runner only ever has one.
func firstWorkerLog(ctx context.Context, dir string, poll time.Duration) (string, error) {
	ticker := time.NewTicker(poll)
	defer ticker.Stop()
	for {
		if logs, _ := filepath.Glob(filepath.Join(dir, "Worker_*.log")); len(logs) > 0 {
			return slices.Min(logs), nil
		}
		select {
		case <-ctx.Done():
			return "", ErrNoJob
		case <-ticker.C:
		}
	}
}

// follower reads a file the Worker is still writing: at its current end it
// waits for more instead of returning io.EOF, until ctx ends. The JSON
// decoder above it then stops exactly where the job message ends.
type follower struct {
	ctx  context.Context
	file *os.File
	poll time.Duration
}

func (f *follower) Read(p []byte) (int, error) {
	for {
		n, err := f.file.Read(p)
		if n > 0 {
			return n, nil
		}
		if err != nil && !errors.Is(err, io.EOF) {
			return 0, err
		}
		select {
		case <-f.ctx.Done():
			return 0, f.ctx.Err()
		case <-time.After(f.poll):
		}
	}
}
