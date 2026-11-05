package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/Fanzzzd/erainfra/apps/controller/internal/cachefacts"
	"github.com/Fanzzzd/erainfra/apps/controller/internal/config"
	rccontroller "github.com/Fanzzzd/erainfra/apps/controller/internal/controller"
	"github.com/Fanzzzd/erainfra/apps/controller/internal/convexstore"
	"github.com/Fanzzzd/erainfra/apps/controller/internal/fleet"
	"github.com/Fanzzzd/erainfra/apps/controller/internal/githubapi"
	"github.com/Fanzzzd/erainfra/apps/controller/internal/githubscale"
	"github.com/actions/scaleset"
	"github.com/actions/scaleset/listener"
)

// cacheFactsTTL is how long a pushed job's facts stay usable. It must outlive the
// job so the cache keeps working for its whole run; GitHub's default job timeout
// is six hours, and a longer-running job simply reads a cold cache past this
// point. The entries are tiny and a runner name is never reused, so erring long
// costs only trivial memory.
const cacheFactsTTL = 6 * time.Hour

var (
	version   = "dev"
	commitSHA = "unknown"
)

func main() {
	if len(os.Args) == 2 && os.Args[1] == "version" {
		fmt.Printf("runner-center-controller %s (%s)\n", version, commitSHA)
		return
	}
	if len(os.Args) >= 2 && os.Args[1] == "retire" {
		if err := retire(os.Args[2:]); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
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
	if !config.ProfileNameFollowsScheme(cfg.Profile) {
		logger.Warn("profile name does not follow ADR 0010; it is still served, and a renamed Profile is registered beside it rather than renamed in place",
			"profile", cfg.Profile, "scheme", "erainfra-<N>vcpu-<os><version>[-arm][-<M>gb]")
	}
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
		WarmPool:     cfg.WarmPool,
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
	scalerOpts, err := cacheOptions(cfg, logger)
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
		scalerOpts...,
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

// cacheOptions builds the Scaler's cache-publishing option when a cache service
// is configured. With no RC_CACHE_FACTS_URL it returns nothing, and the
// controller runs exactly as it did before the cache existed.
func cacheOptions(cfg config.Config, logger *slog.Logger) ([]rccontroller.Option, error) {
	if cfg.CacheFactsURL == "" {
		return nil, nil
	}
	publisher, err := cachefacts.New(cfg.CacheFactsURL, []byte(cfg.CacheSigningKey), cacheFactsTTL)
	if err != nil {
		return nil, fmt.Errorf("configure cache facts client: %w", err)
	}
	// The cache scope is derived from the job's workflow run, read with the same
	// credentials the scale set uses. A failed lookup at JobStarted gives that
	// job read-only facts with nothing to read; it never widens the scope.
	apiURL, err := githubapi.APIURL(cfg.RegistrationURL)
	if err != nil {
		return nil, fmt.Errorf("configure GitHub API client: %w", err)
	}
	runs, err := githubapi.New(githubapi.Config{
		APIURL: apiURL,
		Token:  cfg.GitHubToken,
		App:    cfg.GitHubApp,
	})
	if err != nil {
		return nil, fmt.Errorf("configure GitHub API client: %w", err)
	}
	logger.Info("cache facts publishing enabled", "url", cfg.CacheFactsURL, "githubAPI", apiURL)
	return []rccontroller.Option{
		rccontroller.WithCachePublisher(publisher, logger.WithGroup("cachefacts")),
		rccontroller.WithWorkflowRuns(runs),
	}, nil
}

// retire deletes the Profile's GitHub scale set and pauses the Profile in the
// control plane. It reads the same environment as the service, so an operator
// runs it with the Profile's env file loaded after stopping that Profile's unit.
// Without --yes it only reports what it would do.
func retire(args []string) error {
	flags := flag.NewFlagSet("retire", flag.ContinueOnError)
	apply := flags.Bool("yes", false, "delete the scale set and pause the Profile; without it, only report")
	force := flags.Bool("force", false, "delete even while GitHub still counts busy runners or jobs on the scale set")
	flags.Usage = func() {
		_, _ = fmt.Fprintln(flags.Output(), "usage: runner-center-controller retire [--yes] [--force]")
		_, _ = fmt.Fprintln(flags.Output(), "Deletes the GitHub scale set named by RC_SCALE_SET_NAME (default RC_PROFILE) and pauses the Profile.")
		_, _ = fmt.Fprintln(flags.Output(), "Stop the Profile's controller unit first, or it re-registers both within seconds.")
		flags.PrintDefaults()
	}
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("load configuration: %w", err)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	client, err := newGitHubClient(cfg)
	if err != nil {
		return fmt.Errorf("configure GitHub client: %w", err)
	}
	plan, err := githubscale.Retire(ctx, client, cfg.ScaleSetName, cfg.RunnerGroup, *apply, *force)
	if err != nil {
		return err
	}
	switch {
	case !plan.Found:
		fmt.Printf("no scale set named %q is registered at %s\n", plan.Name, cfg.RegistrationURL)
	case !*apply:
		fmt.Printf("would delete scale set %q (id %d): %d busy runner(s), %d assigned, %d running job(s)\n",
			plan.Name, plan.ID, plan.BusyRunners, plan.AssignedJobs, plan.RunningJobs)
	default:
		fmt.Printf("deleted scale set %q (id %d)\n", plan.Name, plan.ID)
	}
	if !*apply {
		fmt.Printf("would pause Profile %q in the control plane; rerun with --yes to do both\n", cfg.Profile)
		return nil
	}
	store, err := convexstore.New(cfg.ConvexURL, cfg.ControllerToken, nil)
	if err != nil {
		return fmt.Errorf("configure Fleet client: %w", err)
	}
	found, err := store.PauseProfile(ctx, cfg.Profile)
	if err != nil {
		return fmt.Errorf("pause Profile %q: %w", cfg.Profile, err)
	}
	if found {
		fmt.Printf("paused Profile %q; Workers stop advertising it on their next refresh\n", cfg.Profile)
	} else {
		fmt.Printf("the control plane has no Profile %q; nothing to pause\n", cfg.Profile)
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
