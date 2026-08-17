// Package rename is the Infra Agent's half of stage 1 of retiring "Portless" from running systems
// (ADR 0004; CONTEXT.md rule 4).
//
// Rule 4 freezes every identifier a customer's Node already holds, because a mistake there silently
// disconnects it. Retiring the name therefore takes three releases, and this is the first: read
// BOTH names, prefer the new one, warn when the old one is what was found, delete nothing. Nothing
// in this release writes an ERAINFRA_* name, so on every Node in the field today Env returns exactly
// what os.Getenv returned before and logs one line.
//
// It lives here rather than in internal/agent because package main reads --hub and --token defaults
// before it constructs anything, and both halves must warn the same way.
//
// The same idiom in TypeScript is apps/hub/src/env.ts; in shell it is deploy/infra/agent.sh's
// dual_env. Three runtimes, one rule — see convex/installScript.ts:649, which established it for
// the runner-center-agent- → erainfra-agent- asset rename.
package rename

import (
	"fmt"
	"os"
	"sync"
)

// Once per retired name per process: connect() re-dials forever, so a warning tied to a reconnect
// would grow without bound in the Node's journal.
var (
	mu     sync.Mutex
	warned = map[string]bool{}
)

// Warn reports once that a retired name is still what was found.
func Warn(old, next, note string) {
	mu.Lock()
	defer mu.Unlock()
	if warned[old] {
		return
	}
	warned[old] = true
	fmt.Fprintf(os.Stderr, "[erainfra] %s is a retired name — use %s instead. %s\n", old, next, note)
}

// Env reads a renamed environment variable: the new name wins, the old one still works and warns.
//
// os.LookupEnv rather than os.Getenv so "set to empty" and "unset" stay distinguishable: an
// operator who exported PORTLESS_TOKEN= meant the empty string, and a helper that skipped past it
// to a stale value under the other name would change what a Node does, not only what it prints.
func Env(newName, oldName string) string {
	if v, ok := os.LookupEnv(newName); ok {
		return v
	}
	v, ok := os.LookupEnv(oldName)
	if !ok {
		return ""
	}
	Warn(oldName, newName, "The old name still works; a later release will say when it stops.")
	return v
}

// Reset clears the warn-once state. Test seam only.
func Reset() {
	mu.Lock()
	defer mu.Unlock()
	warned = map[string]bool{}
}
