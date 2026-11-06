package runsonmigrate

// Inputs that try to make Rewrite produce a wrong or corrupted file: odd line
// breaks, byte order marks, other encodings, anchors, tags and quoting. Each
// case logs the before and after.

import (
	"bytes"
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"
)

func rewriteOne(t *testing.T, name string, content []byte) FileResult {
	t.Helper()
	m := NewMapper(map[string]string{"ubuntu-latest": "erainfra-4vcpu-ubuntu-2404"}, nil)
	r := Rewrite([]File{{Path: ".github/workflows/" + name, Content: content}}, m)[0]
	t.Logf("%s: changed=%v changes=%d notes=%d", name, r.Changed(), len(r.Changes), len(r.Notes))
	for _, c := range r.Changes {
		t.Logf("  change %d:%d %s %s -> %s", c.Line, c.Column, c.Job, c.From, c.Label)
	}
	for _, n := range r.Notes {
		t.Logf("  note %d %s %s: %s", n.Line, n.Job, n.Kind, n.Message)
	}
	if r.Changed() {
		t.Logf("  after:\n%q", r.Updated)
	}
	return r
}

// The rewrite must leave every non-runs-on value as it was. A strict tree diff
// (values, keyed by path, not by line:col) catches a wrong-line edit.
func treeValues(t *testing.T, b []byte) []string {
	t.Helper()
	var doc yaml.Node
	if err := yaml.Unmarshal(b, &doc); err != nil {
		t.Fatalf("does not parse: %v", err)
	}
	var out []string
	var walk func(n *yaml.Node, path string)
	walk = func(n *yaml.Node, path string) {
		switch n.Kind {
		case yaml.DocumentNode:
			for _, c := range n.Content {
				walk(c, path)
			}
		case yaml.MappingNode:
			for i := 0; i+1 < len(n.Content); i += 2 {
				walk(n.Content[i+1], path+"."+n.Content[i].Value)
			}
		case yaml.SequenceNode:
			for i, c := range n.Content {
				walk(c, path+"["+string(rune('0'+i))+"]")
			}
		case yaml.ScalarNode:
			out = append(out, path+"="+n.Value)
		case yaml.AliasNode:
			out = append(out, path+"=*"+n.Value)
		}
	}
	walk(&doc, "")
	return out
}

func onlyRunsOnChanged(t *testing.T, r FileResult) {
	t.Helper()
	before, after := treeValues(t, r.Original), treeValues(t, r.Updated)
	if len(before) != len(after) {
		t.Fatalf("value count changed %d -> %d", len(before), len(after))
	}
	for i := range before {
		if before[i] == after[i] {
			continue
		}
		if strings.Contains(before[i], ".runs-on") {
			continue
		}
		t.Errorf("non-runs-on value changed: %s  ->  %s", before[i], after[i])
	}
}

func TestRewriteAnchorSharedWithEnv(t *testing.T) {
	src := []byte(`on: push
jobs:
  a:
    runs-on: &os ubuntu-latest
    env:
      HOSTED_OS: *os
    steps: [{ run: "true" }]
`)
	r := rewriteOne(t, "anchor.yml", src)
	// Resolved view: does env.HOSTED_OS (an alias of the rewritten anchor) change?
	var doc struct {
		Jobs map[string]struct {
			Env map[string]string `yaml:"env"`
		} `yaml:"jobs"`
	}
	_ = yaml.Unmarshal(r.Updated, &doc)
	t.Logf("resolved env.HOSTED_OS after = %q", doc.Jobs["a"].Env["HOSTED_OS"])
	hasNote := false
	for _, n := range r.Notes {
		if n.Kind == NoteAlias {
			hasNote = true
		}
	}
	if doc.Jobs["a"].Env["HOSTED_OS"] != "ubuntu-latest" && !hasNote {
		t.Errorf("an alias outside runs-on silently changed value to %q with no note", doc.Jobs["a"].Env["HOSTED_OS"])
	}
}

func TestRewriteBOMSingleLineFlow(t *testing.T) {
	src := append([]byte{0xEF, 0xBB, 0xBF}, []byte(`{on: push, jobs: {a: {runs-on: ubuntu-latest, steps: [{run: "true"}]}}}`+"\n")...)
	r := rewriteOne(t, "bom.yml", src)
	if r.Changed() {
		if !bytes.HasPrefix(r.Updated, []byte{0xEF, 0xBB, 0xBF}) {
			t.Errorf("BOM lost")
		}
		onlyRunsOnChanged(t, r)
	}
}

func TestRewriteBOMBlock(t *testing.T) {
	src := append([]byte{0xEF, 0xBB, 0xBF}, []byte("on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps: [{ run: \"true\" }]\n")...)
	r := rewriteOne(t, "bom2.yml", src)
	if !r.Changed() {
		t.Errorf("BOM file not rewritten")
	}
	onlyRunsOnChanged(t, r)
}

// A stray CR (old editor, pasted text), NEL, LS or PS is a line break to the
// YAML parser, so it shifts every line number after it. The file is laid out
// so that a line table counting only '\n' lands job a's edit on job b's
// env-x-y value.
func driftCase(t *testing.T, name, breaker string) {
	src := []byte("# pasted note:" + breaker + "\non: push\njobs:\n" +
		"  a: { runs-on: ubuntu-latest, steps: [{ run: \"true\" }] }\n" +
		"  b: { env-x-y: ubuntu-latest, steps: [{ run: \"true\" }], runs-on: macos-14 }\n")
	r := rewriteOne(t, name, src)
	onlyRunsOnChanged(t, r)
	if len(r.Changes) != 2 {
		t.Errorf("%s: want both runs-on labels rewritten, got %d changes", name, len(r.Changes))
	}
}

func TestRewriteDriftStrayCR(t *testing.T) { driftCase(t, "cr.yml", "\r ") }
func TestRewriteDriftLS(t *testing.T)      { driftCase(t, "ls.yml", "\u2028") }
func TestRewriteDriftPS(t *testing.T)      { driftCase(t, "ps.yml", "\u2029") }
func TestRewriteDriftNEL(t *testing.T)     { driftCase(t, "nel.yml", "\u0085") }

// A rewrite whose bytes land anywhere but the planned labels is refused for
// the whole file, whatever the cause.
func TestVerifyRefusesAnyOtherChange(t *testing.T) {
	original := []byte("on: push\nenv:\n  HOSTED: &os ubuntu-latest\njobs:\n  a:\n    runs-on: ubuntu-latest\n    env: { ALSO: *os }\n")
	runsOn := map[string]string{firstDocument([]string{"jobs", "a", "runs-on"}): "erainfra-4vcpu-ubuntu-2404"}
	for _, c := range []struct {
		name    string
		updated string
		want    map[string]string
		ok      bool
	}{
		{"only the planned label", "on: push\nenv:\n  HOSTED: &os ubuntu-latest\njobs:\n  a:\n    runs-on: erainfra-4vcpu-ubuntu-2404\n    env: { ALSO: *os }\n", runsOn, true},
		{"another value", "on: push\nenv:\n  HOSTED: &os erainfra-4vcpu-ubuntu-2404\njobs:\n  a:\n    runs-on: ubuntu-latest\n    env: { ALSO: *os }\n", runsOn, false},
		{"both", "on: push\nenv:\n  HOSTED: &os erainfra-4vcpu-ubuntu-2404\njobs:\n  a:\n    runs-on: erainfra-4vcpu-ubuntu-2404\n    env: { ALSO: *os }\n", runsOn, false},
		{"planned label missed", string(original), runsOn, false},
		{"a structure change", "on: push\nenv:\n  HOSTED: &os ubuntu-latest\njobs:\n  a:\n    runs-on: [erainfra-4vcpu-ubuntu-2404]\n    env: { ALSO: *os }\n", runsOn, false},
		{"a type change", "on: push\nenv:\n  HOSTED: &os ubuntu-latest\njobs:\n  a:\n    runs-on: 2404\n    env: { ALSO: *os }\n", map[string]string{firstDocument([]string{"jobs", "a", "runs-on"}): "2404"}, false},
		{"a later document", string(original) + "---\nx: 1\n", runsOn, false},
		{"no longer YAML", "on: push\nenv: [\n", runsOn, false},
	} {
		err := verify(original, []byte(c.updated), c.want)
		if (err == nil) != c.ok {
			t.Errorf("%s: verify = %v, want ok=%v", c.name, err, c.ok)
		}
	}
}

func TestRewriteAnchoredRunsOnSharedByJobs(t *testing.T) {
	src := []byte("on: push\njobs:\n  a:\n    runs-on: &os ubuntu-latest\n    steps: [{ run: \"true\" }]\n  b:\n    runs-on: *os\n    steps: [{ run: \"true\" }]\n")
	r := rewriteOne(t, "shared.yml", src)
	if len(r.Changes) != 1 || bytes.Count(r.Updated, []byte("erainfra-4vcpu-ubuntu-2404")) != 1 {
		t.Fatalf("want the anchor rewritten once, got %d changes:\n%s", len(r.Changes), r.Updated)
	}
	var doc struct {
		Jobs map[string]struct {
			RunsOn string `yaml:"runs-on"`
		} `yaml:"jobs"`
	}
	if err := yaml.Unmarshal(r.Updated, &doc); err != nil {
		t.Fatal(err)
	}
	if doc.Jobs["b"].RunsOn != "erainfra-4vcpu-ubuntu-2404" {
		t.Errorf("job b, an alias of job a's runs-on, reads %q", doc.Jobs["b"].RunsOn)
	}
}

func TestRewriteRouterNeedsTheRouterForm(t *testing.T) {
	for _, c := range []struct {
		name, job string
		router    bool
	}{
		{"README form", "    outputs: { runs-on: \"${{ steps.r.outputs.runs-on }}\" }\n    steps:\n      - id: r\n        run: |\n          curl --get --data-urlencode \"profile=$PROFILE\" \"$CONTROL_PLANE/runs-on\"\n", true},
		{"literal query", "    outputs: { label: x }\n    steps:\n      - run: curl -fsS \"https://fleet.example/runs-on?profile=erainfra-4vcpu-ubuntu-2404\"\n", true},
		{"older labels form", "    outputs: { label: x }\n    steps:\n      - run: curl -fsS https://fleet.example/runs-on?labels=rc-linux\n", true},
		{"a file path", "    outputs: { label: x }\n    steps:\n      - run: cat .github/runs-on.yml profile=x\n", false},
		{"no outputs", "    steps:\n      - run: curl -fsS \"https://fleet.example/runs-on?profile=x\"\n", false},
		{"no query", "    outputs: { label: x }\n    steps:\n      - run: curl -fsS https://fleet.example/runs-on\n", false},
	} {
		src := []byte("on: push\njobs:\n  j:\n    runs-on: ubuntu-latest\n" + c.job)
		r := rewriteOne(t, c.name+".yml", src)
		if c.router == r.Changed() {
			t.Errorf("%s: router=%v, but changed=%v", c.name, c.router, r.Changed())
		}
	}
}
func TestRewriteDriftQuotedLS(t *testing.T) {
	src := []byte("on: push\nenv:\n  NOTE: \"a\u2028b\"\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps: [{ run: \"true\" }]\n")
	r := rewriteOne(t, "qls.yml", src)
	if !r.Changed() {
		t.Errorf("a U+2028 inside a string made the runs-on below it unrewritable")
	}
	onlyRunsOnChanged(t, r)
}

func TestRewriteUTF16(t *testing.T) {
	text := "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps: [{ run: \"true\" }]\n"
	src := []byte{0xFF, 0xFE}
	for _, r := range text {
		src = append(src, byte(r), 0)
	}
	r := rewriteOne(t, "utf16.yml", src)
	if r.Changed() {
		t.Errorf("UTF-16 file was edited as bytes: %q", r.Updated)
	}
}

func TestRewriteLatin1(t *testing.T) {
	src := []byte("# caf\xe9\non: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps: [{ run: \"true\" }]\n")
	r := rewriteOne(t, "latin1.yml", src)
	if r.Changed() {
		t.Logf("latin1 file edited; checking only runs-on moved")
		if !bytes.Contains(r.Updated, []byte("caf\xe9")) {
			t.Errorf("non-UTF8 byte lost")
		}
	}
}

func TestRewriteMultiDoc(t *testing.T) {
	src := []byte("on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps: [{ run: \"true\" }]\n---\njobs:\n  b:\n    runs-on: ubuntu-latest\n")
	r := rewriteOne(t, "multi.yml", src)
	t.Logf("second doc still has ubuntu-latest: %v", bytes.Count(r.Updated, []byte("ubuntu-latest")) == 1)
}

func TestRewriteTabsAndQuotedKeys(t *testing.T) {
	src := []byte("on: push\njobs:\n  a:\n    \"runs-on\":\t'ubuntu-latest'\t# c\n    steps: [{ run: \"true\" }]\n  b: {\"runs-on\":\t[\tubuntu-latest\t], steps: [{run: x}]}\n  c:\n    ? runs-on\n    : ubuntu-latest\n    steps: [{ run: \"true\" }]\n")
	r := rewriteOne(t, "tabs.yml", src)
	onlyRunsOnChanged(t, r)
	if len(r.Changes) != 3 {
		t.Errorf("want 3 changes, got %d", len(r.Changes))
	}
}

func TestRewriteBlockScalarContainingRunsOn(t *testing.T) {
	src := []byte("on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n          runs-on: ubuntu-latest\n          echo ubuntu-latest\n      - uses: some/action@v1\n        with:\n          runs-on: ubuntu-latest\n")
	r := rewriteOne(t, "block.yml", src)
	onlyRunsOnChanged(t, r)
	if bytes.Count(r.Updated, []byte("ubuntu-latest")) != 3 {
		t.Errorf("expected exactly the job runs-on to move")
	}
}

func TestRewriteTagVerbatimAndAnchorQuoted(t *testing.T) {
	src := []byte("on: push\njobs:\n  a:\n    runs-on: !<tag:yaml.org,2002:str> ubuntu-latest\n    steps: [{ run: \"true\" }]\n  b:\n    runs-on: &x !!str \"ubuntu-latest\"\n    steps: [{ run: \"true\" }]\n")
	r := rewriteOne(t, "tags.yml", src)
	onlyRunsOnChanged(t, r)
}

func TestRewriteRouterMisdetected(t *testing.T) {
	// A plain job whose script merely mentions a path containing /runs-on.
	src := []byte("on: push\njobs:\n  lint:\n    runs-on: ubuntu-latest\n    steps:\n      - run: cat .github/runs-on.yml\n")
	r := rewriteOne(t, "router.yml", src)
	if !r.Changed() {
		t.Errorf("job not rewritten: treated as the /runs-on router because its script contains '/runs-on'")
	}
}
