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
// Docker's "No such" message when the file is absent. `ps --filter volume=V` prints every
// container whose JSON mounts volume V. Every call is logged.
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
if [ "$1" = ps ]; then
  for a in "$@"; do case "$a" in volume=*) vol="${a#volume=}";; esac; done
  for f in ` + shellQuote(dir) + `/container/*.json; do
    [ -f "$f" ] || continue
    if grep -q "\"Type\":\"volume\",\"Name\":\"$vol\"" "$f"; then basename "$f" .json; fi
  done
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

// The same, for a container that mounts the named volumes.
func mounting(labels string, networks string, volumes ...string) string {
	mounts := make([]string, len(volumes))
	for i, v := range volumes {
		mounts[i] = `{"Type":"volume","Name":"` + v + `","Destination":"/data"}`
	}
	return `[{"Config":{"Labels":` + labels + `},"NetworkSettings":{"Networks":` + networks + `},"Mounts":[` + strings.Join(mounts, ",") + `]}]`
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

// A single-container App the Hub deployed (`--name db -v postgres-data:/var/lib/postgresql/data`)
// keeps its data in an unlabelled volume whose name no control plane records: the Hub stored none
// of the deploy's args. App postgres's volume `data` derives the same name. Only this Node knows
// that container db mounts it, so the Infra Agent refuses.
func TestDeployAppRefusesAHubVolumeAnotherAppMounts(t *testing.T) {
	d := newStateDocker(t)
	d.put(t, "container", "db", mounting(`{}`, `{"bridge":{"Aliases":null}}`, "postgres-data"))
	d.put(t, "volume", "postgres-data", `[{"Labels":null}]`)
	owners := filepath.Join(t.TempDir(), "volume-owners")
	_, err := ShellRunner{Docker: d.path, VolumeOwners: owners}.DeployApp(context.Background(), "postgres", []Service{{
		Name: "main", Image: "postgres:16", Args: []string{"-v", "postgres-data:/var/lib/postgresql/data"},
	}})
	if err == nil || !strings.Contains(err.Error(), `volume postgres-data has no erainfra.app label and is mounted by container db, which is not App "postgres"'s`) {
		t.Fatalf("err = %v", err)
	}
	if d.has(t, "rm ") || d.has(t, "run ") || d.has(t, "network create") || d.has(t, "volume create") {
		t.Fatalf("touched the Node after refusing: %q", d.calls(t))
	}
	if _, err := os.Stat(owners); !os.IsNotExist(err) {
		t.Fatalf("recorded an adoption it refused: %v", err)
	}
	// The Hub App itself still redeploys with its volume.
	if _, err := (ShellRunner{Docker: d.path}).Deploy(context.Background(), "postgres:16", "db",
		[]string{"-v", "postgres-data:/var/lib/postgresql/data"}, nil, 0); err != nil {
		t.Fatal(err)
	}
}

func TestDeployAppRefusesAVolumeAnyOtherContainerMounts(t *testing.T) {
	for name, tc := range map[string]struct{ container, json string }{
		"labelled for another App":    {"shop-db-main", mounting(`{"erainfra.app":"shop-db","erainfra.service":"main"}`, `{"shop-db-net":{"Aliases":["main"]}}`, "shop-db-data")},
		"another App's Hub service":   {"shop-db-main", mounting(`null`, `{"shop-db-net":{"Aliases":["main"]}}`, "shop-db-data")},
		"started by hand":             {"pg", mounting(`{}`, `{"bridge":{"Aliases":null}}`, "shop-db-data")},
		"App's prefix, not its shape": {"shop-pg", mounting(`{}`, `{"bridge":{"Aliases":null}}`, "shop-db-data")},
	} {
		t.Run(name, func(t *testing.T) {
			d := newStateDocker(t)
			d.put(t, "container", tc.container, tc.json)
			d.put(t, "volume", "shop-db-data", `[{"Labels":{}}]`)
			err := deployService(t, d, "shop", Service{Name: "db", Image: "p:1", Args: []string{"-v", "shop-db-data:/d"}})
			if err == nil || !strings.Contains(err.Error(), "refusing to mount it") || !strings.Contains(err.Error(), "container "+tc.container) {
				t.Fatalf("err = %v", err)
			}
			if d.has(t, "run ") {
				t.Fatalf("started a container after refusing: %q", d.calls(t))
			}
		})
	}
}

// The App's own containers, labelled or in the shape the Hub gave them, running or stopped, may
// share the volume. The App adopts it, and the record then refuses every other App even after the
// App's containers are gone, as a label on the volume would.
func TestDeployAppAdoptsAHubVolumeItsOwnContainersMount(t *testing.T) {
	d := newStateDocker(t)
	d.put(t, "container", "shop-db", mounting(`null`, `{"shop-net":{"Aliases":["db","3f2a"]}}`, "shop-db-data"))
	d.put(t, "container", "shop-backup", mounting(`{"erainfra.app":"shop","erainfra.service":"backup"}`, `{"shop-net":{"Aliases":["backup"]}}`, "shop-db-data"))
	d.put(t, "volume", "shop-db-data", `[{"Labels":null}]`)
	owners := filepath.Join(t.TempDir(), "volume-owners")
	runner := ShellRunner{Docker: d.path, VolumeOwners: owners}
	if _, err := runner.DeployApp(context.Background(), "shop", []Service{{Name: "db", Image: "p:1", Args: []string{"-v", "shop-db-data:/d"}}}); err != nil {
		t.Fatal(err)
	}
	if raw, err := os.ReadFile(filepath.Join(owners, "shop-db-data")); err != nil || string(raw) != "shop\n" {
		t.Fatalf("adoption record = %q, %v", raw, err)
	}
	if d.has(t, "volume create") {
		t.Fatalf("recreated an existing volume: %q", d.calls(t))
	}
	// Its redeploy reads its own record.
	if _, err := runner.DeployApp(context.Background(), "shop", []Service{{Name: "db", Image: "p:2", Args: []string{"-v", "shop-db-data:/d"}}}); err != nil {
		t.Fatal(err)
	}
	// App shop removed: no container mounts the volume any more, and App shop-db derives its name.
	for _, c := range []string{"shop-db", "shop-backup"} {
		if err := os.Remove(filepath.Join(d.dir, "container", c+".json")); err != nil {
			t.Fatal(err)
		}
	}
	_, err := runner.DeployApp(context.Background(), "shop-db", []Service{{Name: "web", Image: "x:1", Args: []string{"-v", "shop-db-data:/steal"}}})
	if err == nil || !strings.Contains(err.Error(), `volume shop-db-data was adopted by App "shop" on this Node`) {
		t.Fatalf("err = %v", err)
	}
	// The single-container Deploy path is held to the same record.
	if _, err := runner.Deploy(context.Background(), "x:1", "shop-db", []string{"-v", "shop-db-data:/d"}, nil, 0); err == nil {
		t.Fatal("a single-container App mounted a volume another App adopted")
	}
}

// Moving the Hub's single-container App db to services: the services must not start on the volume
// while the single container still writes to it. Once it is removed, App db adopts the volume.
func TestDeployAppRefusesAVolumeItsOtherDeploymentKindStillMounts(t *testing.T) {
	for name, existing := range map[string]string{
		"Hub-era":  mounting(`{}`, `{"bridge":{"Aliases":null}}`, "db-data"),
		"labelled": mounting(`{"erainfra.app":"db"}`, `{"bridge":{"Aliases":null}}`, "db-data"),
	} {
		t.Run(name, func(t *testing.T) {
			d := newStateDocker(t)
			d.put(t, "container", "db", existing)
			d.put(t, "volume", "db-data", `[{"Labels":null}]`)
			err := deployService(t, d, "db", Service{Name: "main", Image: "postgres:16", Args: []string{"-v", "db-data:/var/lib/postgresql/data"}})
			if err == nil || !strings.Contains(err.Error(), `volume db-data is mounted by container db, App "db"'s single-container deployment, which this deploy does not replace`) {
				t.Fatalf("err = %v", err)
			}
			if d.has(t, "run ") {
				t.Fatalf("started a container after refusing: %q", d.calls(t))
			}
			if err := os.Remove(filepath.Join(d.dir, "container", "db.json")); err != nil {
				t.Fatal(err)
			}
			if err := deployService(t, d, "db", Service{Name: "main", Image: "postgres:16", Args: []string{"-v", "db-data:/var/lib/postgresql/data"}}); err != nil {
				t.Fatal(err)
			}
		})
	}
	// And the other way round: the single container does not start beside the services.
	d := newStateDocker(t)
	d.put(t, "container", "db-main", mounting(`null`, `{"db-net":{"Aliases":["main"]}}`, "db-data"))
	d.put(t, "volume", "db-data", `[{"Labels":null}]`)
	_, err := ShellRunner{Docker: d.path}.Deploy(context.Background(), "postgres:16", "db", []string{"-v", "db-data:/d"}, nil, 0)
	if err == nil || !strings.Contains(err.Error(), `App "db"'s service container`) {
		t.Fatalf("err = %v", err)
	}
}

// A volume no container mounts tells nothing about its App: the first App to mount it adopts it.
// Every volume is checked before any is created or adopted, so a refusal records nothing.
func TestDeployAppChecksEveryVolumeBeforeChangingAny(t *testing.T) {
	d := newStateDocker(t)
	d.put(t, "volume", "shop-cache", `[{"Labels":null}]`)
	d.put(t, "volume", "shop-db-data", `[{"Labels":{"erainfra.app":"shop-db"}}]`)
	owners := filepath.Join(t.TempDir(), "volume-owners")
	runner := ShellRunner{Docker: d.path, VolumeOwners: owners}
	_, err := runner.DeployApp(context.Background(), "shop", []Service{
		{Name: "web", Image: "w:1", Args: []string{"-v", "shop-uploads:/u", "-v", "shop-cache:/c"}},
		{Name: "db", Image: "p:1", Args: []string{"-v", "shop-db-data:/d"}},
	})
	if err == nil || !strings.Contains(err.Error(), `volume shop-db-data belongs to App "shop-db"`) {
		t.Fatalf("err = %v", err)
	}
	if d.has(t, "volume create") {
		t.Fatalf("created a volume before refusing: %q", d.calls(t))
	}
	if _, err := os.Stat(filepath.Join(owners, "shop-cache")); !os.IsNotExist(err) {
		t.Fatalf("adopted a volume before refusing: %v", err)
	}
	if _, err := runner.DeployApp(context.Background(), "shop", []Service{
		{Name: "web", Image: "w:1", Args: []string{"-v", "shop-uploads:/u", "-v", "shop-cache:/c"}},
	}); err != nil {
		t.Fatal(err)
	}
	if !d.has(t, "volume create --label erainfra.app=shop shop-uploads") {
		t.Fatalf("calls %q", d.calls(t))
	}
	if raw, err := os.ReadFile(filepath.Join(owners, "shop-cache")); err != nil || string(raw) != "shop\n" {
		t.Fatalf("adoption record = %q, %v", raw, err)
	}
}

func TestDeployAppRefusesWhenItCannotListAVolumesContainers(t *testing.T) {
	path := filepath.Join(t.TempDir(), "docker")
	script := "#!/bin/sh\n" +
		"[ \"$1 $2\" = 'volume inspect' ] && { echo '[{\"Labels\":null}]'; exit 0; }\n" +
		"[ \"$2\" = inspect ] && { echo 'Error: No such object' >&2; exit 1; }\n" +
		"[ \"$1\" = ps ] && { echo 'Cannot connect to the Docker daemon' >&2; exit 1; }\n" +
		"exit 0\n"
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	_, err := ShellRunner{Docker: path}.DeployApp(context.Background(), "shop", []Service{{Name: "db", Image: "p:1", Args: []string{"-v", "legacy:/d"}}})
	if err == nil || !strings.Contains(err.Error(), "list containers mounting volume legacy") {
		t.Fatalf("err = %v", err)
	}
}
