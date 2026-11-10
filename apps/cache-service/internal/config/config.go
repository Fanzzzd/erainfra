// Package config reads the cache service's environment.
//
// Every name here is new, so every name here is spelled ERAINFRA_CACHE_*.
// Nothing in this service is on CONTEXT.md rule 4's frozen list — no machine in
// the field holds any of these yet — which is exactly why none of them may be
// borrowed from something that is.
package config

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/Fanzzzd/erainfra/apps/cache-service/cachetoken"
	"github.com/Fanzzzd/erainfra/apps/cache-service/internal/objectstore"
)

// Download modes. Presign is the default and is what ADR 0007 rule 4 describes:
// the job gets a URL for one object, by GET, that expires. Proxy exists because
// the store may sit somewhere a job cannot reach — the presigned URL is
// resolved by the job, not by this service, so an endpoint that is only
// routable from here has to be streamed rather than handed over.
const (
	DownloadPresign = "presign"
	DownloadProxy   = "proxy"
)

type Config struct {
	Listen    string
	PublicURL string
	// SigningKey is shared with whoever mints tokens. In stage C that is the
	// controller, at JobStarted.
	SigningKey []byte
	Store      objectstore.S3Config

	DownloadMode string
	DownloadTTL  time.Duration
	UploadTTL    time.Duration

	// The three timeout budgets, one per fault class. ADR 0007 is explicit
	// that the dangerous outage is a store that accepts a connection and never
	// answers, so no request may be answered by waiting.
	//
	//   LookupTimeout  — a restore. Overrun answers a MISS, because a miss
	//                    costs a slower job and a 500 costs five retries and
	//                    about 30 seconds of backoff per restore step
	//                    (capture L124-L128).
	//   ReserveTimeout — a reservation, a commit, or a finalize. Overrun
	//                    refuses the save; the client warns and the job
	//                    continues.
	//   TransferTimeout— a body: a v1 PATCH chunk, a v2 block, a proxied
	//                    download, and the store write each one drives. It is
	//                    a ceiling on one request, not on an upload.
	LookupTimeout   time.Duration
	ReserveTimeout  time.Duration
	TransferTimeout time.Duration

	MaxEntryBytes int64
	SpoolDir      string
	LogLevel      slog.Level

	// Retention. GitHub's own cache evicts an entry nobody restored for 7
	// days and caps a repository at 10 GB, least recently used first; these
	// default to the same.
	//
	//   IdleTTL          — evict an entry not restored for this long.
	//   RepoQuotaBytes   — one repository's live entries, at most.
	//   EvictionInterval — how often the whole bucket is swept. A repository
	//                      that just saved an entry is checked against its
	//                      quota within a minute regardless.
	IdleTTL          time.Duration
	RepoQuotaBytes   int64
	EvictionInterval time.Duration

	// SharedBuildRepositories lists "owner/name" repositories whose jobs save
	// build-system entries (turbo/ and go/) in the default branch's scope
	// instead of their own ref, so a squash-merged pull request's outputs hit
	// on the default branch. Fork pull requests still cannot write. List a
	// repository only when everyone who can open a pull request in it can
	// already push to its default branch: the switch gives a pull request's
	// build outputs the default branch's trust.
	SharedBuildRepositories []string
}

// Load reads the environment and refuses to start on anything missing. A cache
// service that comes up without a store or without a signing key would answer
// every restore with a miss and every save with an error, which is the failure
// mode that looks like "the cache is just slow".
func Load() (Config, error) {
	config := Config{
		Listen:           envOr("ERAINFRA_CACHE_LISTEN", ":8721"),
		PublicURL:        strings.TrimRight(strings.TrimSpace(os.Getenv("ERAINFRA_CACHE_PUBLIC_URL")), "/"),
		DownloadMode:     strings.ToLower(envOr("ERAINFRA_CACHE_DOWNLOAD_MODE", DownloadPresign)),
		DownloadTTL:      5 * time.Minute,
		UploadTTL:        time.Hour,
		LookupTimeout:    5 * time.Second,
		ReserveTimeout:   10 * time.Second,
		TransferTimeout:  30 * time.Minute,
		MaxEntryBytes:    10 << 30,
		IdleTTL:          7 * 24 * time.Hour,
		RepoQuotaBytes:   10 << 30,
		EvictionInterval: time.Hour,
		SpoolDir:         envOr("ERAINFRA_CACHE_SPOOL_DIR", filepath.Join(os.TempDir(), "erainfra-cache-spool")),
		LogLevel:         slog.LevelInfo,
		Store: objectstore.S3Config{
			Endpoint:  strings.TrimSpace(os.Getenv("ERAINFRA_CACHE_S3_ENDPOINT")),
			Bucket:    strings.TrimSpace(os.Getenv("ERAINFRA_CACHE_S3_BUCKET")),
			Region:    envOr("ERAINFRA_CACHE_S3_REGION", "us-east-1"),
			AccessKey: strings.TrimSpace(os.Getenv("ERAINFRA_CACHE_S3_ACCESS_KEY")),
			Prefix:    envOr("ERAINFRA_CACHE_S3_PREFIX", "erainfra-cache/v1/"),
			PathStyle: true,
			PartBytes: 32 << 20,
		},
	}

	var err error
	if config.SigningKey, err = readSecretBytes("ERAINFRA_CACHE_SIGNING_KEY"); err != nil {
		return Config{}, err
	}
	if len(config.SigningKey) < cachetoken.MinSigningKeyLen {
		return Config{}, fmt.Errorf("ERAINFRA_CACHE_SIGNING_KEY must be at least %d bytes",
			cachetoken.MinSigningKeyLen)
	}
	secret, err := readSecretBytes("ERAINFRA_CACHE_S3_SECRET")
	if err != nil {
		return Config{}, err
	}
	config.Store.Secret = string(secret)

	for _, repository := range strings.Split(os.Getenv("ERAINFRA_CACHE_SHARED_BUILD_REPOSITORIES"), ",") {
		repository = strings.TrimSpace(repository)
		if repository == "" {
			continue
		}
		if err := cachetoken.ValidateRepository(repository); err != nil {
			return Config{}, fmt.Errorf("ERAINFRA_CACHE_SHARED_BUILD_REPOSITORIES: %w", err)
		}
		config.SharedBuildRepositories = append(config.SharedBuildRepositories, repository)
	}

	if config.DownloadMode != DownloadPresign && config.DownloadMode != DownloadProxy {
		return Config{}, fmt.Errorf("ERAINFRA_CACHE_DOWNLOAD_MODE must be %q or %q, got %q",
			DownloadPresign, DownloadProxy, config.DownloadMode)
	}
	if value := strings.TrimSpace(os.Getenv("ERAINFRA_CACHE_S3_PATH_STYLE")); value != "" {
		config.Store.PathStyle, err = strconv.ParseBool(value)
		if err != nil {
			return Config{}, fmt.Errorf("ERAINFRA_CACHE_S3_PATH_STYLE must be a boolean: %w", err)
		}
	}
	for name, target := range map[string]*time.Duration{
		"ERAINFRA_CACHE_DOWNLOAD_TTL":      &config.DownloadTTL,
		"ERAINFRA_CACHE_UPLOAD_TTL":        &config.UploadTTL,
		"ERAINFRA_CACHE_LOOKUP_TIMEOUT":    &config.LookupTimeout,
		"ERAINFRA_CACHE_RESERVE_TIMEOUT":   &config.ReserveTimeout,
		"ERAINFRA_CACHE_TRANSFER_TIMEOUT":  &config.TransferTimeout,
		"ERAINFRA_CACHE_IDLE_TTL":          &config.IdleTTL,
		"ERAINFRA_CACHE_EVICTION_INTERVAL": &config.EvictionInterval,
	} {
		if err := readDuration(name, target); err != nil {
			return Config{}, err
		}
	}
	for name, target := range map[string]*int64{
		"ERAINFRA_CACHE_MAX_ENTRY_BYTES":  &config.MaxEntryBytes,
		"ERAINFRA_CACHE_PART_BYTES":       &config.Store.PartBytes,
		"ERAINFRA_CACHE_REPO_QUOTA_BYTES": &config.RepoQuotaBytes,
	} {
		if err := readBytes(name, target); err != nil {
			return Config{}, err
		}
	}
	switch strings.ToLower(strings.TrimSpace(os.Getenv("ERAINFRA_CACHE_LOG_LEVEL"))) {
	case "", "info":
	case "debug":
		config.LogLevel = slog.LevelDebug
	case "warn":
		config.LogLevel = slog.LevelWarn
	case "error":
		config.LogLevel = slog.LevelError
	default:
		return Config{}, errors.New("ERAINFRA_CACHE_LOG_LEVEL must be debug, info, warn or error")
	}
	return config, nil
}

func envOr(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

// readSecretBytes takes a secret from the variable or, preferred, from a file
// the variable's _FILE twin names. A secret in an environment variable is
// visible to anything that can read /proc; a file is not.
func readSecretBytes(name string) ([]byte, error) {
	if path := strings.TrimSpace(os.Getenv(name + "_FILE")); path != "" {
		body, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("read %s_FILE: %w", name, err)
		}
		return []byte(strings.TrimSpace(string(body))), nil
	}
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return nil, fmt.Errorf("%s or %s_FILE is required", name, name)
	}
	return []byte(value), nil
}

func readDuration(name string, target *time.Duration) error {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return nil
	}
	parsed, err := ParseDuration(value)
	if err != nil {
		return fmt.Errorf("%s must be a duration such as 30s or 7d: %w", name, err)
	}
	if parsed <= 0 {
		return fmt.Errorf("%s must be positive", name)
	}
	*target = parsed
	return nil
}

// ParseDuration is time.ParseDuration plus a whole-day form, "7d", because a
// retention period is naturally written in days and "168h" invites a typo.
func ParseDuration(value string) (time.Duration, error) {
	if days, found := strings.CutSuffix(value, "d"); found {
		count, err := strconv.ParseInt(days, 10, 64)
		if err != nil || count <= 0 || count > 3650 {
			return 0, fmt.Errorf("%q is not a whole number of days between 1 and 3650", value)
		}
		return time.Duration(count) * 24 * time.Hour, nil
	}
	return time.ParseDuration(value)
}

func readBytes(name string, target *int64) error {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return nil
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil || parsed <= 0 {
		return fmt.Errorf("%s must be a positive number of bytes", name)
	}
	*target = parsed
	return nil
}
