package rename

import (
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// Stage 1 of retiring the "Portless" name (ADR 0004; CONTEXT.md rule 4). Four cases, and the
// fourth — neither name set — is the one that breaks a Node silently, because `--hub` and
// `--token` take their defaults from these and an empty default is not an error until the dial
// fails minutes later.

func TestEnvPrefersTheNewNameSilently(t *testing.T) {
	Reset()
	t.Setenv("ERAINFRA_HUB", "wss://new.example/agent")
	if got := Env("ERAINFRA_HUB", "PORTLESS_HUB"); got != "wss://new.example/agent" {
		t.Fatalf("new name only: got %q", got)
	}
	if warned["PORTLESS_HUB"] {
		t.Fatal("the supported name must not warn")
	}
}

func TestEnvAcceptsTheRetiredNameAndSaysSoOnce(t *testing.T) {
	Reset()
	t.Setenv("PORTLESS_HUB", "wss://old.example/agent")
	// Read twice: connect() re-dials forever, so a warning that fired per read would fill a Node's
	// journal on its own.
	for i := 0; i < 3; i++ {
		if got := Env("ERAINFRA_HUB", "PORTLESS_HUB"); got != "wss://old.example/agent" {
			t.Fatalf("old name only, read %d: got %q — every Node in the field sets only this", i, got)
		}
	}
	if !warned["PORTLESS_HUB"] {
		t.Fatal("accepting a retired name without saying so is how it never gets migrated")
	}
}

func TestEnvNewNameWinsWhenBothAreSet(t *testing.T) {
	Reset()
	t.Setenv("ERAINFRA_TOKEN", "new")
	t.Setenv("PORTLESS_TOKEN", "old")
	if got := Env("ERAINFRA_TOKEN", "PORTLESS_TOKEN"); got != "new" {
		t.Fatalf("both set: got %q, want the new name's value", got)
	}
}

func TestEnvWithNeitherSetReturnsEmptySoTheFlagDefaultSurvives(t *testing.T) {
	Reset()
	// Not t.Setenv: this case is about both names being ABSENT.
	if got := Env("ERAINFRA_NOTHING_IS_SET", "PORTLESS_NOTHING_IS_SET"); got != "" {
		t.Fatalf("neither set: got %q, want the empty string os.Getenv would have returned", got)
	}
	if len(warned) != 0 {
		t.Fatal("nothing retired was found, so there is nothing to warn about")
	}
}

func TestEnvTreatsTheEmptyStringAsSet(t *testing.T) {
	Reset()
	// PORTLESS_TOKEN= means the empty string. Falling through to the other name would change what
	// a Node does rather than only what it prints.
	t.Setenv("ERAINFRA_TOKEN", "")
	t.Setenv("PORTLESS_TOKEN", "old")
	if got := Env("ERAINFRA_TOKEN", "PORTLESS_TOKEN"); got != "" {
		t.Fatalf("new name set to empty: got %q, want the empty string it was set to", got)
	}
}

// THE property this release rests on: a Node that has never heard of the new names behaves exactly
// as it did. Every variable the Infra Agent reads, set only under its retired name.
// Every variable the Infra Agent reads under a retired name. Hoisted out of the test below so the
// completeness test can hold it against the sources: a table is only a safety property while it is
// complete, and nothing about adding a read site otherwise makes this list grow with it.
var agentVariables = [][2]string{
	{"PORTLESS_HUB", "ERAINFRA_HUB"},
	{"PORTLESS_TOKEN", "ERAINFRA_TOKEN"},
	{"PORTLESS_PREFIX", "ERAINFRA_PREFIX"},
}

func TestTheRetiredNameAloneIsSufficientForEveryVariableTheAgentReads(t *testing.T) {
	for _, pair := range agentVariables {
		Reset()
		marker := "only-the-old-name-was-set:" + pair[0]
		t.Setenv(pair[0], marker)
		os_unset(t, pair[1])
		if got := Env(pair[1], pair[0]); got != marker {
			t.Fatalf("%s alone no longer reaches its consumer (got %q) — this would disconnect live Nodes", pair[0], got)
		}
		if !warned[pair[0]] {
			t.Fatalf("%s was accepted without saying it is retired", pair[0])
		}
	}
}

// The Hub half of this PR proves its own table complete by reading its sources
// (apps/hub/test/renamed-identifiers.test.ts). The Agent needs the same guard for the same reason:
// the test above is a loop over a hand-written list, so a fourth `rename.Env` added anywhere in the
// Agent would be dual-read but never proven sufficient, and the suite would stay green while the
// property it claims quietly stopped covering everything.
//
// Both directions, because each fails differently: a read site missing from the table is an
// unproven variable, and a table row with no read site is a name that has already been removed and
// left a row asserting nothing.
func TestEveryRetiredNameTheAgentReadsIsCoveredByTheTableAbove(t *testing.T) {
	root := filepath.Join("..", "..")
	// This package implements the fallback and tests it; everywhere else must go through it.
	self := filepath.Join(root, "internal", "rename")
	call := regexp.MustCompile(`Env\(\s*"(ERAINFRA_[A-Z0-9_]+)"\s*,\s*"(PORTLESS_[A-Z0-9_]+)"\s*\)`)
	raw := regexp.MustCompile(`os\.Getenv\(\s*"(PORTLESS_[A-Z0-9_]+)"`)

	found := map[string]bool{}
	walked := 0
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(path, ".go") {
			return err
		}
		if filepath.Dir(path) == self {
			return nil
		}
		source, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		walked++
		for _, m := range call.FindAllStringSubmatch(string(source), -1) {
			if want := strings.Replace(m[2], "PORTLESS_", "ERAINFRA_", 1); m[1] != want {
				t.Errorf("%s: %s is paired with %s, not its prefix-swapped name %s", path, m[2], m[1], want)
			}
			found[m[2]] = true
		}
		// A raw read bypasses the fallback entirely, so it would be invisible to the scan above
		// while breaking exactly the boxes this PR exists to protect.
		for _, m := range raw.FindAllStringSubmatch(string(source), -1) {
			t.Errorf("%s: reads %s directly — route it through rename.Env so the old name keeps working", path, m[1])
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk %s: %v", root, err)
	}
	// A scan that read nothing reports the same green as a scan that found nothing wrong. The
	// Agent is more than a handful of files, so a walk that turned up almost none means the root
	// moved and this test has quietly stopped guarding anything.
	if walked < 5 {
		t.Fatalf("scanned only %d Go files under %s — the walk root is wrong, so this test proves nothing", walked, root)
	}

	listed := map[string]bool{}
	for _, pair := range agentVariables {
		listed[pair[0]] = true
		if !found[pair[0]] {
			t.Errorf("%s is in the table but no longer read anywhere — the row asserts nothing", pair[0])
		}
	}
	for name := range found {
		if !listed[name] {
			t.Errorf("%s is read but not in agentVariables — it is dual-read but never proven sufficient", name)
		}
	}
}

// There is no t.Unsetenv. t.Setenv registers the restore, so setting then unsetting leaves the
// variable genuinely absent for this test and still restored afterwards — which matters, because
// "absent" is the state every box in the field is actually in.
func os_unset(t *testing.T, key string) {
	t.Helper()
	t.Setenv(key, "")
	if err := os.Unsetenv(key); err != nil {
		t.Fatalf("unset %s: %v", key, err)
	}
}
