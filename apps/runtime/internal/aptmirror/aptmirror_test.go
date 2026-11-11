package aptmirror

import (
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestValidateAcceptsAnHTTPProxy(t *testing.T) {
	for _, value := range []string{
		"http://10.20.0.7:3142",
		"http://10.20.0.7:3142/",
		"http://apt-mirror.lan",
		"http://[fd00::7]:3142",
	} {
		if err := Validate(value); err != nil {
			t.Errorf("Validate(%q) = %v, want nil", value, err)
		}
	}
}

func TestValidateRejectsWhatAptOrTheShellCannotTake(t *testing.T) {
	for _, value := range []string{
		"",
		"10.20.0.7:3142",               // no scheme
		"https://apt-mirror.lan",       // apt would tunnel through it, not cache
		"HTTP://apt-mirror.lan",        // scheme is matched exactly
		"http://",                      // no host
		"http://:3142",                 // a port is not a host
		"http://u:p@apt-mirror.lan",    // credentials would be readable by every job
		"http://apt-mirror.lan?x=1",    // query
		"http://apt-mirror.lan#frag",   // fragment
		"http://apt-mirror.lan/ubuntu", // a path is not a proxy
		"http://apt-mirror.lan /",      // whitespace
		"http://apt-mirror.lan\n",      // control character
		"http://apt_mirror.lan",        // not a hostname
		"http://apt-mirror.lan:0",      // port out of range
		"http://apt-mirror.lan:99999",  // port out of range
		"http://[::1",                  // does not parse
		"http://$(touch%20x).lan",      // shell in the host
		"http://apt-mirror.lan:31a2",   // not a number
	} {
		if err := Validate(value); err == nil {
			t.Errorf("Validate(%q) accepted a value that must be refused", value)
		}
	}
}

func TestConfNamesTheProbeScript(t *testing.T) {
	want := `Acquire::http::Proxy-Auto-Detect "/usr/local/libexec/erainfra-apt-proxy";`
	if !strings.Contains(Conf(), want) {
		t.Fatalf("Conf() = %q, want it to contain %q", Conf(), want)
	}
}

// The script is run for real: it must print the proxy when the mirror accepts
// connections and DIRECT when nothing listens.
func TestScriptAnswersTheMirrorOrDirect(t *testing.T) {
	if _, err := exec.LookPath("bash"); err != nil {
		t.Skip("bash is not installed")
	}
	if _, err := exec.LookPath("timeout"); err != nil {
		t.Skip("timeout is not installed")
	}
	var config net.ListenConfig
	listener, err := config.Listen(t.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	mirror := "http://" + listener.Addr().String() + "/"
	run := func() string {
		path := filepath.Join(t.TempDir(), "probe")
		if err := os.WriteFile(path, []byte(Script(mirror)), 0o755); err != nil {
			t.Fatal(err)
		}
		out, err := exec.CommandContext(t.Context(), path, "http://archive.ubuntu.com/ubuntu").Output()
		if err != nil {
			t.Fatalf("probe failed: %v", err)
		}
		return strings.TrimSpace(string(out))
	}
	if got := run(); got != Canonical(mirror) {
		t.Fatalf("with the mirror up, probe printed %q, want %q", got, Canonical(mirror))
	}
	_ = listener.Close()
	if got := run(); got != "DIRECT" {
		t.Fatalf("with the mirror down, probe printed %q, want DIRECT", got)
	}
}

func TestApplyWritesTheScriptAndTheSnippet(t *testing.T) {
	root := t.TempDir()
	if err := Apply(root, "http://10.20.0.7:3142"); err != nil {
		t.Fatal(err)
	}
	conf, err := os.ReadFile(filepath.Join(root, ConfPath))
	if err != nil || string(conf) != Conf() {
		t.Fatalf("snippet = %q, %v", conf, err)
	}
	info, err := os.Stat(filepath.Join(root, ScriptPath))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o755 {
		t.Fatalf("script mode = %v, want 0755", info.Mode().Perm())
	}
	if err := Apply(root, "https://apt-mirror.lan"); err == nil {
		t.Fatal("Apply wrote an invalid mirror")
	}
}

func TestScriptDefaultsToPort80(t *testing.T) {
	if !strings.Contains(Script("http://apt-mirror.lan"), "/dev/tcp/apt-mirror.lan/80") {
		t.Fatal("a mirror with no port must be probed on port 80")
	}
}
