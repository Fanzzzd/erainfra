package firecracker

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Fanzzzd/erainfra/apps/runtime/internal/executor"
	"github.com/Fanzzzd/erainfra/apps/runtime/internal/netpolicy"
	"github.com/Fanzzzd/erainfra/apps/runtime/internal/runtimeapi"
	"github.com/Fanzzzd/erainfra/internal/golden"
)

// `runner-center-runtime prepare` prints a warm pool status that the Action
// Runner Agent turns into a Profile's readiness. v0.2.0-rc.22 printed
// {"healthy":false} with no detail for every Profile without a pool, and the
// Agent took no jobs on those Profiles.
//
// Each case below puts a real warm pool into one state and prints what
// `prepare` prints, through the runtime service's handler, its client and the
// command's stdout writer. The golden file's name says the readiness the
// runtime intends: prepare-ready-* or prepare-failed-*. The Agent's tests read
// every prepare-*.golden.json and assert that readiness
// (apps/action-runner-agent/tests/readiness.test.ts). Regenerate the files
// with ERAINFRA_UPDATE_GOLDEN=1 go test ./apps/runtime/internal/firecracker/.
func TestPrepareOutputMatchesTheGoldenFilesTheAgentReads(t *testing.T) {
	cases := []struct {
		name string
		// ready is the readiness the runtime intends for the state.
		ready bool
		// exits is whether the command exits non-zero after printing.
		exits bool
		run   func(*testing.T, *prepareRig) prepared
	}{
		{name: "no-pool", ready: true, run: func(t *testing.T, rig *prepareRig) prepared {
			return rig.wait(t, rig.prepare(0))
		}},
		{name: "full-pool", ready: true, run: func(t *testing.T, rig *prepareRig) prepared {
			return rig.fill(t, 2)
		}},
		{name: "replacement-in-flight", ready: true, run: func(t *testing.T, rig *prepareRig) prepared {
			// A parked guest exits once. The prepare that arrives while its
			// replacement boots waits for it and reports the full pool.
			parked := rig.fill(t, 1)
			parked.slots[0].done <- errors.New("VMM exited")
			eventually(t, func() bool { return rig.pool.Status("linux").Parked == 0 })
			result := rig.prepareAfterConfigureStarts(t, 1)
			rig.boot(t)
			return rig.wait(t, result)
		}},
		{name: "draining", ready: true, run: func(t *testing.T, rig *prepareRig) prepared {
			// The target drops below the claimed count: a planned drain.
			rig.fill(t, 2)
			for range 2 {
				if _, err := rig.pool.Claim(t.Context(), testAttempt()); err != nil {
					t.Fatal(err)
				}
			}
			return rig.wait(t, rig.prepare(1))
		}},
		{name: "recorded-error", exits: true, run: func(t *testing.T, rig *prepareRig) prepared {
			result := rig.prepare(1)
			rig.bootFails(t, errors.New("thin pool is out of data space"))
			return rig.wait(t, result)
		}},
		{name: "repeated-parked-exit", run: func(t *testing.T, rig *prepareRig) prepared {
			// Two parked guests exit. Their first replacement exits too while
			// the prepare waits for the pool to refill. Booting more guests
			// does not show the pool works, so the prepare reports the
			// failure with full counts and exits zero.
			parked := rig.fill(t, 2)
			for _, slot := range parked.slots {
				slot.done <- errors.New("VMM exited")
			}
			eventually(t, func() bool { return rig.pool.Status("linux").Parked == 0 })
			result := rig.prepareAfterConfigureStarts(t, 2)
			replacement := rig.boot(t)
			replacement.done <- errors.New("VMM exited")
			eventually(t, func() bool {
				return strings.HasPrefix(rig.pool.Status("linux").Detail, errParkedExitRepeated.Error())
			})
			rig.boot(t)
			rig.boot(t)
			return rig.wait(t, result)
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := tc.run(t, newPrepareRig(t))
			if got.encodeErr != nil {
				t.Fatal(got.encodeErr)
			}
			if exits := got.err != nil; exits != tc.exits {
				t.Fatalf("prepare error = %v, want an error: %t", got.err, tc.exits)
			}
			var status executor.WarmPoolStatus
			if err := json.Unmarshal(got.stdout, &status); err != nil {
				t.Fatal(err)
			}
			if status.Healthy != tc.ready || !tc.ready && status.Detail == "" {
				t.Fatalf("status = %s, want healthy=%t and a detail on failure", got.stdout, tc.ready)
			}
			readiness := "failed"
			if tc.ready {
				readiness = "ready"
			}
			golden.Check(
				t,
				filepath.Join("testdata", "prepare-"+readiness+"-"+tc.name+".golden.json"),
				got.stdout,
				"the Action Runner Agent's readiness tests",
			)
		})
	}
}

// goldenRunnerVersion stands in for the actions/runner version read from the
// Profile's image.
const goldenRunnerVersion = "2.330.0"

// prepareRig serves one warm pool through the runtime service and boots its
// guests only when the test says so.
type prepareRig struct {
	pool   *warmPoolManager
	boots  chan warmBoot
	client *runtimeapi.Client
}

type warmBoot struct {
	slot warmSlot
	err  error
}

type prepared struct {
	stdout    []byte
	err       error
	encodeErr error
	slots     []*fakeWarmSlot
}

func newPrepareRig(t *testing.T) *prepareRig {
	t.Helper()
	boots := make(chan warmBoot)
	pool := newWarmPoolManager(func(ctx context.Context, _ executor.Profile, _ uint64) (warmSlot, error) {
		select {
		case boot := <-boots:
			return boot.slot, boot.err
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	})
	t.Cleanup(func() { _ = pool.Shutdown(context.Background()) })

	directory, err := os.MkdirTemp("/tmp", "rc-prepare-golden-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(directory) })
	socket := filepath.Join(directory, "runtime.sock")
	var listenConfig net.ListenConfig
	listener, err := listenConfig.Listen(t.Context(), "unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{
		Handler:           runtimeapi.NewHandler(prepareService{pool: pool}, nil),
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(func() { _ = server.Close() })
	client, err := runtimeapi.NewClient(socket)
	if err != nil {
		t.Fatal(err)
	}
	return &prepareRig{pool: pool, boots: boots, client: client}
}

// prepare runs the `prepare` command's path in the background: the client
// call, then the stdout document, written whether or not the call failed.
func (r *prepareRig) prepare(target int) <-chan prepared {
	result := make(chan prepared, 1)
	go func() {
		status, err := r.client.PrepareProfile(context.Background(), testProfile(target))
		var stdout bytes.Buffer
		encodeErr := runtimeapi.WriteDocument(&stdout, status)
		result <- prepared{stdout: stdout.Bytes(), err: err, encodeErr: encodeErr}
	}()
	return result
}

// prepareAfterConfigureStarts starts a prepare and returns once Configure has
// cleared the pool's recorded failure, which it signals by waking claims.
// Nothing else may wake them meanwhile.
func (r *prepareRig) prepareAfterConfigureStarts(t *testing.T, target int) <-chan prepared {
	t.Helper()
	r.pool.mu.Lock()
	changed := r.pool.changed
	r.pool.mu.Unlock()
	result := r.prepare(target)
	select {
	case <-changed:
	case <-time.After(5 * time.Second):
		t.Fatal("prepare never reached Configure")
	}
	return result
}

// fill prepares a pool of target guests and boots each one.
func (r *prepareRig) fill(t *testing.T, target int) prepared {
	t.Helper()
	result := r.prepare(target)
	slots := make([]*fakeWarmSlot, 0, target)
	for range target {
		slots = append(slots, r.boot(t))
	}
	done := r.wait(t, result)
	if done.err != nil || !strings.Contains(string(done.stdout), `"healthy":true`) {
		t.Fatalf("filling the pool printed %s, error %v", done.stdout, done.err)
	}
	done.slots = slots
	return done
}

func (r *prepareRig) boot(t *testing.T) *fakeWarmSlot {
	t.Helper()
	slot := newFakeWarmSlot()
	r.send(t, warmBoot{slot: slot})
	return slot
}

func (r *prepareRig) bootFails(t *testing.T, err error) {
	t.Helper()
	r.send(t, warmBoot{err: err})
}

func (r *prepareRig) send(t *testing.T, boot warmBoot) {
	t.Helper()
	select {
	case r.boots <- boot:
	case <-time.After(5 * time.Second):
		t.Fatal("the pool never asked for a guest")
	}
}

func (r *prepareRig) wait(t *testing.T, result <-chan prepared) prepared {
	t.Helper()
	select {
	case done := <-result:
		return done
	case <-time.After(5 * time.Second):
		t.Fatal("prepare did not return")
		return prepared{}
	}
}

// prepareService is the runtime service with the warm pool and without a
// host: prepare's host part only reports the image's actions/runner version.
type prepareService struct {
	pool *warmPoolManager
}

func (s prepareService) PrepareProfile(
	ctx context.Context,
	profile executor.Profile,
) (executor.WarmPoolStatus, error) {
	return s.pool.prepare(ctx, profile, func(context.Context, executor.Profile) (string, error) {
		return goldenRunnerVersion, nil
	})
}

func (prepareService) Preflight(context.Context, netpolicy.ProfileEgress) (executor.Report, error) {
	return executor.Report{}, errors.New("not part of the prepare golden")
}

func (s prepareService) RemoveProfile(ctx context.Context, profile string) error {
	return s.pool.Remove(ctx, profile)
}

func (prepareService) Shutdown(context.Context) error { return nil }

func (prepareService) Start(context.Context, executor.Spec) (executor.Lease, error) {
	return nil, errors.New("not part of the prepare golden")
}
