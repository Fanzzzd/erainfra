//go:build linux

package firecracker

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"time"

	containerd "github.com/containerd/containerd/v2/client"
	"github.com/containerd/containerd/v2/core/images"
	"github.com/containerd/containerd/v2/pkg/namespaces"
	"github.com/containerd/errdefs"

	"github.com/Fanzzzd/erainfra/apps/runtime/internal/executor"
)

// Image Release garbage collection.
//
// Every repin pulls a new Image Release into the runtime's containerd, about 10 GiB unpacked for
// the full image, and nothing removed the old ones: ubuntu0 held seven on 2026-11-12. The Action
// Runner Agent knows every Profile this Worker serves, so it sends their Image Releases; the
// runtime keeps those, the Image Releases of its warm pools, and the newest other one, so a
// rollback to the previous release needs no pull. It deletes the rest.
//
// "Previous" is the Image Release a VM booted from most recently, not the one
// pulled last: a canary candidate pulled after the release the other Profiles
// ran must not displace that release as the rollback. Each boot stamps
// lastUsedLabel on the image record; an image no VM booted falls back to its
// pull time.
//
// Deleting an image name is safe under a running Attempt or a parked warm guest: each holds a
// containerd lease on its writable snapshot, and that snapshot pins the image's layers. A wrong
// deletion therefore costs a pull, never a running job.

// lastUsedLabel holds, on an Image Release's containerd record, when a VM last
// booted from it (RFC 3339, UTC).
const lastUsedLabel = "erainfra.io/last-used"

// storedImage is one image record in the runtime's containerd namespace.
type storedImage struct {
	Name      string
	CreatedAt time.Time
	// LastUsed is zero for an image no VM has booted from.
	LastUsed time.Time
}

// recency orders Image Releases for the rollback slot: last boot, else pull.
func (image storedImage) recency() time.Time {
	if !image.LastUsed.IsZero() {
		return image.LastUsed
	}
	return image.CreatedAt
}

// markImageUsed stamps lastUsedLabel on the image record. Only that label is
// written; the rest of the record is left as containerd holds it.
func markImageUsed(ctx context.Context, client *containerd.Client, name string, at time.Time) error {
	_, err := client.ImageService().Update(ctx, images.Image{
		Name:   name,
		Labels: map[string]string{lastUsedLabel: at.UTC().Format(time.RFC3339)},
	}, "labels."+lastUsedLabel)
	return err
}

// planImagePrune splits stored into the names to keep and the names to delete. keep must name
// at least one Image Release: an empty list means the caller does not know its Profiles, and
// pruning on it would delete every image.
func planImagePrune(stored []storedImage, keep []string) (executor.ImagePrune, error) {
	if len(keep) == 0 {
		return executor.ImagePrune{}, errors.New("refusing to prune Image Releases without at least one to keep")
	}
	for _, name := range keep {
		if err := validateImageRelease(name); err != nil {
			return executor.ImagePrune{}, fmt.Errorf("keep %q: %w", name, err)
		}
	}
	others := slices.DeleteFunc(slices.Clone(stored), func(image storedImage) bool {
		return slices.Contains(keep, image.Name)
	})
	// Most recently used first; the name breaks ties so the plan never depends
	// on listing order.
	slices.SortFunc(others, func(left, right storedImage) int {
		return cmp.Or(right.recency().Compare(left.recency()), cmp.Compare(left.Name, right.Name))
	})
	plan := executor.ImagePrune{Kept: []string{}, Deleted: []string{}}
	for _, image := range stored {
		if slices.Contains(keep, image.Name) {
			plan.Kept = append(plan.Kept, image.Name)
		}
	}
	for index, image := range others {
		if index == 0 {
			plan.Kept = append(plan.Kept, image.Name) // the most recently used other release
			continue
		}
		plan.Deleted = append(plan.Deleted, image.Name)
	}
	slices.Sort(plan.Kept)
	slices.Sort(plan.Deleted)
	return plan, nil
}

// PruneImages deletes the Image Releases planImagePrune does not keep. keep is the Agent's list;
// the warm pools' Image Releases are added to it here.
func (r *Runtime) PruneImages(ctx context.Context, keep []string) (executor.ImagePrune, error) {
	keep = slices.Clone(keep)
	for _, image := range r.pool.imageReleases() {
		if !slices.Contains(keep, image) {
			keep = append(keep, image)
		}
	}
	client, err := containerd.New(r.config.ContainerdAddress)
	if err != nil {
		return executor.ImagePrune{}, fmt.Errorf("connect to containerd: %w", err)
	}
	defer client.Close() //nolint:errcheck // closes the gRPC connection; nothing is buffered
	containerdContext := namespaces.WithNamespace(ctx, r.config.ContainerdNamespace)
	listed, err := client.ImageService().List(containerdContext)
	if err != nil {
		return executor.ImagePrune{}, fmt.Errorf("list Image Releases: %w", err)
	}
	stored := make([]storedImage, 0, len(listed))
	for _, image := range listed {
		entry := storedImage{Name: image.Name, CreatedAt: image.CreatedAt}
		if used, parseErr := time.Parse(time.RFC3339, image.Labels[lastUsedLabel]); parseErr == nil {
			entry.LastUsed = used
		}
		stored = append(stored, entry)
	}
	plan, err := planImagePrune(stored, keep)
	if err != nil {
		return executor.ImagePrune{}, err
	}
	deleted := []string{}
	var deleteErrors []error
	for index, name := range plan.Deleted {
		// The last delete waits for containerd's garbage collection, which frees the layers'
		// content and their snapshots in the thin pool.
		var options []images.DeleteOpt
		if index == len(plan.Deleted)-1 {
			options = append(options, images.SynchronousDelete())
		}
		if err := client.ImageService().Delete(containerdContext, name, options...); err != nil && !errdefs.IsNotFound(err) {
			deleteErrors = append(deleteErrors, fmt.Errorf("delete %s: %w", name, err))
			continue
		}
		deleted = append(deleted, name)
		slog.Info("deleted an Image Release no Profile uses", "image", name)
	}
	plan.Deleted = deleted
	return plan, errors.Join(deleteErrors...)
}
