package meshclient

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Supervisor is for an ordinary user's foreground agent. Installed Linux Nodes use a separate
// service user and systemd unit instead: the root Infra Agent never spawns a root mesh daemon.
type SupervisorConfig struct {
	Binary       string
	Dir          string
	Socket       string
	LoopbackOnly bool
	NoPortmap    bool
}
type Supervisor struct {
	Client *Client
	cancel context.CancelFunc
	done   chan struct{}
	lock   *Lock
	output *boundedOutput
	once   sync.Once
}
type boundedOutput struct {
	mu    sync.Mutex
	data  []byte
	total uint64
}

func (b *boundedOutput) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.total += uint64(len(p))
	remaining := 64*1024 - len(b.data)
	if remaining > len(p) {
		remaining = len(p)
	}
	if remaining > 0 {
		b.data = append(b.data, p[:remaining]...)
	}
	return len(p), nil
}

func Start(ctx context.Context, cfg SupervisorConfig) (*Supervisor, error) {
	if privileged() {
		return nil, errors.New("refusing to supervise a privileged mesh process: use the dedicated erainfra-mesh service")
	}
	if cfg.Binary == "" || cfg.Dir == "" || cfg.Socket == "" {
		return nil, errors.New("mesh binary, private directory and socket are required")
	}
	if err := PrivateDir(cfg.Dir); err != nil {
		return nil, err
	}
	lock, err := Acquire(filepath.Join(cfg.Dir, "daemon.lock"))
	if err != nil {
		return nil, err
	}
	fail := func(err error) (*Supervisor, error) { _ = lock.Close(); return nil, err }
	if _, err := New(cfg.Socket).Status(ctx); err == nil {
		return fail(errors.New("a mesh daemon already owns this socket; connect to it instead of starting another"))
	}
	st, err := os.Lstat(cfg.Binary)
	if err != nil {
		return fail(err)
	}
	if !st.Mode().IsRegular() || st.Mode().Perm()&0022 != 0 {
		return fail(errors.New("mesh binary must be regular and not group/other writable"))
	}
	key := filepath.Join(cfg.Dir, "endpoint.key")
	if _, err := os.Lstat(key); os.IsNotExist(err) {
		initCtx, cancel := context.WithTimeout(ctx, Timeout)
		defer cancel()
		cmd := exec.CommandContext(initCtx, cfg.Binary, "init", "--key", key)
		cmd.Stdout = &boundedOutput{}
		cmd.Stderr = &boundedOutput{}
		if err := cmd.Run(); err != nil {
			return fail(fmt.Errorf("mesh identity initialization failed: %w", err))
		}
	}
	if err := privateKey(key); err != nil {
		return fail(err)
	}
	s := &Supervisor{Client: New(cfg.Socket), done: make(chan struct{}), lock: lock, output: &boundedOutput{}}
	childCtx, cancel := context.WithCancel(ctx)
	s.cancel = cancel
	go func() {
		defer close(s.done)
		for childCtx.Err() == nil {
			args := []string{"daemon", "--key", key, "--socket", cfg.Socket, "--state", filepath.Join(cfg.Dir, "state")}
			if cfg.NoPortmap {
				args = append(args, "--no-portmap")
			}
			if cfg.LoopbackOnly {
				args = append(args, "--loopback-only")
			}
			cmd := exec.CommandContext(childCtx, cfg.Binary, args...)
			// Bound worker and log-buffer resources independently of the host's CPU count. The
			// installed service adds hard MemoryMax/TasksMax/LimitNOFILE limits.
			for _, e := range os.Environ() {
				if !strings.HasPrefix(e, "TOKIO_WORKER_THREADS=") {
					cmd.Env = append(cmd.Env, e)
				}
			}
			cmd.Env = append(cmd.Env, "TOKIO_WORKER_THREADS=2")
			cmd.Stdout = s.output
			cmd.Stderr = s.output
			cmd.Cancel = func() error {
				if cmd.Process == nil {
					return nil
				}
				return terminate(cmd.Process)
			}
			cmd.WaitDelay = 5 * time.Second
			_ = cmd.Run() // Restart after failure, without exposing child output or secrets in an error.
			timer := time.NewTimer(time.Second)
			select {
			case <-childCtx.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
		}
	}()
	readyCtx, readyCancel := context.WithTimeout(ctx, 15*time.Second)
	defer readyCancel()
	for {
		if _, err := s.Client.Status(readyCtx); err == nil {
			return s, nil
		}
		timer := time.NewTimer(50 * time.Millisecond)
		select {
		case <-readyCtx.Done():
			timer.Stop()
			_ = s.Close()
			return nil, errors.New("mesh sidecar did not become ready within 15 seconds")
		case <-s.done:
			timer.Stop()
			_ = s.Close()
			return nil, errors.New("mesh supervisor stopped before readiness")
		case <-timer.C:
		}
	}
}
func (s *Supervisor) Close() error {
	var err error
	s.once.Do(func() { s.cancel(); <-s.done; err = s.lock.Close() })
	return err
}
