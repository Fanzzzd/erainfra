package firecracker

import (
	"testing"

	api "github.com/containerd/containerd/api/services/introspection/v1"
	"github.com/containerd/containerd/filters"
)

// containerd's introspection service builds its matcher with
// filters.ParseAll(req.Filters...) and evaluates each plugin through this
// adaptor. Reproducing both here tests the filter EraInfra actually sends
// against the parser that will receive it, rather than against a guess about
// its grammar.
func matchPlugins(t *testing.T, filter []string, plugins []*api.Plugin) []*api.Plugin {
	t.Helper()
	matcher, err := filters.ParseAll(filter...)
	if err != nil {
		t.Fatalf("containerd rejected the filter %v: %v", filter, err)
	}
	var matched []*api.Plugin
	for _, plugin := range plugins {
		adaptor := filters.AdapterFunc(func(fieldpath []string) (string, bool) {
			if len(fieldpath) == 0 {
				return "", false
			}
			switch fieldpath[0] {
			case "type":
				return plugin.Type, len(plugin.Type) > 0
			case "id":
				return plugin.ID, len(plugin.ID) > 0
			}
			return "", false
		})
		if matcher.Match(adaptor) {
			matched = append(matched, plugin)
		}
	}
	return matched
}

// What a containerd daemon on a real Worker reports. Several snapshotters are
// always loaded, which is exactly why the readiness check cannot ask for them
// by type alone.
func loadedPlugins() []*api.Plugin {
	return []*api.Plugin{
		{Type: SnapshotterPluginType, ID: "overlayfs"},
		{Type: SnapshotterPluginType, ID: "native"},
		{Type: SnapshotterPluginType, ID: "blockfile"},
		{Type: SnapshotterPluginType, ID: "devmapper"},
		{Type: "io.containerd.grpc.v1", ID: "snapshots"},
		{Type: "io.containerd.service.v1", ID: "devmapper"},
	}
}

func TestSnapshotterFilterSelectsExactlyTheConfiguredSnapshotter(t *testing.T) {
	matched := matchPlugins(t, snapshotterFilter("devmapper"), loadedPlugins())
	if len(matched) != 1 {
		t.Fatalf("filter matched %d plugins, want exactly 1", len(matched))
	}
	if matched[0].Type != SnapshotterPluginType || matched[0].ID != "devmapper" {
		t.Fatalf("filter matched %s/%s", matched[0].Type, matched[0].ID)
	}
}

func TestSnapshotterFilterIsOneStringBecauseContainerdOrsTheSlice(t *testing.T) {
	// The readiness check requires exactly one match, so a filter that reads as
	// a disjunction reports a healthy Worker as broken and it never becomes
	// eligible for work. Keep this test: the two forms differ by one character.
	disjunction := []string{"type==" + SnapshotterPluginType, "id==devmapper"}
	if matched := matchPlugins(t, disjunction, loadedPlugins()); len(matched) == 1 {
		t.Fatal("containerd now ANDs a slice of filters; snapshotterFilter can be simplified")
	}
	if len(snapshotterFilter("devmapper")) != 1 {
		t.Fatal("snapshotterFilter must send a single comma-separated filter string")
	}
}

func TestSnapshotterFilterRejectsASnapshotterOfAnotherType(t *testing.T) {
	// "devmapper" also names a service plugin. Matching it would make readiness
	// pass while no snapshotter is loaded at all.
	matched := matchPlugins(t, snapshotterFilter("devmapper"), []*api.Plugin{
		{Type: "io.containerd.service.v1", ID: "devmapper"},
	})
	if len(matched) != 0 {
		t.Fatalf("a non-snapshotter plugin satisfied the snapshotter check: %v", matched)
	}
}
