package dualenv

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// unset makes a variable genuinely absent for one test and restores it afterwards. There is no
// t.Unsetenv; t.Setenv registers the restore.
func unset(t *testing.T, name string) {
	t.Helper()
	t.Setenv(name, "")
	if err := os.Unsetenv(name); err != nil {
		t.Fatalf("unset %s: %v", name, err)
	}
}

// set applies one row's environment. A nil pointer means "absent", which is a different state
// from "set to empty" and the one every box in the field is in for ERAINFRA_ names.
func set(t *testing.T, name string, value *string) {
	t.Helper()
	if value == nil {
		unset(t, name)
		return
	}
	t.Setenv(name, *value)
}

func ptr(value string) *string { return &value }

func TestValueAfterCheck(t *testing.T) {
	for _, row := range []struct {
		name       string
		current    *string
		legacy     *string
		want       string
		conflicted bool
	}{
		// Every controller and Worker in the field today.
		{name: "only the legacy name", legacy: ptr("old"), want: "old"},
		{name: "only the new name", current: ptr("new"), want: "new"},
		{name: "both, equal", current: ptr("same"), legacy: ptr("same"), want: "same"},
		{name: "both, different", current: ptr("value-under-new"), legacy: ptr("value-under-old"), conflicted: true},
		{name: "neither", want: ""},
		// An empty value meant "unset" at every RC_ read site before this package, so it still
		// does, under either name, and an empty name cannot conflict with a set one.
		{name: "new name empty, legacy set", current: ptr(""), legacy: ptr("old"), want: "old"},
		{name: "legacy empty, new name set", current: ptr("new"), legacy: ptr(""), want: "new"},
		{name: "both empty", current: ptr(""), legacy: ptr(""), want: ""},
		// Values are compared exactly. Copying an env file line for line (runbook section 3)
		// produces equal values; anything else is a difference someone should look at.
		{name: "differ only in whitespace", current: ptr("token "), legacy: ptr("token"), conflicted: true},
	} {
		t.Run(row.name, func(t *testing.T) {
			set(t, "ERAINFRA_DUALENV_TEST", row.current)
			set(t, "RC_DUALENV_TEST", row.legacy)

			err := Check()
			if row.conflicted {
				var conflict *ConflictError
				if !errors.As(err, &conflict) {
					t.Fatalf("Check = %v; want a ConflictError", err)
				}
				for _, name := range []string{"ERAINFRA_DUALENV_TEST", "RC_DUALENV_TEST"} {
					if !strings.Contains(err.Error(), name) {
						t.Fatalf("conflict error %q does not name %s", err, name)
					}
				}
				for _, value := range []string{*row.current, *row.legacy} {
					if strings.Contains(err.Error(), strings.TrimSpace(value)) {
						t.Fatalf("conflict error %q prints a value; some of these variables are secrets", err)
					}
				}
				return
			}
			if err != nil {
				t.Fatalf("Check = %v, want nil", err)
			}
			if value := Value("RC_DUALENV_TEST"); value != row.want {
				t.Fatalf("Value = %q, want %q", value, row.want)
			}
		})
	}
}

func TestCheck(t *testing.T) {
	for _, row := range []struct {
		name  string
		env   map[string]*string
		names []string // the RC_ names the error must carry, in order; none means no error
	}{
		{name: "legacy names only", env: map[string]*string{"RC_DUALENV_A": ptr("1"), "RC_DUALENV_B": ptr("2")}},
		{name: "new names only", env: map[string]*string{"ERAINFRA_DUALENV_A": ptr("1")}},
		{name: "equal pairs", env: map[string]*string{"ERAINFRA_DUALENV_A": ptr("1"), "RC_DUALENV_A": ptr("1")}},
		{name: "empty new name", env: map[string]*string{"ERAINFRA_DUALENV_A": ptr(""), "RC_DUALENV_A": ptr("1")}},
		{name: "empty legacy name", env: map[string]*string{"ERAINFRA_DUALENV_A": ptr("1"), "RC_DUALENV_A": ptr("")}},
		{
			name: "every conflicting pair is named, sorted",
			env: map[string]*string{
				"ERAINFRA_DUALENV_B": ptr("x"), "RC_DUALENV_B": ptr("y"),
				"ERAINFRA_DUALENV_A": ptr("x"), "RC_DUALENV_A": ptr("y"),
				"ERAINFRA_DUALENV_C": ptr("same"), "RC_DUALENV_C": ptr("same"),
			},
			names: []string{"RC_DUALENV_A", "RC_DUALENV_B"},
		},
	} {
		t.Run(row.name, func(t *testing.T) {
			for name, value := range row.env {
				set(t, name, value)
			}
			err := Check()
			if len(row.names) == 0 {
				if err != nil {
					t.Fatalf("Check = %v, want nil", err)
				}
				return
			}
			if err == nil {
				t.Fatalf("Check = nil, want conflicts on %v", row.names)
			}
			message, at := err.Error(), -1
			for _, legacy := range row.names {
				next := strings.Index(message, NewName(legacy)+" and "+legacy)
				if next <= at {
					t.Fatalf("Check error %q does not name %s and %s after the previous pair", message, NewName(legacy), legacy)
				}
				at = next
			}
			if strings.Contains(message, "RC_DUALENV_C") {
				t.Fatalf("Check error %q names a pair whose values agree", message)
			}
		})
	}
}

func TestNewNameRefusesANameThatIsNotLegacy(t *testing.T) {
	if got := NewName("RC_PROFILE"); got != "ERAINFRA_PROFILE" {
		t.Fatalf("NewName(RC_PROFILE) = %q", got)
	}
	for _, name := range []string{"PROFILE", "RC_", "ERAINFRA_PROFILE"} {
		func() {
			defer func() {
				if recover() == nil {
					t.Errorf("NewName(%q) did not panic", name)
				}
			}()
			NewName(name)
		}()
	}
}

// The helper only protects the read sites that use it. A raw os.Getenv("RC_...") added anywhere in
// the controller, runtime or cache service would read one name and quietly ignore the other, and
// no other test would notice until an operator's ERAINFRA_ setting had no effect.
func TestNoWorkerSideGoCodeReadsAnRCVariableDirectly(t *testing.T) {
	root := filepath.Join("..", "..")
	raw := regexp.MustCompile(`os\.(Getenv|LookupEnv)\(\s*"RC_[A-Z0-9_]+"`)
	walked := 0
	for _, dir := range []string{"apps/controller", "apps/runtime", "apps/cache-service", "apps/erainfra-cli"} {
		err := filepath.WalkDir(filepath.Join(root, dir), func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() && d.Name() == "node_modules" {
				return filepath.SkipDir
			}
			if d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
				return nil
			}
			source, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			walked++
			for _, match := range raw.FindAllString(string(source), -1) {
				t.Errorf("%s: %s reads one name only; use dualenv.Value", path, match)
			}
			return nil
		})
		if err != nil {
			t.Fatalf("walk %s: %v", dir, err)
		}
	}
	// A walk that read almost nothing passes for the same reason a correct tree does.
	if walked < 20 {
		t.Fatalf("scanned only %d Go files; the walk root is wrong, so this test proves nothing", walked)
	}
}
