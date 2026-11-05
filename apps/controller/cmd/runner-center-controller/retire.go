package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"

	"github.com/Fanzzzd/erainfra/apps/controller/internal/config"
	rccontroller "github.com/Fanzzzd/erainfra/apps/controller/internal/controller"
	"github.com/Fanzzzd/erainfra/apps/controller/internal/convexstore"
	"github.com/Fanzzzd/erainfra/apps/controller/internal/fleet"
	"github.com/Fanzzzd/erainfra/apps/controller/internal/githubscale"
)

// Retirement is a holder too. Pause before deletion, so a Worker standby cannot
// acquire and recreate the scale set between its deletion and the pause.
func retireLeased(ctx context.Context, cfg config.Config, client githubscale.RetireClient, force bool) error {
	if cfg.MachineToken != "" {
		return errors.New("retire requires a dedicated host's controller credential and GitHub settings")
	}
	store, err := convexstore.New(cfg.ConvexURL, cfg.ControllerToken, nil)
	if err != nil {
		return err
	}
	store.ActivateProfile = true // A retry may be completing an already-paused retirement.
	host, _ := os.Hostname()
	if host == "" {
		host = "retire"
	}
	id := make([]byte, 16)
	if _, err := rand.Read(id); err != nil {
		return err
	}
	life, stop := context.WithCancel(ctx)
	defer stop()
	var result error
	supervisor := rccontroller.LeaseSupervisor{
		Store: store, Profile: cfg.Profile, Hostname: host, Instance: hex.EncodeToString(id),
		Standby: func(_ context.Context, grant fleet.LeaseGrant) {
			if grant.Holder != "" {
				result = fmt.Errorf("cannot retire: %s holds this Profile's lease; stop every instance, including Worker standbys, and retry", grant.Holder)
			} else {
				result = fmt.Errorf("cannot retire: the control plane did not grant this Profile's lease (%s)", grant.Reason)
			}
			stop()
		},
		RunHolder: func(holder context.Context, grant fleet.LeaseGrant, lost context.CancelFunc) error {
			if err := retireUnderLease(holder, client, store.WithLease(grant.Epoch, lost), cfg, force); err != nil {
				return err
			}
			fmt.Printf("retired scale set %q; Profile %q is paused\n", cfg.ScaleSetName, cfg.Profile)
			stop()
			return nil
		},
	}
	if err := supervisor.Run(life); err != nil {
		return err
	}
	return result
}

// profilePauser is the one control-plane write retirement makes, under the lease.
type profilePauser interface {
	PauseProfile(ctx context.Context, name string) (bool, error)
}

// retireUnderLease runs every refusal Retire makes before it pauses anything:
// unknown activity statistics and busy counters both stop retirement unless
// forced (#182), so a refusal never leaves a paused Profile behind. Only then
// does it pause, which keeps standbys from re-creating the scale set, and
// delete.
func retireUnderLease(ctx context.Context, client githubscale.RetireClient, pauser profilePauser, cfg config.Config, force bool) error {
	plan, err := githubscale.Retire(ctx, client, cfg.ScaleSetName, cfg.RunnerGroup, false, force)
	if err != nil {
		return err
	}
	if plan.Found && !plan.StatisticsKnown && !force {
		return fmt.Errorf("scale set %q has unknown activity statistics; refusing deletion without --force", plan.Name)
	}
	if plan.Found && plan.Busy() && !force {
		return fmt.Errorf(
			"scale set %q still has %d busy runner(s), %d assigned and %d running job(s); stop sending it work and retry, or pass --force if its controller is gone for good",
			plan.Name, plan.BusyRunners, plan.AssignedJobs, plan.RunningJobs,
		)
	}
	if _, err := pauser.PauseProfile(ctx, cfg.Profile); err != nil {
		return fmt.Errorf("pause Profile %q: %w", cfg.Profile, err)
	}
	if _, err := githubscale.Retire(ctx, client, cfg.ScaleSetName, cfg.RunnerGroup, true, force); err != nil {
		return fmt.Errorf("the Profile is paused but deleting its scale set failed; rerun retire --yes: %w", err)
	}
	return nil
}
