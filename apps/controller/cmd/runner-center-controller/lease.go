package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"time"

	"github.com/Fanzzzd/erainfra/apps/controller/internal/cachefacts"
	"github.com/Fanzzzd/erainfra/apps/controller/internal/config"
	rccontroller "github.com/Fanzzzd/erainfra/apps/controller/internal/controller"
	"github.com/Fanzzzd/erainfra/apps/controller/internal/convexstore"
	"github.com/Fanzzzd/erainfra/apps/controller/internal/fleet"
	"github.com/Fanzzzd/erainfra/apps/controller/internal/githubapi"
	"github.com/Fanzzzd/erainfra/apps/controller/internal/githubscale"
	"github.com/Fanzzzd/erainfra/apps/controller/internal/heartbeat"
	"github.com/actions/scaleset"
	"github.com/actions/scaleset/listener"
)

func serveLeased(ctx context.Context, cfg config.Config, logger *slog.Logger) error {
	store, err := convexstore.New(cfg.ConvexURL, cfg.Credential(), nil)
	if err != nil {
		return err
	}
	// A dedicated host registers its env contract once when started, including
	// intentionally reviving a retired Profile. It never revives one again while
	// this process runs, so an operator's retire stays paused even with standbys.
	store.ActivateProfile = cfg.MachineToken == ""
	store.CanPublishCacheFacts = cfg.CacheFactsURL != "" && cfg.CacheSigningKey != ""
	hostname, err := os.Hostname()
	if err != nil {
		hostname = "controller"
	}
	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		return err
	}
	instance := hex.EncodeToString(random)
	registered := false
	supervisor := rccontroller.LeaseSupervisor{
		Store: store, Profile: cfg.Profile, Hostname: hostname, Instance: instance, Logger: logger,
		Standby: func(ctx context.Context, grant fleet.LeaseGrant) {
			logger.Info("controller standing by", "profile", cfg.Profile, "reason", grant.Reason, "holder", grant.Holder, "networkPoor", grant.NetworkPoor, "retryIn", grant.RetryAfter())
			reportCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			defer cancel()
			if err := store.SendHeartbeat(reportCtx, fleet.ControllerHeartbeat{
				Profile: cfg.Profile, Hostname: hostname, Version: version, SessionState: fleet.SessionStandby, LeaseRole: "standby",
			}); err != nil {
				logger.Warn("could not report standby heartbeat", "error", err)
			}
		},
		RunHolder: func(ctx context.Context, grant fleet.LeaseGrant, lost context.CancelFunc) error {
			leased := store.WithLease(grant.Epoch, lost)
			serving := cfg
			if cfg.MachineToken != "" || registered {
				var err error
				serving, err = cfg.WithProfile(grant.Profile)
				if err != nil {
					return err
				}
			} else {
				if err := leased.RegisterProfile(ctx, cfg.ProfileSpec()); err != nil {
					return fmt.Errorf("register Profile: %w", err)
				}
				registered = true
			}
			return runHolder(ctx, serving, leased, hostname, grant.Epoch, logger)
		},
	}
	return supervisor.Run(ctx)
}

type servingClient interface {
	githubscale.Client
	SetSystemInfo(scaleset.SystemInfo)
	MessageSessionClient(context.Context, int, string, ...scaleset.HTTPOption) (*scaleset.MessageSessionClient, error)
}

func runHolder(ctx context.Context, cfg config.Config, store *convexstore.Store, hostname string, epoch int64, logger *slog.Logger) (runErr error) {
	// Report the grant before minting credentials or contacting GitHub. A failed
	// initialization must be visible too, not indistinguishable from no process.
	reporter := heartbeat.New(store, fleet.ControllerHeartbeat{
		Profile: cfg.Profile, Hostname: hostname, Version: version, LeaseRole: "holder", LeaseEpoch: epoch,
	}, heartbeat.WithLogger(logger.WithGroup("heartbeat")))
	reportCtx, stopReporting := context.WithCancel(context.WithoutCancel(ctx))
	reporting := make(chan struct{})
	go func() { defer close(reporting); reporter.Run(reportCtx) }()
	defer func() {
		reporter.SetSession(fleet.SessionStopped, runErr)
		stopReporting()
		<-reporting
	}()
	var source *githubscale.TokenSource
	var client servingClient
	var err error
	if cfg.MachineToken != "" {
		source, err = githubscale.NewTokenSource(func(ctx context.Context) (string, time.Time, error) {
			return store.GitHubToken(ctx, cfg.Profile, cfg.CacheFactsURL != "")
		})
		if err != nil {
			return err
		}
		if _, err := source.Token(ctx); err != nil {
			return fmt.Errorf("obtain GitHub installation token: %w", err)
		}
		refreshCtx, stop := context.WithCancel(ctx)
		defer stop()
		go func() { _ = source.Run(refreshCtx) }()
		client, err = githubscale.NewClientWithTokenSource(cfg.RegistrationURL, source.Token, systemInfo(0))
	} else {
		client, err = newGitHubClient(cfg)
	}
	if err != nil {
		return err
	}
	scaleSet, err := githubscale.EnsureScaleSet(ctx, client, githubscale.ScaleSetSpec{Name: cfg.ScaleSetName, RunnerGroup: cfg.RunnerGroup, Labels: cfg.Labels})
	if err != nil {
		return err
	}
	client.SetSystemInfo(systemInfo(scaleSet.ID))
	issuer, err := githubscale.NewIssuer(client, scaleSet.ID)
	if err != nil {
		return err
	}
	scalerOpts, err := cacheOptionsWithToken(cfg, logger, source)
	if err != nil {
		return err
	}
	scalerOpts = append(scalerOpts, rccontroller.WithRunnerLogger(logger.WithGroup("runners")))
	scaler, err := rccontroller.NewScaler(rccontroller.Config{
		Profile: cfg.Profile, Executor: cfg.Executor, ImageRelease: cfg.ImageRelease, VCPUs: cfg.VCPUs, MemoryMiB: cfg.MemoryMiB, MinRunners: cfg.MinRunners, MaxRunners: cfg.MaxRunners,
	}, store, issuer, func() (string, error) { return githubscale.RunnerName(cfg.Profile) }, scalerOpts...)
	if err != nil {
		return err
	}
	reporter.SetScaleSetID(scaleSet.ID)
	supervisor := rccontroller.SessionSupervisor{
		Open: func(ctx context.Context) (rccontroller.MessageSession, error) {
			return client.MessageSessionClient(ctx, scaleSet.ID, hostname+":"+cfg.Profile)
		},
		Listen: func(ctx context.Context, session listener.Client) error {
			listenerLogger := logger.WithGroup("listener")
			observed := reporter.Observe(session)
			scaleSetListener, err := listener.New(observed, listener.Config{ScaleSetID: scaleSet.ID, MaxRunners: cfg.MaxRunners, Logger: listenerLogger})
			if err != nil {
				return err
			}
			logger.Info("runner scale-set controller started", "profile", cfg.Profile, "scaleSetID", scaleSet.ID, "epoch", epoch)
			return scaleSetListener.Run(ctx, scaler.ForSession(observed, listenerLogger))
		}, Observer: reporter, Logger: logger.WithGroup("session"),
	}
	runErr = supervisor.Run(ctx)
	if errors.Is(runErr, context.Canceled) {
		runErr = nil
	}
	return runErr
}

// Both the scale-set client and the cache lookups use the same rotating
// installation token. A dedicated host keeps its existing App or PAT path.
func cacheOptionsWithToken(cfg config.Config, logger *slog.Logger, source *githubscale.TokenSource) ([]rccontroller.Option, error) {
	if source == nil {
		return cacheOptions(cfg, logger)
	}
	if cfg.CacheFactsURL == "" {
		return nil, nil
	}
	publisher, err := cachefacts.New(cfg.CacheFactsURL, []byte(cfg.CacheSigningKey), cacheFactsTTL)
	if err != nil {
		return nil, err
	}
	apiURL, err := githubapi.APIURL(cfg.RegistrationURL)
	if err != nil {
		return nil, err
	}
	runs, err := githubapi.New(githubapi.Config{APIURL: apiURL, TokenSource: source.Token})
	if err != nil {
		return nil, err
	}
	return []rccontroller.Option{rccontroller.WithCachePublisher(publisher, logger.WithGroup("cachefacts")), rccontroller.WithWorkflowRuns(runs)}, nil
}
