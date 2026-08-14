package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/Fanzzzd/EraInfra/apps/controller/internal/config"
	rccontroller "github.com/Fanzzzd/EraInfra/apps/controller/internal/controller"
	"github.com/Fanzzzd/EraInfra/apps/controller/internal/convexstore"
	"github.com/Fanzzzd/EraInfra/apps/controller/internal/fleet"
	"github.com/Fanzzzd/EraInfra/apps/controller/internal/githubscale"
	"github.com/actions/scaleset"
	"github.com/actions/scaleset/listener"
)

var (
	version   = "dev"
	commitSHA = "unknown"
)

func main() {
	if len(os.Args) == 2 && os.Args[1] == "version" {
		fmt.Printf("runner-center-controller %s (%s)\n", version, commitSHA)
		return
	}
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("load configuration: %w", err)
	}
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: cfg.LogLevel}))
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	store, err := convexstore.New(cfg.ConvexURL, cfg.ControllerToken, nil)
	if err != nil {
		return fmt.Errorf("configure Fleet client: %w", err)
	}
	if err := store.RegisterProfile(ctx, fleet.ProfileSpec{
		Name:         cfg.Profile,
		ScaleSetName: cfg.ScaleSetName,
		Executor:     cfg.Executor,
		ImageRelease: cfg.ImageRelease,
		VCPUs:        cfg.VCPUs,
		MemoryMiB:    cfg.MemoryMiB,
		FitPolicy:    cfg.FitPolicy,
		MinRunners:   cfg.MinRunners,
		MaxRunners:   cfg.MaxRunners,
	}); err != nil {
		return fmt.Errorf("register Profile: %w", err)
	}
	client, err := newGitHubClient(cfg)
	if err != nil {
		return fmt.Errorf("configure GitHub client: %w", err)
	}

	scaleSet, err := githubscale.EnsureScaleSet(ctx, client, githubscale.ScaleSetSpec{
		Name:        cfg.ScaleSetName,
		RunnerGroup: cfg.RunnerGroup,
		Labels:      cfg.Labels,
	})
	if err != nil {
		return err
	}
	client.SetSystemInfo(systemInfo(scaleSet.ID))

	hostname, err := os.Hostname()
	if err != nil {
		hostname = "controller"
	}
	owner := hostname + ":" + cfg.Profile
	session, err := client.MessageSessionClient(ctx, scaleSet.ID, owner)
	if err != nil {
		return fmt.Errorf("create GitHub message session: %w", err)
	}
	defer func() {
		if err := session.Close(context.Background()); err != nil {
			logger.Error("failed to close GitHub message session", "error", err)
		}
	}()

	issuer, err := githubscale.NewIssuer(client, scaleSet.ID)
	if err != nil {
		return err
	}
	scaler, err := rccontroller.NewScaler(
		rccontroller.Config{
			Profile:      cfg.Profile,
			Executor:     cfg.Executor,
			ImageRelease: cfg.ImageRelease,
			VCPUs:        cfg.VCPUs,
			MemoryMiB:    cfg.MemoryMiB,
			MinRunners:   cfg.MinRunners,
			MaxRunners:   cfg.MaxRunners,
		},
		store,
		issuer,
		func() (string, error) { return githubscale.RunnerName(cfg.Profile) },
	)
	if err != nil {
		return err
	}
	scaleSetListener, err := listener.New(session, listener.Config{
		ScaleSetID: scaleSet.ID,
		MaxRunners: cfg.MaxRunners,
		Logger:     logger.WithGroup("listener"),
	})
	if err != nil {
		return fmt.Errorf("configure GitHub scale-set listener: %w", err)
	}

	logger.Info(
		"runner scale-set controller started",
		"profile", cfg.Profile,
		"scaleSet", cfg.ScaleSetName,
		"scaleSetID", scaleSet.ID,
		"maxRunners", cfg.MaxRunners,
		"fitPolicy", cfg.FitPolicy,
	)
	if err := scaleSetListener.Run(ctx, scaler); err != nil && !errors.Is(err, context.Canceled) {
		return fmt.Errorf("run GitHub scale-set listener: %w", err)
	}
	return nil
}

func newGitHubClient(cfg config.Config) (*scaleset.Client, error) {
	info := systemInfo(0)
	if cfg.GitHubApp != nil {
		return scaleset.NewClientWithGitHubApp(scaleset.ClientWithGitHubAppConfig{
			GitHubConfigURL: cfg.RegistrationURL,
			GitHubAppAuth:   *cfg.GitHubApp,
			SystemInfo:      info,
		})
	}
	return scaleset.NewClientWithPersonalAccessToken(
		scaleset.NewClientWithPersonalAccessTokenConfig{
			GitHubConfigURL:     cfg.RegistrationURL,
			PersonalAccessToken: cfg.GitHubToken,
			SystemInfo:          info,
		},
	)
}

func systemInfo(scaleSetID int) scaleset.SystemInfo {
	return scaleset.SystemInfo{
		System:     "erainfra",
		Subsystem:  "scale-set-controller",
		Version:    version,
		CommitSHA:  commitSHA,
		ScaleSetID: scaleSetID,
	}
}
