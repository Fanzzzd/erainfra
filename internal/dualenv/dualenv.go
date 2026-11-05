// Package dualenv reads the Worker-side environment under both of its names: the legacy RC_<NAME>
// that every controller, runtime and Worker in the field holds, and ERAINFRA_<NAME>, the name it
// is moving to (docs/runbooks/rename-phase-2.md, section 1).
//
// This is the expand step. Nothing here writes an ERAINFRA_ name, and the installers and the
// Action Runner Agent keep writing the RC_ names, so on every machine in the field each read below
// returns exactly what os.Getenv returned before.
//
// The rules, shared with the TypeScript, sh and PowerShell copies (apps/action-runner-agent
// dual-env.ts, provisioners/*.sh, provisioners/provision-win.ps1, convex/installScript*.ts):
//
//   - ERAINFRA_<NAME> wins over RC_<NAME>.
//   - An empty value counts as unset, under either name. Every RC_ read site treated an empty
//     value as unset before this package existed, and keeping that per name is what makes this
//     release change nothing for a box that sets only the old one.
//   - Both set, to different values, is an error that names both variables. Picking one silently
//     would let a half-finished environment migration (runbook section 3) run on the value nobody
//     meant. Values never appear in the error: several of these variables are secrets.
//
// It does not warn when only the RC_ name is set, as the Infra Agent's rename package does for
// PORTLESS_. During this release EraInfra's own installers and Agent still write RC_ names on
// purpose, so a warning would fire on every Attempt with nothing for an operator to change. The
// release that flips the writers adds the warning.
package dualenv

import (
	"errors"
	"fmt"
	"os"
	"sort"
	"strings"
)

const (
	legacyPrefix = "RC_"
	newPrefix    = "ERAINFRA_"
)

// NewName returns the ERAINFRA_ name for a legacy RC_ name.
func NewName(legacy string) string {
	if !strings.HasPrefix(legacy, legacyPrefix) || len(legacy) == len(legacyPrefix) {
		// Every caller passes a constant, so this is a programming error a test reaches first.
		panic("dualenv: " + legacy + " is not an RC_ variable name")
	}
	return newPrefix + strings.TrimPrefix(legacy, legacyPrefix)
}

// ConflictError reports a variable set under both names to different values.
type ConflictError struct {
	New    string
	Legacy string
}

func (e *ConflictError) Error() string {
	return fmt.Sprintf(
		"%s and %s are both set, to different values; remove one, or give both the same value",
		e.New, e.Legacy,
	)
}

// Get returns the value of ERAINFRA_<NAME>, or of RC_<NAME> when the new name is unset or empty.
// It fails when both are set to different non-empty values.
func Get(legacy string) (string, error) {
	newName := NewName(legacy)
	current, old := os.Getenv(newName), os.Getenv(legacy)
	if current != "" && old != "" && current != old {
		return "", &ConflictError{New: newName, Legacy: legacy}
	}
	if current != "" {
		return current, nil
	}
	return old, nil
}

// Value is Get for a process that has already passed Check, which is the only state in which the
// two names cannot disagree. Called before Check it still prefers the new name, but a conflict is
// then nobody's error, so every entry point calls Check first.
func Value(legacy string) string {
	newName := NewName(legacy)
	if current := os.Getenv(newName); current != "" {
		return current
	}
	return os.Getenv(legacy)
}

// Check fails, naming every pair, when any RC_<NAME> in the environment has an ERAINFRA_<NAME>
// counterpart set to a different non-empty value. It looks at the whole environment rather than
// a list of the variables this program reads, so a list that falls behind a new read site cannot
// let a conflict through.
func Check() error {
	values := map[string]string{}
	for _, entry := range os.Environ() {
		name, value, _ := strings.Cut(entry, "=")
		values[name] = value
	}
	var conflicts []string
	for name, value := range values {
		suffix, ok := strings.CutPrefix(name, legacyPrefix)
		if !ok || suffix == "" || value == "" {
			continue
		}
		if current := values[newPrefix+suffix]; current != "" && current != value {
			conflicts = append(conflicts, name)
		}
	}
	sort.Strings(conflicts)
	errs := make([]error, 0, len(conflicts))
	for _, legacy := range conflicts {
		errs = append(errs, &ConflictError{New: NewName(legacy), Legacy: legacy})
	}
	return errors.Join(errs...)
}
