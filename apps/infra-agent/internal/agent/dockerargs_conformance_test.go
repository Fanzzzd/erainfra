package agent

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// The same fixture is read by apps/hub/test/dockerargs.test.ts. It lives at the repository root
// rather than under either app because it belongs to neither: it is the definition of the
// boundary, and the two validators are implementations of it.
const conformanceFixture = "../../../../testdata/dockerargs-cases.json"

type dockerArgsCase struct {
	Name        string   `json:"name"`
	Args        []string `json:"args"`
	Expect      string   `json:"expect"`
	Provisional bool     `json:"provisional"`
	Why         string   `json:"why"`
}

func TestValidateDockerArgsMatchesTheSharedConformanceFixture(t *testing.T) {
	raw, err := os.ReadFile(filepath.Clean(conformanceFixture))
	if err != nil {
		t.Fatalf("read shared fixture: %v", err)
	}
	var fixture struct {
		Cases []dockerArgsCase `json:"cases"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("parse shared fixture: %v", err)
	}
	// A fixture that silently read as empty would turn this whole test into one that passes by
	// doing nothing, which is the one failure mode a table test has that a hand-written one does not.
	if len(fixture.Cases) == 0 {
		t.Fatal("no cases read from testdata/dockerargs-cases.json")
	}
	seen := make(map[string]bool, len(fixture.Cases))
	for _, c := range fixture.Cases {
		if seen[c.Name] {
			t.Fatalf("duplicate case name %q", c.Name)
		}
		seen[c.Name] = true
	}

	for _, c := range fixture.Cases {
		t.Run(c.Name, func(t *testing.T) {
			verdict := "accept"
			err := validateDockerArgs(c.Args)
			if err != nil {
				verdict = "reject"
			}
			if verdict != c.Expect {
				t.Fatalf("%q\n  expected %s, got %s (%v)\n  why: %s", c.Args, c.Expect, verdict, err, c.Why)
			}
		})
	}
}

// The shared fixture cannot carry this case, so it is pinned natively on each side instead.
// Measured: `encoding/json` rewrites an unpaired surrogate escape to U+FFFD, so `"a\ud800b"` in
// the fixture reaches Go as the five bytes 61 ef bf bd 62 — while JavaScript's JSON.parse keeps
// the lone surrogate and hands its validator a three-unit string. A row spelled that way would
// look shared and would in fact be testing two different inputs on the two sides, which is worse
// than not testing it. apps/hub/test/dockerargs.test.ts pins the JavaScript half of this.
//
// What both sides must do is agree in KIND: the control check is an ASCII byte predicate and is
// deliberately blind to whether the surrounding text is well-formed, so ill-formed bytes with no
// control character among them are accepted rather than being a second, unstated rule.
func TestValidateDockerArgsIsBlindToIllFormedText(t *testing.T) {
	illFormed := string([]byte{0x61, 0xff, 0x62}) // a, a bare continuation-less 0xff, b
	if err := validateDockerArgs([]string{"-e", "MOTD=" + illFormed}); err != nil {
		t.Fatalf("ill-formed but control-free env value rejected: %v", err)
	}
	if err := validateDockerArgs([]string{"-e", "MOTD=" + illFormed + "\x1b"}); err == nil {
		t.Fatal("ESC alongside ill-formed bytes accepted; the byte scan must not depend on decoding")
	}
}
