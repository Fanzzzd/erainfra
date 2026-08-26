package config

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"regexp"
	"strconv"
	"strings"

	"github.com/actions/scaleset"
)

type Config struct {
	ConvexURL       string
	ControllerToken string
	RegistrationURL string
	Profile         string
	Executor        string
	ImageRelease    string
	VCPUs           int64
	MemoryMiB       int64
	WarmPool        int
	FitPolicy       string
	ScaleSetName    string
	Labels          []string
	RunnerGroup     string
	MinRunners      int
	MaxRunners      int
	LogLevel        slog.Level
	GitHubApp       *scaleset.GitHubAppAuth
	GitHubToken     string
	CacheFactsURL   string
	CacheSigningKey string
}

func Load() (Config, error) {
	config := Config{
		ConvexURL:       strings.TrimSpace(os.Getenv("RC_CONVEX_URL")),
		RegistrationURL: strings.TrimSpace(os.Getenv("RC_GITHUB_CONFIG_URL")),
		Profile:         strings.TrimSpace(os.Getenv("RC_PROFILE")),
		Executor:        strings.TrimSpace(os.Getenv("RC_EXECUTOR")),
		ImageRelease:    strings.TrimSpace(os.Getenv("RC_IMAGE_RELEASE")),
		ScaleSetName:    strings.TrimSpace(os.Getenv("RC_SCALE_SET_NAME")),
		RunnerGroup:     strings.TrimSpace(os.Getenv("RC_RUNNER_GROUP")),
		MinRunners:      0,
		MaxRunners:      1,
		VCPUs:           2,
		MemoryMiB:       4096,
		FitPolicy:       "balanced",
		WarmPool:        0,
		LogLevel:        slog.LevelInfo,
	}
	if value := strings.ToLower(strings.TrimSpace(os.Getenv("RC_FIT_POLICY"))); value != "" {
		config.FitPolicy = value
	}
	if config.ScaleSetName == "" {
		config.ScaleSetName = config.Profile
	}
	if config.RunnerGroup == "" {
		config.RunnerGroup = scaleset.DefaultRunnerGroup
	}
	for _, label := range strings.Split(os.Getenv("RC_LABELS"), ",") {
		if value := strings.TrimSpace(label); value != "" {
			config.Labels = append(config.Labels, value)
		}
	}
	if len(config.Labels) == 0 && config.Profile != "" {
		config.Labels = []string{config.Profile}
	}

	var err error
	config.ControllerToken, err = readSecret("RC_CONTROLLER_TOKEN", "RC_CONTROLLER_TOKEN_FILE")
	if err != nil {
		return Config{}, err
	}
	config.GitHubToken, err = readSecret("RC_GITHUB_TOKEN", "RC_GITHUB_TOKEN_FILE")
	if err != nil {
		return Config{}, err
	}
	config.CacheFactsURL = strings.TrimSpace(os.Getenv("RC_CACHE_FACTS_URL"))
	config.CacheSigningKey, err = readSecret("RC_CACHE_SIGNING_KEY", "RC_CACHE_SIGNING_KEY_FILE")
	if err != nil {
		return Config{}, err
	}
	privateKey, err := readSecret("RC_GITHUB_APP_PRIVATE_KEY", "RC_GITHUB_APP_PRIVATE_KEY_FILE")
	if err != nil {
		return Config{}, err
	}

	if value := strings.TrimSpace(os.Getenv("RC_MIN_RUNNERS")); value != "" {
		config.MinRunners, err = strconv.Atoi(value)
		if err != nil {
			return Config{}, fmt.Errorf("RC_MIN_RUNNERS must be an integer: %w", err)
		}
	}
	if value := strings.TrimSpace(os.Getenv("RC_MAX_RUNNERS")); value != "" {
		config.MaxRunners, err = strconv.Atoi(value)
		if err != nil {
			return Config{}, fmt.Errorf("RC_MAX_RUNNERS must be an integer: %w", err)
		}
	}
	if value := strings.TrimSpace(os.Getenv("RC_VCPUS")); value != "" {
		config.VCPUs, err = strconv.ParseInt(value, 10, 64)
		if err != nil {
			return Config{}, fmt.Errorf("RC_VCPUS must be an integer: %w", err)
		}
	}
	if value := strings.TrimSpace(os.Getenv("RC_MEMORY_MIB")); value != "" {
		config.MemoryMiB, err = strconv.ParseInt(value, 10, 64)
		if err != nil {
			return Config{}, fmt.Errorf("RC_MEMORY_MIB must be an integer: %w", err)
		}
	}
	if value := strings.TrimSpace(os.Getenv("RC_WARM_POOL")); value != "" {
		config.WarmPool, err = strconv.Atoi(value)
		if err != nil {
			return Config{}, fmt.Errorf("RC_WARM_POOL must be an integer: %w", err)
		}
	}
	switch strings.ToLower(strings.TrimSpace(os.Getenv("RC_LOG_LEVEL"))) {
	case "", "info":
	case "debug":
		config.LogLevel = slog.LevelDebug
	case "warn":
		config.LogLevel = slog.LevelWarn
	case "error":
		config.LogLevel = slog.LevelError
	default:
		return Config{}, fmt.Errorf("RC_LOG_LEVEL must be debug, info, warn, or error")
	}

	clientID := strings.TrimSpace(os.Getenv("RC_GITHUB_APP_CLIENT_ID"))
	installation := strings.TrimSpace(os.Getenv("RC_GITHUB_APP_INSTALLATION_ID"))
	if clientID != "" || installation != "" || privateKey != "" {
		installationID, parseErr := strconv.ParseInt(installation, 10, 64)
		if parseErr != nil || installationID <= 0 {
			return Config{}, errors.New("RC_GITHUB_APP_INSTALLATION_ID must be a positive integer")
		}
		config.GitHubApp = &scaleset.GitHubAppAuth{
			ClientID:       clientID,
			InstallationID: installationID,
			PrivateKey:     privateKey,
		}
		if err := config.GitHubApp.Validate(); err != nil {
			return Config{}, fmt.Errorf("invalid GitHub App credentials: %w", err)
		}
	}

	if err := config.Validate(); err != nil {
		return Config{}, err
	}
	return config, nil
}

func (c Config) Validate() error {
	for name, value := range map[string]string{
		"RC_CONVEX_URL":        c.ConvexURL,
		"RC_CONTROLLER_TOKEN":  c.ControllerToken,
		"RC_GITHUB_CONFIG_URL": c.RegistrationURL,
		"RC_PROFILE":           c.Profile,
		"RC_EXECUTOR":          c.Executor,
		"RC_IMAGE_RELEASE":     c.ImageRelease,
		"RC_SCALE_SET_NAME":    c.ScaleSetName,
	} {
		if strings.TrimSpace(value) == "" {
			return fmt.Errorf("%s is required", name)
		}
	}
	if c.MinRunners < 0 || c.MaxRunners < 1 || c.MinRunners > c.MaxRunners {
		return errors.New("runner bounds require 0 <= RC_MIN_RUNNERS <= RC_MAX_RUNNERS and RC_MAX_RUNNERS >= 1")
	}
	if c.Executor != "docker" && c.Executor != "firecracker" && c.Executor != "tart" && c.Executor != "hyperv" {
		return errors.New("RC_EXECUTOR must be docker, firecracker, tart, or hyperv")
	}
	if c.VCPUs < 1 || c.MemoryMiB < 512 {
		return errors.New("RC_VCPUS must be positive and RC_MEMORY_MIB must be at least 512")
	}
	if c.WarmPool < 0 || c.WarmPool > 16 || c.WarmPool > c.MaxRunners {
		return errors.New("RC_WARM_POOL must be between 0 and 16 and no greater than RC_MAX_RUNNERS")
	}
	if c.WarmPool > 0 && c.Executor != "firecracker" {
		return errors.New("RC_WARM_POOL is supported only by the firecracker executor")
	}
	if c.FitPolicy != "balanced" && c.FitPolicy != "cpu" && c.FitPolicy != "network" && c.FitPolicy != "io" {
		return errors.New("RC_FIT_POLICY must be balanced, cpu, network, or io")
	}
	if matched, _ := regexp.MatchString(`@sha256:[0-9a-f]{64}$`, c.ImageRelease); !matched {
		return errors.New("RC_IMAGE_RELEASE must be immutable and end in @sha256:<64 hex characters>")
	}
	if c.GitHubApp == nil && c.GitHubToken == "" {
		return errors.New("GitHub App credentials or RC_GITHUB_TOKEN is required")
	}
	if c.GitHubApp != nil && c.GitHubToken != "" {
		return errors.New("configure GitHub App credentials or RC_GITHUB_TOKEN, not both")
	}
	// The cache is optional, but half of it is a misconfiguration: a URL with no
	// key cannot sign a push, and a key with no URL has nowhere to send one.
	if (c.CacheFactsURL == "") != (c.CacheSigningKey == "") {
		return errors.New("RC_CACHE_FACTS_URL and RC_CACHE_SIGNING_KEY must be set together")
	}
	if c.CacheSigningKey != "" && len(c.CacheSigningKey) < 32 {
		return errors.New("RC_CACHE_SIGNING_KEY must be at least 32 bytes")
	}
	return nil
}

func readSecret(valueEnv, fileEnv string) (string, error) {
	value := os.Getenv(valueEnv)
	filename := strings.TrimSpace(os.Getenv(fileEnv))
	if value != "" && filename != "" {
		return "", fmt.Errorf("configure %s or %s, not both", valueEnv, fileEnv)
	}
	if filename == "" {
		return strings.TrimSpace(value), nil
	}
	contents, err := os.ReadFile(filename)
	if err != nil {
		return "", fmt.Errorf("read %s: %w", fileEnv, err)
	}
	return strings.TrimSpace(string(contents)), nil
}
