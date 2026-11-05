//go:build linux

package main

import (
	"context"
	"fmt"
	"os"

	"github.com/Fanzzzd/erainfra/apps/runtime/internal/cacheca"
	"github.com/Fanzzzd/erainfra/apps/runtime/internal/guestdocker"
)

const daemonJSON = "/etc/docker/daemon.json"

// configureGuestDocker points the guest's dockerd and every buildx builder the
// job creates at the host-side registry mirror, and puts the job cache CA where
// a buildx builder can opt in to it. Each part is best-effort: what does not
// apply is reported on the journal and the job runs without it, pulling from
// Docker Hub and caching on GitHub exactly as a guest without either does.
//
// It runs at claim, not at boot. dockerd started with the VM, before the
// Attempt was known, which is fine because registry-mirrors is one of the
// options dockerd reloads on SIGHUP.
func configureGuestDocker(ctx context.Context, mirrorURL, cacheCAPath, home string, uid, gid int) {
	if mirrorURL != "" {
		err := guestdocker.ApplyMirror(ctx, guestdocker.MirrorSetup{
			URL:        mirrorURL,
			DaemonJSON: daemonJSON,
			Reload: func(ctx context.Context) error {
				return runCmd(ctx, "systemctl", "reload", "docker.service")
			},
		})
		if err != nil {
			fmt.Fprintf(os.Stderr, "registry mirror not used, pulls go to Docker Hub: %v\n", err)
			mirrorURL = ""
		}
	}
	buildkitd := guestdocker.BuildkitdConfig{MirrorURL: mirrorURL}
	if cacheCAPath != "" {
		buildkitd.CacheHost = cacheca.CacheHost
		buildkitd.CacheCAPath = cacheCAPath
	}
	if _, err := guestdocker.WriteBuildkitdConfig(home, uid, gid, buildkitd); err != nil {
		fmt.Fprintf(os.Stderr, "default BuildKit configuration not written: %v\n", err)
	}
}
