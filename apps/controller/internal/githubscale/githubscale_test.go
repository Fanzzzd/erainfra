package githubscale

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/actions/scaleset"
)

type fakeClient struct {
	existing  *scaleset.RunnerScaleSet
	created   *scaleset.RunnerScaleSet
	updated   *scaleset.RunnerScaleSet
	updateID  int
	removeErr error
}

func (f *fakeClient) GetRunnerGroupByName(context.Context, string) (*scaleset.RunnerGroup, error) {
	return &scaleset.RunnerGroup{ID: 9}, nil
}
func (f *fakeClient) GetRunnerScaleSet(context.Context, int, string) (*scaleset.RunnerScaleSet, error) {
	return f.existing, nil
}
func (f *fakeClient) CreateRunnerScaleSet(_ context.Context, value *scaleset.RunnerScaleSet) (*scaleset.RunnerScaleSet, error) {
	f.created = value
	copy := *value
	copy.ID = 5
	return &copy, nil
}
func (f *fakeClient) UpdateRunnerScaleSet(_ context.Context, id int, value *scaleset.RunnerScaleSet) (*scaleset.RunnerScaleSet, error) {
	f.updateID = id
	f.updated = value
	copy := *value
	copy.ID = id
	return &copy, nil
}
func (f *fakeClient) GenerateJitRunnerConfig(context.Context, *scaleset.RunnerScaleSetJitRunnerSetting, int) (*scaleset.RunnerScaleSetJitRunnerConfig, error) {
	return &scaleset.RunnerScaleSetJitRunnerConfig{
		Runner:           &scaleset.RunnerReference{ID: 12},
		EncodedJITConfig: "secret",
	}, nil
}
func (f *fakeClient) RemoveRunner(context.Context, int64) error { return f.removeErr }

func TestEnsureScaleSetCreatesDurableContract(t *testing.T) {
	client := &fakeClient{}
	result, err := EnsureScaleSet(t.Context(), client, ScaleSetSpec{
		Name:   "rc-linux-js",
		Labels: []string{"rc-linux-js", "x64", "rc-linux-js"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.ID != 5 || client.created == nil {
		t.Fatalf("result = %#v, created = %#v", result, client.created)
	}
	wantLabels := []scaleset.Label{{Name: "rc-linux-js", Type: "System"}, {Name: "x64", Type: "System"}}
	if !reflect.DeepEqual(client.created.Labels, wantLabels) {
		t.Fatalf("labels = %#v, want %#v", client.created.Labels, wantLabels)
	}
	if !client.created.RunnerSetting.DisableUpdate {
		t.Fatal("runner self-update was not disabled")
	}
}

func TestEnsureScaleSetUpdatesDriftButLeavesMatchingSetAlone(t *testing.T) {
	client := &fakeClient{existing: &scaleset.RunnerScaleSet{
		ID:            17,
		Name:          "rc-macos-15",
		RunnerGroupID: 1,
		Labels:        []scaleset.Label{{Name: "old"}},
		RunnerSetting: scaleset.RunnerSetting{DisableUpdate: false},
	}}
	updated, err := EnsureScaleSet(t.Context(), client, ScaleSetSpec{Name: "rc-macos-15"})
	if err != nil {
		t.Fatal(err)
	}
	if updated.ID != 17 || client.updateID != 17 {
		t.Fatalf("updated = %#v, update id = %d", updated, client.updateID)
	}

	client.existing = updated
	client.updated = nil
	if _, err := EnsureScaleSet(t.Context(), client, ScaleSetSpec{Name: "rc-macos-15"}); err != nil {
		t.Fatal(err)
	}
	if client.updated != nil {
		t.Fatal("matching scale set was updated")
	}
}

func TestIssuerMapsGitHubJITWithoutLoggingIt(t *testing.T) {
	issuer, err := NewIssuer(&fakeClient{}, 3)
	if err != nil {
		t.Fatal(err)
	}
	jit, err := issuer.GenerateJIT(t.Context(), "runner-a")
	if err != nil {
		t.Fatal(err)
	}
	if jit.RunnerID != 12 || jit.EncodedJITConfig != "secret" {
		t.Fatalf("jit = %#v", jit)
	}
}

func TestIssuerTreatsAnAlreadyRemovedRunnerAsClean(t *testing.T) {
	client := &fakeClient{removeErr: errors.New(`request failed status="404 Not Found"`)}
	issuer, err := NewIssuer(client, 3)
	if err != nil {
		t.Fatal(err)
	}
	if err := issuer.RemoveRunner(t.Context(), 12); err != nil {
		t.Fatal(err)
	}
}

func TestRunnerNameIsSafeAndBounded(t *testing.T) {
	name, err := RunnerName("RC Linux/JS @ arm64 with a very very very very long suffix")
	if err != nil {
		t.Fatal(err)
	}
	if len(name) > 56 || !strings.HasPrefix(name, "rc-rc-linux-js---arm64") {
		t.Fatalf("runner name = %q", name)
	}
}
