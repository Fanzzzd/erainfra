package guestcache

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestTrustEnvPointsEachClientAtSomethingHoldingTheCA(t *testing.T) {
	const ca = "/usr/local/share/ca-certificates/erainfra-cache.crt"
	got := TrustEnv(ca)
	want := []string{
		"NODE_EXTRA_CA_CERTS=" + ca,
		"REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt",
		"SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt",
	}
	if !slices.Equal(got, want) {
		t.Fatalf("TrustEnv = %q, want %q", got, want)
	}
	// Each is one more difference from ubuntu-latest, so the set is a decision:
	// these are covered by the system store already, or cannot be covered.
	for _, entry := range got {
		name, _, _ := strings.Cut(entry, "=")
		switch name {
		case "CURL_CA_BUNDLE", "SSL_CERT_DIR", "JAVA_TOOL_OPTIONS":
			t.Fatalf("TrustEnv sets %s, which earns no client its trust", name)
		}
	}
}

func TestSudoersContentKeepsExactlyTheTrustVariables(t *testing.T) {
	content := string(SudoersContent())
	if !strings.Contains(content, `Defaults env_keep += "NODE_EXTRA_CA_CERTS REQUESTS_CA_BUNDLE SSL_CERT_FILE"`+"\n") {
		t.Fatalf("drop-in = %q", content)
	}
}

// sudo refuses to start at all over a sudoers file it cannot parse, so the
// syntax is checked by the real visudo wherever one is installed.
func TestSudoersContentPassesVisudo(t *testing.T) {
	visudo, err := exec.LookPath("visudo")
	if err != nil {
		t.Skip("visudo is not installed here")
	}
	path := filepath.Join(t.TempDir(), "drop-in")
	if err := os.WriteFile(path, SudoersContent(), 0o440); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.CommandContext(t.Context(), visudo, "-cf", path).CombinedOutput(); err != nil {
		t.Fatalf("visudo -cf rejected the drop-in: %v: %s", err, out)
	}
}

func TestInstallSudoersDropInValidatesBeforeSudoCanReadIt(t *testing.T) {
	dir := t.TempDir()
	var validated string
	remove, err := InstallSudoersDropIn(t.Context(), dir, func(_ context.Context, path string) error {
		validated = path
		// sudo's includedir skips a name with a dot in it, so the staged file
		// is invisible to sudo until it is renamed.
		if !strings.Contains(filepath.Base(path), ".") {
			t.Errorf("validated %s, a name sudo would read", path)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	final := filepath.Join(dir, "erainfra-cache")
	info, err := os.Stat(final)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o440 {
		t.Fatalf("drop-in mode %v, want 0440", info.Mode().Perm())
	}
	if _, err := os.Stat(validated); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("the staged file was left behind")
	}
	remove()
	if _, err := os.Stat(final); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("remove left the drop-in in place")
	}
}

func TestInstallSudoersDropInLeavesNothingWhenValidationFails(t *testing.T) {
	dir := t.TempDir()
	_, err := InstallSudoersDropIn(t.Context(), dir, func(context.Context, string) error {
		return errors.New("visudo: syntax error")
	})
	if err == nil {
		t.Fatal("an invalid drop-in was installed")
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 0 {
		t.Fatalf("left %d files in sudoers.d", len(entries))
	}
	if _, err := InstallSudoersDropIn(t.Context(), dir, nil); err == nil {
		t.Fatal("installed with no validator")
	}
}

// The drop-in is part of the redirect: installed with it, removed with it,
// and a failure to install it leaves the guest untouched.
func TestRedirectOwnsTheSudoersDropIn(t *testing.T) {
	h := newHarness(t)
	sudoers := t.TempDir()
	cfg := h.config()
	cfg.SudoersDir = sudoers
	cfg.ValidateSudoers = func(context.Context, string) error { return nil }
	dropIn := filepath.Join(sudoers, "erainfra-cache")

	r, err := StartRedirect(t.Context(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dropIn); err != nil {
		t.Fatalf("redirect up without its sudoers drop-in: %v", err)
	}
	r.Stop()
	if _, err := os.Stat(dropIn); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("redirect down but the drop-in remains")
	}
	h.assertUntouched()

	cfg.ValidateSudoers = func(context.Context, string) error { return errors.New("visudo: syntax error") }
	if _, err := StartRedirect(t.Context(), cfg); err == nil {
		t.Fatal("redirect came up without its drop-in")
	}
	h.assertUntouched()
}

// A drop-in left by a crashed run goes even if this run then fails.
func TestStartRedirectClearsAStaleSudoersDropIn(t *testing.T) {
	h := newHarness(t)
	sudoers := t.TempDir()
	stale := filepath.Join(sudoers, "erainfra-cache")
	if err := os.WriteFile(stale, SudoersContent(), 0o440); err != nil {
		t.Fatal(err)
	}
	cfg := h.config()
	cfg.SudoersDir = sudoers
	cfg.ValidateSudoers = func(context.Context, string) error { return nil }
	h.discErr = errors.New("no such host")
	if _, err := StartRedirect(t.Context(), cfg); err == nil {
		t.Fatal("StartRedirect succeeded")
	}
	if _, err := os.Stat(stale); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("a stale drop-in survived")
	}
}
