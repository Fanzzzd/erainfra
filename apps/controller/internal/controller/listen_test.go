package controller

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/actions/scaleset"
	"github.com/actions/scaleset/listener"
)

// scriptedQueue is a message session that answers each poll from a script and
// records what the listener and the Scaler do with it.
type scriptedQueue struct {
	statistics *scaleset.RunnerScaleSetStatistic
	polls      []func() (*scaleset.RunnerScaleSetMessage, error)
	acquireErr error

	acquired [][]int64
	deleted  []int
}

func (q *scriptedQueue) Session() scaleset.RunnerScaleSetSession {
	var session scaleset.RunnerScaleSetSession
	session.SessionID[0] = 1
	session.Statistics = q.statistics
	return session
}

func (q *scriptedQueue) GetMessage(context.Context, int, int) (*scaleset.RunnerScaleSetMessage, error) {
	next := q.polls[0]
	q.polls = q.polls[1:]
	return next()
}

func (q *scriptedQueue) DeleteMessage(_ context.Context, messageID int) error {
	q.deleted = append(q.deleted, messageID)
	return nil
}

func (q *scriptedQueue) AcquireJobs(_ context.Context, ids []int64) ([]int64, error) {
	q.acquired = append(q.acquired, ids)
	return ids, q.acquireErr
}

func runScripted(t *testing.T, scaler *Scaler, queue *scriptedQueue) error {
	t.Helper()
	l, err := listener.New(queue, listener.Config{ScaleSetID: 1, MaxRunners: 4})
	if err != nil {
		t.Fatal(err)
	}
	return l.Run(t.Context(), scaler.ForSession(queue, nil))
}

func request(id int64) scaleset.JobMessageBase {
	return scaleset.JobMessageBase{RunnerRequestID: id}
}

// The listener hands the Scaler whole messages. The session adapter must still
// converge on the session's statistics before the first poll, take every job
// on offer, record the lifecycle messages, and keep converging on the last
// statistics while the long poll comes back empty.
func TestSessionScalerAcquiresRecordsAndConverges(t *testing.T) {
	store := &fakeStore{}
	scaler, err := NewScaler(validConfig("erainfra-4vcpu-ubuntu-2404", 4), store, &fakeIssuer{},
		names("erainfra-4vcpu-ubuntu-2404-a", "erainfra-4vcpu-ubuntu-2404-b", "erainfra-4vcpu-ubuntu-2404-c", "erainfra-4vcpu-ubuntu-2404-d"))
	if err != nil {
		t.Fatal(err)
	}
	stop := errors.New("end of script")
	queue := &scriptedQueue{statistics: &scaleset.RunnerScaleSetStatistic{TotalAssignedJobs: 1}}
	queue.polls = []func() (*scaleset.RunnerScaleSetMessage, error){
		func() (*scaleset.RunnerScaleSetMessage, error) {
			if len(store.created) != 1 {
				t.Errorf("before the first poll: created %d attempts, want 1 from the session statistics", len(store.created))
			}
			return &scaleset.RunnerScaleSetMessage{
				MessageID:            1,
				Statistics:           &scaleset.RunnerScaleSetStatistic{TotalAssignedJobs: 2},
				JobAvailableMessages: []*scaleset.JobAvailable{{JobMessageBase: request(11)}, {JobMessageBase: request(12)}},
				JobStartedMessages:   []*scaleset.JobStarted{{RunnerName: "erainfra-4vcpu-ubuntu-2404-a", JobMessageBase: request(11)}},
				JobCompletedMessages: []*scaleset.JobCompleted{
					{RunnerName: "erainfra-4vcpu-ubuntu-2404-a", Result: "succeeded", JobMessageBase: request(11)},
				},
			}, nil
		},
		func() (*scaleset.RunnerScaleSetMessage, error) {
			if len(store.created) != 2 {
				t.Errorf("after message 1: created %d attempts, want 2", len(store.created))
			}
			// The completed Attempt leaves the active set. The empty poll that
			// follows must replace it from the statistics message 1 carried.
			store.active = store.active[1:]
			return nil, nil
		},
		func() (*scaleset.RunnerScaleSetMessage, error) { return nil, stop },
	}

	if err := runScripted(t, scaler, queue); !errors.Is(err, stop) {
		t.Fatalf("Run = %v, want the scripted stop", err)
	}
	if !reflect.DeepEqual(queue.acquired, [][]int64{{11, 12}}) {
		t.Fatalf("acquired = %v, want [[11 12]]", queue.acquired)
	}
	if !reflect.DeepEqual(queue.deleted, []int{1}) {
		t.Fatalf("acked = %v, want [1]", queue.deleted)
	}
	if started := store.startedEvents(true); len(started) != 1 || started[0].RunnerName != "erainfra-4vcpu-ubuntu-2404-a" {
		t.Fatalf("started = %+v", started)
	}
	if len(store.completed) != 1 || store.completed[0].Result != "succeeded" {
		t.Fatalf("completed = %+v", store.completed)
	}
	if len(store.created) != 3 {
		t.Fatalf("created %d attempts, want 3: the empty poll did not reconverge", len(store.created))
	}
}

// A message the Scaler could not handle is not acked, so GitHub delivers it
// again on the next poll.
func TestSessionScalerLeavesAFailedMessageUnacked(t *testing.T) {
	store := &fakeStore{}
	scaler, err := NewScaler(validConfig("erainfra-4vcpu-ubuntu-2404", 4), store, &fakeIssuer{}, names("erainfra-4vcpu-ubuntu-2404-a"))
	if err != nil {
		t.Fatal(err)
	}
	refused := errors.New("acquire refused")
	queue := &scriptedQueue{statistics: &scaleset.RunnerScaleSetStatistic{}, acquireErr: refused}
	queue.polls = []func() (*scaleset.RunnerScaleSetMessage, error){
		func() (*scaleset.RunnerScaleSetMessage, error) {
			return &scaleset.RunnerScaleSetMessage{
				MessageID:            5,
				Statistics:           &scaleset.RunnerScaleSetStatistic{TotalAssignedJobs: 1},
				JobAvailableMessages: []*scaleset.JobAvailable{{JobMessageBase: request(21)}},
			}, nil
		},
	}
	if err := runScripted(t, scaler, queue); !errors.Is(err, refused) {
		t.Fatalf("Run = %v, want the acquire error", err)
	}
	if len(queue.deleted) != 0 {
		t.Fatalf("acked %v after a failed message", queue.deleted)
	}
	if len(store.created) != 0 {
		t.Fatalf("created %d attempts after the acquire failed; the message stops there", len(store.created))
	}
}
