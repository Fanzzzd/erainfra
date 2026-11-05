//go:build !windows

package agent

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// stateDocker is a fake docker CLI over a directory of existing objects: `container inspect X`
// prints containers/X.json, `volume inspect X` prints volumes/X.json, and either fails with
// Docker's "No such" message when the file is absent. Every call is logged.
type stateDocker struct {
	path, dir, log string
}

func newStateDocker(t *testing.T) stateDocker {
	t.Helper()
	dir := t.TempDir()
	for _, sub := range []string{"container", "volume"} {
		if err := os.MkdirAll(filepath.Join(dir, sub), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	log := filepath.Join(dir, "calls.log")
	script := `#!/bin/sh
printf '%s\n' "$*" >> ` + shellQuote(log) + `
if [ "$2" = inspect ] && [ "$1" != image ] && [ "$1" != network ]; then
  f=` + shellQuote(dir) + `/"$1"/"$3".json
  if [ -f "$f" ]; then cat "$f"; exit 0; fi
  echo "Error response from daemon: No such $1: $3" >&2
  exit 1
fi
exit 0
`
	path := filepath.Join(dir, "docker")
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return stateDocker{path: path, dir: dir, log: log}
}

func (d stateDocker) put(t *testing.T, kind, name, json string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(d.dir, kind, name+".json"), []byte(json), 0o644); err != nil {
		t.Fatal(err)
	}
}

func (d stateDocker) calls(t *testing.T) []string {
	t.Helper()
	raw, err := os.ReadFile(d.log)
	if err != nil {
		t.Fatal(err)
	}
	return strings.Split(strings.TrimSpace(string(raw)), "\n")
}

func (d stateDocker) has(t *testing.T, prefix string) bool {
	t.Helper()
	for _, c := range d.calls(t) {
		if strings.HasPrefix(c, prefix) {
			return true
		}
	}
	return false
}

// A container docker inspect describes: its labels, and its networks with their aliases.
func container(labels string, networks string) string {
	return `[{"Config":{"Labels":` + labels + `},"NetworkSettings":{"Networks":` + networks + `}}]`
}

func deployService(t *testing.T, d stateDocker, app string, s Service) error {
	t.Helper()
	_, err := ShellRunner{Docker: d.path}.DeployApp(context.Background(), app, []Service{s})
	return err
}

func TestDeployAppLabelsWhatItCreates(t *testing.T) {
	d := newStateDocker(t)
	err := deployService(t, d, "shop", Service{Name: "db", Image: "postgres:16", Args: []string{"-v", "shop-db-data:/var/lib/postgresql/data"}})
	if err != nil {
		t.Fatal(err)
	}
	if !d.has(t, "volume create --label erainfra.app=shop shop-db-data") {
		t.Fatalf("volume not created with its App label: %q", d.calls(t))
	}
	if !d.has(t, "run -d --name shop-db --network shop-net --network-alias db --restart unless-stopped --label erainfra.app=shop --label erainfra.service=db ") {
		t.Fatalf("container not labelled: %q", d.calls(t))
	}
}

func TestDeployAppReplacesItsOwnContainer(t *testing.T) {
	d := newStateDocker(t)
	d.put(t, "container", "shop-web", container(`{"erainfra.app":"shop","erainfra.service":"web"}`, `{"shop-net":{"Aliases":["web"]}}`))
	if err := deployService(t, d, "shop", Service{Name: "web", Image: "w:1"}); err != nil {
		t.Fatal(err)
	}
	if !d.has(t, "rm -f shop-web") || !d.has(t, "run -d --name shop-web ") {
		t.Fatalf("own container not replaced: %q", d.calls(t))
	}
}

// App shop's service web-api and App shop-web's service api are both container shop-web-api.
func TestDeployAppRefusesAnotherAppsContainer(t *testing.T) {
	for name, existing := range map[string]string{
		"labelled":                     container(`{"erainfra.app":"shop-web","erainfra.service":"api"}`, `{"shop-web-net":{"Aliases":["api"]}}`),
		"unlabelled, another network":  container(`null`, `{"shop-web-net":{"Aliases":["api","3f2a"]}}`),
		"unlabelled, default network":  container(`{}`, `{"bridge":{"Aliases":null}}`),
		"unlabelled, alias of another": container(`{}`, `{"shop-net":{"Aliases":["web"]}}`),
	} {
		t.Run(name, func(t *testing.T) {
			d := newStateDocker(t)
			d.put(t, "container", "shop-web-api", existing)
			err := deployService(t, d, "shop", Service{Name: "web-api", Image: "b:1"})
			if err == nil || !strings.Contains(err.Error(), "refusing to replace it") {
				t.Fatalf("err = %v", err)
			}
			if d.has(t, "rm ") || d.has(t, "run ") || d.has(t, "network create") {
				t.Fatalf("touched the Node after refusing: %q", d.calls(t))
			}
		})
	}
}

// A container the Hub created has no labels, and is this App's when it is the service on the
// App's network: the next deploy replaces it with a labelled one.
func TestDeployAppAdoptsAHubContainerOfTheSameService(t *testing.T) {
	d := newStateDocker(t)
	d.put(t, "container", "shop-web-api", container(`null`, `{"shop-net":{"Aliases":["web-api","3f2a"]}}`))
	if err := deployService(t, d, "shop", Service{Name: "web-api", Image: "b:1"}); err != nil {
		t.Fatal(err)
	}
	if !d.has(t, "rm -f shop-web-api") || !d.has(t, "run -d --name shop-web-api ") {
		t.Fatalf("Hub container not replaced: %q", d.calls(t))
	}
}

func TestDeployAppRefusesAnotherAppsVolume(t *testing.T) {
	d := newStateDocker(t)
	// App shop's volume db-data and App shop-db's volume data are both shop-db-data.
	d.put(t, "volume", "shop-db-data", `[{"Name":"shop-db-data","Labels":{"erainfra.app":"shop"}}]`)
	err := deployService(t, d, "shop-db", Service{Name: "web", Image: "x:1", Args: []string{"-v", "shop-db-data:/steal"}})
	if err == nil || !strings.Contains(err.Error(), `volume shop-db-data belongs to App "shop"`) {
		t.Fatalf("err = %v", err)
	}
	if d.has(t, "run ") {
		t.Fatalf("started a container after refusing: %q", d.calls(t))
	}
	// Its own App still mounts it, and a Hub-era volume without the label is mounted as it was.
	if err := deployService(t, d, "shop", Service{Name: "db", Image: "p:1", Args: []string{"-v", "shop-db-data:/d"}}); err != nil {
		t.Fatal(err)
	}
	d.put(t, "volume", "legacy-data", `[{"Name":"legacy-data","Labels":null}]`)
	if err := deployService(t, d, "legacy", Service{Name: "db", Image: "p:1", Args: []string{"--volume=legacy-data:/d:ro"}}); err != nil {
		t.Fatal(err)
	}
}

func TestDeployAppRefusesWhenItCannotInspect(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "docker")
	if err := os.WriteFile(path, []byte("#!/bin/sh\n[ \"$2\" = inspect ] && { echo 'Cannot connect to the Docker daemon' >&2; exit 1; }\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	_, err := ShellRunner{Docker: path}.DeployApp(context.Background(), "shop", []Service{{Name: "web", Image: "w:1"}})
	if err == nil || !strings.Contains(err.Error(), "inspect container shop-web") {
		t.Fatalf("err = %v", err)
	}
}

// The Hub's single-container deploy names the container after the App.
func TestDeployRefusesAServiceContainerOfTheSameName(t *testing.T) {
	d := newStateDocker(t)
	d.put(t, "container", "shop-web", container(`{"erainfra.app":"shop","erainfra.service":"web"}`, `{"shop-net":{"Aliases":["web"]}}`))
	_, err := ShellRunner{Docker: d.path}.Deploy(context.Background(), "x:1", "shop-web", nil, nil, 0)
	if err == nil || !strings.Contains(err.Error(), `belongs to service "web" of App "shop"`) {
		t.Fatalf("err = %v", err)
	}
	// An unlabelled container on another App's network is not a single-container App's either.
	d.put(t, "container", "shop-web", container(`null`, `{"shop-net":{"Aliases":["web"]}}`))
	if _, err := (ShellRunner{Docker: d.path}).Deploy(context.Background(), "x:1", "shop-web", nil, nil, 0); err == nil {
		t.Fatal("replaced a service container")
	}
	if d.has(t, "rm ") || d.has(t, "run ") {
		t.Fatalf("touched the Node after refusing: %q", d.calls(t))
	}
	// Its own Hub-era container, on the default network only, is replaced and labelled.
	d.put(t, "container", "solo", container(`null`, `{"bridge":{"Aliases":null}}`))
	if _, err := (ShellRunner{Docker: d.path}).Deploy(context.Background(), "x:1", "solo", nil, nil, 0); err != nil {
		t.Fatal(err)
	}
	if !d.has(t, "run -d --name solo --label erainfra.app=solo ") {
		t.Fatalf("calls %q", d.calls(t))
	}
}
