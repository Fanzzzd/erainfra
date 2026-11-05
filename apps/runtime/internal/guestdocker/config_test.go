package guestdocker

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestRenderDaemonJSONSetsTheMirrorAndKeepsEverythingElse(t *testing.T) {
	existing := []byte(`{"log-driver":"json-file","registry-mirrors":["https://old.example/"],"features":{"buildkit":true}}`)
	out, err := RenderDaemonJSON(existing, "http://10.20.0.5:5000")
	if err != nil {
		t.Fatal(err)
	}
	var parsed map[string]any
	if err := json.Unmarshal(out, &parsed); err != nil {
		t.Fatalf("rendered daemon.json does not parse: %v\n%s", err, out)
	}
	mirrors, _ := parsed["registry-mirrors"].([]any)
	if len(mirrors) != 1 || mirrors[0] != "http://10.20.0.5:5000/" {
		t.Fatalf("registry-mirrors = %v, want exactly the one canonical mirror", parsed["registry-mirrors"])
	}
	if parsed["log-driver"] != "json-file" {
		t.Fatalf("an unrelated key was lost: %s", out)
	}
	if features, _ := parsed["features"].(map[string]any); features["buildkit"] != true {
		t.Fatalf("a nested key was lost: %s", out)
	}
}

func TestRenderDaemonJSONFromNothing(t *testing.T) {
	for _, existing := range [][]byte{nil, []byte("  \n")} {
		out, err := RenderDaemonJSON(existing, "https://mirror.lan")
		if err != nil {
			t.Fatal(err)
		}
		if string(out) != "{\n  \"registry-mirrors\": [\n    \"https://mirror.lan/\"\n  ]\n}\n" {
			t.Fatalf("daemon.json from nothing:\n%s", out)
		}
	}
}

// dockerd refuses to start on a daemon.json it cannot parse, so the guest must
// never turn a file it cannot read into one it wrote.
func TestRenderDaemonJSONRefusesToClobber(t *testing.T) {
	for _, existing := range []string{"{not json", "null", "[]"} {
		if _, err := RenderDaemonJSON([]byte(existing), "https://mirror.lan"); err == nil {
			t.Errorf("rendered over %q", existing)
		}
	}
	if _, err := RenderDaemonJSON(nil, "mirror.lan:5000"); err == nil {
		t.Error("rendered a mirror dockerd would refuse")
	}
}

func TestRenderBuildkitdConfigNothingToSay(t *testing.T) {
	out, ok, err := RenderBuildkitdConfig(BuildkitdConfig{})
	if err != nil || ok || out != nil {
		t.Fatalf("empty config rendered %q, ok %v, err %v", out, ok, err)
	}
	if _, _, err := RenderBuildkitdConfig(BuildkitdConfig{CacheHost: "h"}); err == nil {
		t.Fatal("a cache host without a CA path rendered")
	}
}

func TestRenderBuildkitdConfigPlainMirrorAndCache(t *testing.T) {
	out, ok, err := RenderBuildkitdConfig(BuildkitdConfig{
		MirrorURL:   "http://10.20.0.5:5000/",
		CacheHost:   "results-receiver.actions.githubusercontent.com",
		CacheCAPath: "/usr/local/share/ca-certificates/erainfra-cache.crt",
	})
	if err != nil || !ok {
		t.Fatalf("ok %v, err %v", ok, err)
	}
	body := string(out)
	for _, want := range []string{
		"[registry.\"docker.io\"]\n  mirrors = [\"10.20.0.5:5000\"]\n",
		// BuildKit has to be told a mirror is plain HTTP on the mirror's own
		// host entry.
		"[registry.\"10.20.0.5:5000\"]\n  http = true\n",
		"[registry.\"results-receiver.actions.githubusercontent.com\"]\n  ca = [\"/usr/local/share/ca-certificates/erainfra-cache.crt\"]\n",
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("buildkitd.toml missing %q:\n%s", want, body)
		}
	}
}

func TestRenderBuildkitdConfigHTTPSMirrorNeedsNoHTTPEntry(t *testing.T) {
	out, ok, err := RenderBuildkitdConfig(BuildkitdConfig{MirrorURL: "https://mirror.lan"})
	if err != nil || !ok {
		t.Fatalf("ok %v, err %v", ok, err)
	}
	if strings.Contains(string(out), "http = true") || strings.Contains(string(out), " ca = ") {
		t.Fatalf("https mirror with no cache rendered extra entries:\n%s", out)
	}
	if !strings.Contains(string(out), `mirrors = ["mirror.lan"]`) {
		t.Fatalf("mirror missing:\n%s", out)
	}
}

func TestRenderBuildkitdConfigRefusesWhatWouldBreakTheFile(t *testing.T) {
	if _, _, err := RenderBuildkitdConfig(BuildkitdConfig{CacheHost: "h", CacheCAPath: "/a\"b"}); err == nil {
		t.Fatal("a quote reached buildkitd.toml")
	}
	if _, _, err := RenderBuildkitdConfig(BuildkitdConfig{MirrorURL: "https://u:p@mirror.lan"}); err == nil {
		t.Fatal("an invalid mirror reached buildkitd.toml")
	}
}
