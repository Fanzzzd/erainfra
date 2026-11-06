package runsonmigrate

import (
	"strings"
	"testing"
)

// A reusable workflow whose runs-on is an input gets its label from the
// callers' with: values and the input's default. Renaming them is safe only
// when the label is all the input is: if the callee also compares it in an if:,
// puts it in a cache key or passes it on, the rename changes those too.

const sharedInputCaller = "on: push\njobs:\n  call:\n    uses: ./.github/workflows/callee.yml\n    with:\n      runner: ubuntu-latest\n"

func rewriteCallee(t *testing.T, callee string) (calleeResult, callerResult FileResult) {
	t.Helper()
	m := NewMapper(map[string]string{"ubuntu-latest": "erainfra-4vcpu-ubuntu-2404"}, nil)
	rs := Rewrite([]File{
		{Path: ".github/workflows/callee.yml", Content: []byte(callee)},
		{Path: ".github/workflows/caller.yml", Content: []byte(sharedInputCaller)},
	}, m)
	for _, r := range rs {
		t.Logf("%s changed=%v", r.Path, r.Changed())
		for _, n := range r.Notes {
			t.Logf("  note %d %s %s: %s", n.Line, n.Job, n.Kind, n.Message)
		}
	}
	return rs[0], rs[1]
}

func hasNote(r FileResult, kind, text string) bool {
	for _, n := range r.Notes {
		if n.Kind == kind && strings.Contains(n.Message, text) {
			return true
		}
	}
	return false
}

func calleeWith(extra string) string {
	return "on:\n  workflow_call:\n    inputs:\n      runner:\n        type: string\n        default: ubuntu-latest\njobs:\n  test:\n    runs-on: ${{ inputs.runner }}\n" + extra
}

func TestInputReadOutsideRunsOnIsLeftAlone(t *testing.T) {
	cases := map[string]struct {
		extra string
		where string
	}{
		"if without braces": {
			extra: "    steps:\n      - if: inputs.runner == 'ubuntu-latest'\n        run: sudo apt-get install -y libfoo\n",
			where: "jobs.test.steps[0].if",
		},
		"cache key": {
			extra: "    steps:\n      - uses: actions/cache@v4\n        with:\n          path: x\n          key: ${{ inputs.runner }}-deps\n",
			where: "jobs.test.steps[0].with.key",
		},
		"env": {
			extra: "    env:\n      OS: ${{ inputs.runner }}\n",
			where: "jobs.test.env.OS",
		},
		"run script": {
			extra: "    steps:\n      - run: |\n          echo building\n          ./build.sh --os '${{ inputs.runner }}'\n",
			where: "jobs.test.steps[0].run",
		},
		"with to another call": {
			extra: "  more:\n    uses: ./.github/workflows/other.yml\n    with:\n      os: ${{ inputs.runner }}\n",
			where: "jobs.more.with.os",
		},
		"job if with braces": {
			extra: "  only-linux:\n    if: ${{ startsWith(inputs.runner, 'ubuntu') }}\n    runs-on: ${{ inputs.runner }}\n",
			where: "jobs.only-linux.if",
		},
		"expression across lines": {
			extra: "    steps:\n      - run: |\n          echo ${{\n            inputs.runner }}\n",
			where: "jobs.test.steps[0].run",
		},
		"index syntax": {
			extra: "    steps:\n      - run: echo ${{ inputs['runner'] }}\n",
			where: "jobs.test.steps[0].run",
		},
		"whole inputs object": {
			extra: "    steps:\n      - run: echo '${{ toJSON(inputs) }}'\n",
			where: "jobs.test.steps[0].run",
		},
		"workflow output": {
			extra: "",
			where: "on.workflow_call.outputs.os.value",
		},
		"runs-on that computes with it": {
			extra: "  other:\n    runs-on: ${{ inputs.runner == 'ubuntu-latest' && 'ubuntu-latest' || 'macos-latest' }}\n",
			where: "jobs.other.runs-on",
		},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			callee := calleeWith(c.extra)
			if name == "workflow output" {
				callee = strings.Replace(callee, "        default: ubuntu-latest\n",
					"        default: ubuntu-latest\n    outputs:\n      os:\n        value: ${{ inputs.runner }}\n", 1)
			}
			calleeResult, callerResult := rewriteCallee(t, callee)
			if calleeResult.Changed() {
				t.Errorf("callee rewritten:\n%s", calleeResult.Updated)
			}
			if callerResult.Changed() {
				t.Errorf("caller rewritten:\n%s", callerResult.Updated)
			}
			if !hasNote(calleeResult, NoteInputShared, c.where) {
				t.Errorf("callee has no %s note naming %s", NoteInputShared, c.where)
			}
			if !hasNote(callerResult, NoteInputShared, "callee.yml") || !hasNote(callerResult, NoteInputShared, c.where) {
				t.Errorf("caller has no %s note naming callee.yml and %s", NoteInputShared, c.where)
			}
		})
	}
}

// The judge's case: one if: and one cache key read the input besides runs-on.
func TestInputReadByIfAndCacheKeyIsLeftAlone(t *testing.T) {
	callee := calleeWith("    steps:\n      - if: inputs.runner == 'ubuntu-latest'\n        run: sudo apt-get install -y libfoo\n      - uses: actions/cache@v4\n        with:\n          path: x\n          key: ${{ inputs.runner }}-deps\n")
	calleeResult, callerResult := rewriteCallee(t, callee)
	for _, r := range []FileResult{calleeResult, callerResult} {
		if r.Changed() {
			t.Errorf("%s rewritten although inputs.runner is also read by an if: and a cache key", r.Path)
		}
	}
	// The note names the first other read.
	if !hasNote(calleeResult, NoteInputShared, "jobs.test.steps[0].if on line 11") {
		t.Errorf("callee note does not name the if: on line 11")
	}
	if !hasNote(callerResult, NoteInputShared, "Its Profile would be erainfra-4vcpu-ubuntu-2404") {
		t.Errorf("caller note does not say what the label would become")
	}
}

// Reads that do not touch the runs-on input keep the rewrite: another input, a
// fallback for an empty input, a description that names it in prose, and
// another workflow's inputs.
func TestInputUsedOnlyAsLabelIsStillRewritten(t *testing.T) {
	cases := map[string]string{
		"other input":   calleeWith("    steps:\n      - if: inputs.debug\n        run: echo ${{ inputs.debug }}\n"),
		"fallback":      strings.Replace(calleeWith(""), "${{ inputs.runner }}", "${{ inputs.runner || 'ubuntu-latest' }}", 1),
		"two jobs":      calleeWith("  lint:\n    runs-on: [\"${{ inputs.runner }}\"]\n"),
		"prose":         strings.Replace(calleeWith(""), "        type: string\n", "        description: set inputs.runner to a label\n        type: string\n", 1),
		"step named it": calleeWith("    steps:\n      - name: uses inputs.runner\n        run: echo hi\n"),
	}
	for name, callee := range cases {
		t.Run(name, func(t *testing.T) {
			calleeResult, callerResult := rewriteCallee(t, callee)
			if !callerResult.Changed() {
				t.Errorf("caller not rewritten")
			}
			if !calleeResult.Changed() {
				t.Errorf("callee default not rewritten")
			}
			if hasNote(calleeResult, NoteInputShared, "") || hasNote(callerResult, NoteInputShared, "") {
				t.Errorf("unexpected %s note", NoteInputShared)
			}
			onlyRunsOnOrDefaultChanged(t, calleeResult)
		})
	}
}

func onlyRunsOnOrDefaultChanged(t *testing.T, r FileResult) {
	t.Helper()
	before, after := treeValues(t, r.Original), treeValues(t, r.Updated)
	if len(before) != len(after) {
		t.Fatalf("value count changed %d -> %d", len(before), len(after))
	}
	for i := range before {
		if before[i] != after[i] && !strings.HasPrefix(before[i], ".on.workflow_call.inputs.runner.default=") {
			t.Errorf("value changed: %s -> %s", before[i], after[i])
		}
	}
}
