// Package executor defines the platform-neutral execution boundary shared by
// CI Jobs and interactive Experiments.
package executor

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
)

var (
	safeIdentity = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
	digestImage  = regexp.MustCompile(`@sha256:[a-f0-9]{64}$`)
)

type Spec struct {
	Kind         string
	AttemptID    string
	RunnerName   string
	Profile      string
	ImageRelease string
	VCPUs        int64
	MemoryMiB    int64
	JITConfig    string
	Command      []string
	ResultToken  string
}

func (s Spec) Validate() error {
	if !safeIdentity.MatchString(s.AttemptID) {
		return errors.New("attempt ID must be a safe 1-128 character identity")
	}
	if !safeIdentity.MatchString(s.RunnerName) {
		return errors.New("runner name must be a safe 1-128 character identity")
	}
	if strings.TrimSpace(s.Profile) == "" {
		return errors.New("profile is required")
	}
	if !digestImage.MatchString(s.ImageRelease) {
		return errors.New("image release must be pinned by sha256 digest")
	}
	if s.VCPUs < 1 || s.VCPUs > 64 {
		return fmt.Errorf("vCPUs must be between 1 and 64")
	}
	if s.MemoryMiB < 512 || s.MemoryMiB > 262_144 {
		return fmt.Errorf("memory must be between 512 and 262144 MiB")
	}
	switch s.Kind {
	case "", "ci":
		if s.JITConfig == "" {
			return errors.New("JIT configuration is required for CI")
		}
		if len(s.Command) != 0 {
			return errors.New("CI must not carry an Experiment command")
		}
	case "experiment":
		if s.JITConfig != "" {
			return errors.New("an Experiment must not carry JIT configuration")
		}
		if len(s.Command) == 0 || len(s.Command) > 32 {
			return errors.New("an Experiment command requires 1-32 arguments")
		}
		if !safeIdentity.MatchString(s.ResultToken) {
			return errors.New("an Experiment result token must be a safe identity")
		}
	default:
		return errors.New("kind must be ci or experiment")
	}
	return nil
}

type Result struct {
	ExitCode int
}

type Lease interface {
	Wait(ctx context.Context) (Result, error)
	Cancel(ctx context.Context) error
}

type Executor interface {
	Preflight(ctx context.Context) error
	PrepareImage(ctx context.Context, imageRelease string) error
	Start(ctx context.Context, spec Spec) (Lease, error)
}
