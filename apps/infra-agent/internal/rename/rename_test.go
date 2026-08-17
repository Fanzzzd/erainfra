package rename

import (
	"os"
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
func TestTheRetiredNameAloneIsSufficientForEveryVariableTheAgentReads(t *testing.T) {
	for _, pair := range [][2]string{
		{"PORTLESS_HUB", "ERAINFRA_HUB"},
		{"PORTLESS_TOKEN", "ERAINFRA_TOKEN"},
		{"PORTLESS_PREFIX", "ERAINFRA_PREFIX"},
	} {
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
