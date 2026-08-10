//go:build !linux

package firecracker

import (
	"context"
	"errors"

	"github.com/Fanzzzd/runner-center/apps/runtime/internal/executor"
)

var errUnsupported = errors.New("Firecracker executor requires Linux with KVM")

type Runtime struct{}

func New(Config) (*Runtime, error) { return &Runtime{}, nil }

func (*Runtime) Preflight(context.Context) (executor.Report, error) {
	return executor.Report{
		Isolation: executor.IsolationFirecracker,
		Boundary:  executor.BoundaryGuestKernel,
		Checks: []executor.Check{{
			Name:   executor.CheckKVM,
			Passed: false,
			Detail: errUnsupported.Error(),
		}},
	}, errUnsupported
}

func (*Runtime) PrepareImage(context.Context, string) error { return errUnsupported }

func (*Runtime) Start(context.Context, executor.Spec) (executor.Lease, error) {
	return nil, errUnsupported
}

var _ executor.Executor = (*Runtime)(nil)
