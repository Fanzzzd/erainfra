// Package githubscale owns the GitHub runner scale-set lifecycle. The scale
// set is durable and is never deleted merely because the controller stops.
package githubscale

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"slices"
	"strings"

	rccontroller "github.com/Fanzzzd/EraInfra/apps/controller/internal/controller"
	"github.com/actions/scaleset"
)

type Client interface {
	GetRunnerGroupByName(ctx context.Context, runnerGroup string) (*scaleset.RunnerGroup, error)
	GetRunnerScaleSet(ctx context.Context, runnerGroupID int, name string) (*scaleset.RunnerScaleSet, error)
	CreateRunnerScaleSet(ctx context.Context, scaleSet *scaleset.RunnerScaleSet) (*scaleset.RunnerScaleSet, error)
	UpdateRunnerScaleSet(ctx context.Context, id int, scaleSet *scaleset.RunnerScaleSet) (*scaleset.RunnerScaleSet, error)
	GenerateJitRunnerConfig(
		ctx context.Context,
		setting *scaleset.RunnerScaleSetJitRunnerSetting,
		scaleSetID int,
	) (*scaleset.RunnerScaleSetJitRunnerConfig, error)
	RemoveRunner(ctx context.Context, runnerID int64) error
}

type ScaleSetSpec struct {
	Name        string
	RunnerGroup string
	Labels      []string
}

// EnsureScaleSet creates a missing scale set and reconciles labels/settings on
// an existing one. It intentionally does not delete the scale set on shutdown.
func EnsureScaleSet(ctx context.Context, client Client, spec ScaleSetSpec) (*scaleset.RunnerScaleSet, error) {
	if client == nil {
		return nil, fmt.Errorf("GitHub scale-set client is required")
	}
	if strings.TrimSpace(spec.Name) == "" {
		return nil, fmt.Errorf("scale-set name is required")
	}
	if spec.RunnerGroup == "" {
		spec.RunnerGroup = scaleset.DefaultRunnerGroup
	}
	labels, err := normalizedLabels(spec.Labels, spec.Name)
	if err != nil {
		return nil, err
	}

	runnerGroupID := 1
	if spec.RunnerGroup != scaleset.DefaultRunnerGroup {
		group, err := client.GetRunnerGroupByName(ctx, spec.RunnerGroup)
		if err != nil {
			return nil, fmt.Errorf("resolve runner group %q: %w", spec.RunnerGroup, err)
		}
		runnerGroupID = group.ID
	}

	existing, err := client.GetRunnerScaleSet(ctx, runnerGroupID, spec.Name)
	if err != nil {
		return nil, fmt.Errorf("get scale set %q: %w", spec.Name, err)
	}
	desired := &scaleset.RunnerScaleSet{
		Name:          spec.Name,
		RunnerGroupID: runnerGroupID,
		Labels:        labels,
		RunnerSetting: scaleset.RunnerSetting{DisableUpdate: true},
	}
	if existing == nil {
		created, err := client.CreateRunnerScaleSet(ctx, desired)
		if err != nil {
			return nil, fmt.Errorf("create scale set %q: %w", spec.Name, err)
		}
		return created, nil
	}
	if sameScaleSetContract(existing, desired) {
		return existing, nil
	}
	updated, err := client.UpdateRunnerScaleSet(ctx, existing.ID, desired)
	if err != nil {
		return nil, fmt.Errorf("update scale set %q: %w", spec.Name, err)
	}
	return updated, nil
}

func normalizedLabels(labels []string, fallback string) ([]scaleset.Label, error) {
	if len(labels) == 0 {
		labels = []string{fallback}
	}
	seen := make(map[string]struct{}, len(labels))
	result := make([]scaleset.Label, 0, len(labels))
	for _, raw := range labels {
		label := strings.TrimSpace(raw)
		if label == "" {
			return nil, fmt.Errorf("scale-set labels cannot be empty")
		}
		if _, exists := seen[label]; exists {
			continue
		}
		seen[label] = struct{}{}
		result = append(result, scaleset.Label{Name: label, Type: "System"})
	}
	slices.SortFunc(result, func(a, b scaleset.Label) int { return strings.Compare(a.Name, b.Name) })
	return result, nil
}

func sameScaleSetContract(current, desired *scaleset.RunnerScaleSet) bool {
	if current.Name != desired.Name || current.RunnerGroupID != desired.RunnerGroupID {
		return false
	}
	if !current.RunnerSetting.DisableUpdate {
		return false
	}
	currentLabels, err := normalizedLabels(labelNames(current.Labels), current.Name)
	if err != nil {
		return false
	}
	return slices.Equal(currentLabels, desired.Labels)
}

func labelNames(labels []scaleset.Label) []string {
	result := make([]string, len(labels))
	for index, label := range labels {
		result[index] = label.Name
	}
	return result
}

type Issuer struct {
	client     Client
	scaleSetID int
}

func NewIssuer(client Client, scaleSetID int) (*Issuer, error) {
	if client == nil {
		return nil, fmt.Errorf("GitHub scale-set client is required")
	}
	if scaleSetID <= 0 {
		return nil, fmt.Errorf("scale-set ID must be positive")
	}
	return &Issuer{client: client, scaleSetID: scaleSetID}, nil
}

func (i *Issuer) GenerateJIT(ctx context.Context, runnerName string) (rccontroller.JITConfig, error) {
	jit, err := i.client.GenerateJitRunnerConfig(ctx, &scaleset.RunnerScaleSetJitRunnerSetting{
		Name:       runnerName,
		WorkFolder: "_work",
	}, i.scaleSetID)
	if err != nil {
		return rccontroller.JITConfig{}, err
	}
	if jit == nil || jit.Runner == nil {
		return rccontroller.JITConfig{}, fmt.Errorf("GitHub returned an empty JIT response")
	}
	return rccontroller.JITConfig{
		RunnerID:         int64(jit.Runner.ID),
		EncodedJITConfig: jit.EncodedJITConfig,
	}, nil
}

func (i *Issuer) RemoveRunner(ctx context.Context, runnerID int64) error {
	err := i.client.RemoveRunner(ctx, runnerID)
	// Deletion is a compensating, retried operation. An ephemeral runner may
	// have removed itself between reconciliation and this call.
	if err != nil && strings.Contains(err.Error(), `status="404 Not Found"`) {
		return nil
	}
	return err
}

func RunnerName(profile string) (string, error) {
	prefix := strings.Trim(strings.Map(func(character rune) rune {
		if character >= 'a' && character <= 'z' || character >= '0' && character <= '9' || character == '-' {
			return character
		}
		if character >= 'A' && character <= 'Z' {
			return character + ('a' - 'A')
		}
		return '-'
	}, profile), "-")
	if prefix == "" {
		prefix = "profile"
	}
	if len(prefix) > 40 {
		prefix = prefix[:40]
	}
	random := make([]byte, 6)
	if _, err := rand.Read(random); err != nil {
		return "", fmt.Errorf("generate runner name: %w", err)
	}
	return "rc-" + prefix + "-" + hex.EncodeToString(random), nil
}

var _ rccontroller.JITIssuer = (*Issuer)(nil)
