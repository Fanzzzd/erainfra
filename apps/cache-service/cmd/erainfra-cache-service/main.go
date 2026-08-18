// Command erainfra-cache-service serves GitHub's Actions cache protocol, both
// generations, from an S3-compatible store.
//
// It is a standalone binary rather than part of an existing one on purpose:
// apps/infra-agent ships five attested digests and one dependency, and Convex
// cannot stream a PATCH body into a bucket.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/Fanzzzd/erainfra/apps/cache-service/internal/config"
	"github.com/Fanzzzd/erainfra/apps/cache-service/internal/objectstore"
	"github.com/Fanzzzd/erainfra/apps/cache-service/internal/server"
)

var (
	version   = "dev"
	commitSHA = "unknown"
)

func main() {
	if len(os.Args) == 2 && os.Args[1] == "version" {
		fmt.Printf("erainfra-cache-service %s (%s)\n", version, commitSHA)
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

	store, err := objectstore.NewS3(cfg.Store)
	if err != nil {
		return fmt.Errorf("configure object store: %w", err)
	}
	cache, err := server.New(cfg, store, logger)
	if err != nil {
		return fmt.Errorf("start cache service: %w", err)
	}
	defer cache.Close()

	listener := &http.Server{
		Addr:    cfg.Listen,
		Handler: cache,
		// Headers get a short leash; bodies do not, because a v1 PATCH chunk is
		// 32 MiB and a whole entry can be hundreds. Each handler sets its own
		// body deadline instead.
		ReadHeaderTimeout: 15 * time.Second,
		IdleTimeout:       2 * time.Minute,
	}

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	errs := make(chan error, 1)
	go func() {
		logger.Info("cache service listening", "address", cfg.Listen,
			"bucket", cfg.Store.Bucket, "downloadMode", cfg.DownloadMode)
		errs <- listener.ListenAndServe()
	}()

	select {
	case err := <-errs:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
		shutdown, done := context.WithTimeout(context.Background(), 30*time.Second)
		defer done()
		return listener.Shutdown(shutdown)
	}
}
