package runsonmigrate

import (
	"bytes"
	"fmt"
	"path"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"

	"go.yaml.in/yaml/v3"
)

// File is one workflow file: its path relative to the repository root, with
// forward slashes, and its bytes.
type File struct {
	Path    string
	Content []byte
}

// Change is one label rewritten in place.
type Change struct {
	Line   int    `json:"line"`
	Column int    `json:"column"`
	Job    string `json:"job,omitempty"`
	// Field is where the label sits: runs-on, runs-on.labels, with.<input>,
	// on.workflow_call.inputs.<input>.default, env.<NAME> or run.
	Field string `json:"field"`
	From  string `json:"from"`
	Target
}

// Note is something the command saw and left alone, with the reason.
type Note struct {
	Line    int    `json:"line"`
	Job     string `json:"job,omitempty"`
	Kind    string `json:"kind"`
	Message string `json:"message"`
}

// Kinds of Note.
const (
	NoteMatrix       = "matrix"       // runs-on is a matrix expression
	NoteExpression   = "expression"   // runs-on is another expression
	NoteRouted       = "routed"       // runs-on is the /runs-on router's answer
	NoteRouter       = "router"       // the router job itself, which stays GitHub-hosted
	NoteInput        = "input"        // runs-on is a reusable workflow's input
	NoteInputShared  = "input-shared" // that input is also read as something other than a label
	NoteRemote       = "remote-call"  // a reusable workflow in another repository
	NoteUnknown      = "unknown"      // a label with no known equivalent
	NoteNoProfile    = "no-profile"   // a known label with no registered Profile
	NoteList         = "list"         // several labels, which no scale set matches
	NoteGroup        = "group"        // runs-on also names a runner group
	NoteAlias        = "alias"        // a YAML alias; the anchor is where to edit
	NoteUnregistered = "unregistered" // a --map target the control plane does not know
	NoteParse        = "parse"        // the file is not valid YAML
	NoteInPlace      = "in-place"     // the label could not be located byte for byte
	NoteEncoding     = "encoding"     // the file is not UTF-8
	NoteVerify       = "verify"       // the rewritten file did not read back as planned
)

// FileResult is one workflow file after the rewrite.
type FileResult struct {
	Path    string   `json:"path"`
	Changes []Change `json:"changes"`
	Notes   []Note   `json:"notes"`
	// Updated holds the new bytes; it equals Original when nothing changed.
	Original []byte `json:"-"`
	Updated  []byte `json:"-"`
}

// Changed reports whether the file's bytes differ.
func (r FileResult) Changed() bool { return !bytes.Equal(r.Original, r.Updated) }

// Rewrite plans every change across a repository's workflow files. Files are
// handled together because a reusable workflow's `runs-on` can come from an
// input that its callers, in other files, set.
func Rewrite(files []File, m *Mapper) []FileResult {
	parsed := make([]*workflow, len(files))
	callees := map[string]map[string]inputUse{}
	for i, f := range files {
		parsed[i] = parseWorkflow(f)
		if parsed[i].root != nil && parsed[i].callable {
			callees[f.Path] = parsed[i].runsOnInputs()
		}
	}
	results := make([]FileResult, len(files))
	for i, w := range parsed {
		w.rewrite(m, callees)
		results[i] = w.result()
	}
	return results
}

type edit struct {
	start, end int
	text       string
}

type workflow struct {
	file     File
	root     *yaml.Node
	lines    []int // byte offset where each line starts, as the YAML parser counts lines
	starts   []int // sorted byte offsets of every node, for the end of a block scalar
	callable bool
	changes  []Change
	notes    []Note
	edits    []edit
	mapper   *Mapper
	// inputs are this workflow's own runs-on inputs when it is callable.
	inputs map[string]inputUse
	// paths lists every path each node is read under; an anchor gives its
	// node one more path per alias.
	paths map[*yaml.Node][][]string
	// want is the value each edited node must hold after the rewrite.
	want map[*yaml.Node]string
}

const utf8BOM = "\xef\xbb\xbf"

func parseWorkflow(f File) *workflow {
	w := &workflow{file: f, want: map[*yaml.Node]string{}}
	if bytes.HasPrefix(f.Content, []byte("\xff\xfe")) || bytes.HasPrefix(f.Content, []byte("\xfe\xff")) {
		w.note(nil, "", NoteEncoding, "the file is UTF-16; left unchanged. Convert it to UTF-8 and run this again")
		return w
	}
	w.lines = lineStarts(f.Content)
	var doc yaml.Node
	if err := yaml.Unmarshal(f.Content, &doc); err != nil {
		w.note(nil, "", NoteParse, fmt.Sprintf("not valid YAML, left unchanged: %v", err))
		return w
	}
	if len(doc.Content) == 0 || doc.Content[0].Kind != yaml.MappingNode {
		return w
	}
	paths, err := occurrences(doc.Content[0])
	if err != nil {
		w.note(nil, "", NoteParse, fmt.Sprintf("left unchanged: %v", err))
		return w
	}
	w.root, w.paths = doc.Content[0], paths
	w.collectStarts(w.root)
	sort.Ints(w.starts)
	w.callable = triggers(mapGet(w.root, "on"))["workflow_call"]
	return w
}

// lineStarts finds where each line starts by the YAML parser's rules, so a
// node's line and column turn into the right byte offset: CR LF is one
// break, and a lone CR, LF, NEL (U+0085), LS (U+2028) and PS (U+2029) are
// each one, inside a comment or a quoted string too. A UTF-8 byte order
// mark comes before line 1, column 1.
func lineStarts(src []byte) []int {
	first := 0
	if bytes.HasPrefix(src, []byte(utf8BOM)) {
		first = len(utf8BOM)
	}
	lines := []int{first}
	for i := first; i < len(src); {
		n := breakWidth(src, i)
		if n == 0 {
			i++
			continue
		}
		i += n
		lines = append(lines, i)
	}
	return lines
}

// breakWidth is the length in bytes of the line break at src[i], 0 if there
// is none.
func breakWidth(src []byte, i int) int {
	switch {
	case src[i] == '\r' && i+1 < len(src) && src[i+1] == '\n':
		return 2
	case src[i] == '\r' || src[i] == '\n':
		return 1
	case src[i] == 0xC2 && i+1 < len(src) && src[i+1] == 0x85:
		return 2
	case src[i] == 0xE2 && i+2 < len(src) && src[i+1] == 0x80 && (src[i+2] == 0xA8 || src[i+2] == 0xA9):
		return 3
	}
	return 0
}

func (w *workflow) collectStarts(n *yaml.Node) {
	if n == nil {
		return
	}
	if off, ok := w.offset(n.Line, n.Column); ok {
		w.starts = append(w.starts, off)
	}
	for _, c := range n.Content {
		w.collectStarts(c)
	}
}

// triggers reads `on:` in its three forms: a scalar, a list, or a mapping.
func triggers(on *yaml.Node) map[string]bool {
	out := map[string]bool{}
	if on == nil {
		return out
	}
	switch on.Kind {
	case yaml.ScalarNode:
		out[on.Value] = true
	case yaml.SequenceNode:
		for _, c := range on.Content {
			out[c.Value] = true
		}
	case yaml.MappingNode:
		for i := 0; i+1 < len(on.Content); i += 2 {
			out[on.Content[i].Value] = true
		}
	}
	return out
}

var (
	inputReference = regexp.MustCompile(`\binputs\.([A-Za-z_][A-Za-z0-9_-]*)`)
	// wholeInputs is the inputs object read other than by one property:
	// inputs['name'], toJSON(inputs), or inputs passed on as a whole.
	wholeInputs = regexp.MustCompile(`\binputs\b(?:[^.A-Za-z0-9_-]|$)`)
	// labelInput is a runs-on expression that is the input itself, or the
	// input with a fallback for when the caller leaves it empty. In either
	// form the input's value is used as a label and nothing else.
	labelInput    = regexp.MustCompile(`^\$\{\{\s*inputs\.([A-Za-z_][A-Za-z0-9_-]*)\s*(?:\|\|\s*'[^']*'\s*)?\}\}$`)
	expressionRun = regexp.MustCompile(`(?s)\$\{\{(.*?)\}\}`)
)

// inputUse is how a callable workflow reads one input that a job's runs-on
// takes its label from.
type inputUse struct {
	// elsewhere is the first place the workflow also reads the input other
	// than as a runs-on label (an if:, an env value, a with: to another call, a
	// script, a cache key...), shown as "<path> on line N"; "" when there is none.
	// Renaming the label the callers pass would change what that place sees
	// too, so such an input is left alone.
	elsewhere string
}

// runsOnInputs names the inputs a callable workflow's jobs take runs-on from,
// and where else the workflow reads each one.
func (w *workflow) runsOnInputs() map[string]inputUse {
	out := map[string]inputUse{}
	forEachPair(mapGet(w.root, "jobs"), func(_ *yaml.Node, job *yaml.Node) {
		for _, scalar := range scalarsUnder(mapGet(job, "runs-on")) {
			for _, m := range inputReference.FindAllStringSubmatch(scalar.Value, -1) {
				out[m[1]] = inputUse{}
			}
		}
	})
	if len(out) == 0 {
		return out
	}
	type read struct {
		line int
		path string
	}
	first := map[string]read{}
	see := func(name string, r read) {
		if prev, ok := first[name]; !ok || r.line < prev.line || (r.line == prev.line && r.path < prev.path) {
			first[name] = r
		}
	}
	for n, paths := range w.paths {
		if n.Kind != yaml.ScalarNode {
			continue
		}
		for _, p := range paths {
			if isRunsOnPath(p) && labelInput.MatchString(strings.TrimSpace(n.Value)) {
				continue // the input used as the label itself
			}
			text := expressionText(p, n.Value)
			if text == "" {
				continue
			}
			r := read{n.Line, showPath(p)}
			if wholeInputs.MatchString(text) {
				for name := range out {
					see(name, r)
				}
				continue
			}
			for _, m := range inputReference.FindAllStringSubmatch(text, -1) {
				if _, ok := out[m[1]]; ok {
					see(m[1], r)
				}
			}
		}
	}
	for name, r := range first {
		out[name] = inputUse{elsewhere: fmt.Sprintf("%s on line %d", r.path, r.line)}
	}
	return out
}

// expressionText is the part of a value GitHub evaluates as an expression:
// the whole of an if:, which may leave out ${{ }}, and otherwise what is
// inside each ${{ }}.
func expressionText(path []string, value string) string {
	if len(path) > 0 && path[len(path)-1] == "if" {
		return value
	}
	var b strings.Builder
	for _, m := range expressionRun.FindAllStringSubmatch(value, -1) {
		b.WriteString(m[1])
		b.WriteByte('\n')
	}
	return b.String()
}

// sharedInputs lists the inputs among refs that the workflow also reads as
// something other than a runs-on label, with where.
func sharedInputs(inputs map[string]inputUse, refs [][]string) []string {
	var out []string
	for _, ref := range refs {
		if use, ok := inputs[ref[1]]; ok && use.elsewhere != "" {
			out = append(out, "inputs."+ref[1]+" in "+use.elsewhere)
		}
	}
	return unique(out)
}

func (w *workflow) rewrite(m *Mapper, callees map[string]map[string]inputUse) {
	w.mapper = m
	if w.root == nil {
		return
	}
	w.inputs = callees[w.file.Path]
	jobs := mapGet(w.root, "jobs")
	routers := map[string]bool{}
	forEachPair(jobs, func(key, job *yaml.Node) {
		if isRouterJob(job) {
			routers[key.Value] = true
		}
	})
	if w.callable {
		w.rewriteInputDefaults(w.inputs)
	}
	if len(routers) > 0 {
		w.rewriteEnv(mapGet(w.root, "env"), "")
	}
	forEachPair(jobs, func(key, job *yaml.Node) {
		id := key.Value
		if job.Kind != yaml.MappingNode {
			return
		}
		if routers[id] {
			w.rewriteRouter(id, job)
			return
		}
		if uses := mapGet(job, "uses"); uses != nil && uses.Kind == yaml.ScalarNode {
			w.rewriteCall(id, job, uses, callees)
		}
		if runsOn := mapGet(job, "runs-on"); runsOn != nil {
			w.rewriteRunsOn(id, job, runsOn, routers)
		}
	})
}

func (w *workflow) rewriteRunsOn(job string, jobNode, runsOn *yaml.Node, routers map[string]bool) {
	switch runsOn.Kind {
	case yaml.AliasNode:
		w.note(runsOn, job, NoteAlias, aliasNote("runs-on", runsOn))
	case yaml.ScalarNode:
		if isExpression(runsOn.Value) {
			w.noteExpression(job, jobNode, runsOn, routers)
			return
		}
		w.label(runsOn, job, "runs-on")
	case yaml.SequenceNode:
		w.labelList(runsOn, job, "runs-on", jobNode, routers)
	case yaml.MappingNode:
		labels, group := mapGet(runsOn, "labels"), mapGet(runsOn, "group")
		if labels == nil {
			if group != nil {
				w.note(runsOn, job, NoteGroup, fmt.Sprintf("runs-on names only the runner group %q; a Profile is chosen by label, so add labels: <profile> by hand", group.Value))
			}
			return
		}
		before := len(w.changes)
		switch labels.Kind {
		case yaml.ScalarNode:
			if isExpression(labels.Value) {
				w.noteExpression(job, jobNode, labels, routers)
			} else {
				w.label(labels, job, "runs-on.labels")
			}
		case yaml.SequenceNode:
			w.labelList(labels, job, "runs-on.labels", jobNode, routers)
		case yaml.AliasNode:
			w.note(labels, job, NoteAlias, aliasNote("runs-on.labels", labels))
		}
		if group != nil && len(w.changes) > before {
			w.note(group, job, NoteGroup, fmt.Sprintf("the job also asks for runner group %q; the Profile's scale set must be in that group (the controller's ERAINFRA_RUNNER_GROUP), or drop group:", group.Value))
		}
	}
}

// labelList handles a sequence. GitHub runs a job only on a runner carrying
// every label listed, and a Profile's scale set carries its own name, so the
// only list that can move is a list of one.
func (w *workflow) labelList(seq *yaml.Node, job, field string, jobNode *yaml.Node, routers map[string]bool) {
	if len(seq.Content) == 1 {
		item := seq.Content[0]
		switch {
		case item.Kind == yaml.ScalarNode && isExpression(item.Value):
			w.noteExpression(job, jobNode, item, routers)
		case item.Kind == yaml.ScalarNode:
			w.label(item, job, field)
		case item.Kind == yaml.AliasNode:
			w.note(item, job, NoteAlias, aliasNote(field, item))
		}
		return
	}
	var names, mapped []string
	for _, item := range seq.Content {
		names = append(names, item.Value)
		if item.Kind != yaml.ScalarNode || isExpression(item.Value) {
			continue
		}
		if t, _ := w.mapper.resolve(item.Value); t.Label != "" {
			mapped = append(mapped, item.Value+" -> "+t.Label)
		}
	}
	if len(seq.Content) == 0 {
		return
	}
	msg := fmt.Sprintf("%s lists %d labels (%s); a runner must carry all of them and a Profile's scale set answers to its own name, so replace the list with one Profile name by hand", field, len(names), strings.Join(names, ", "))
	if len(mapped) > 0 {
		msg += "; suggested: " + strings.Join(mapped, ", ")
	}
	w.note(seq, job, NoteList, msg)
}

// label rewrites one scalar if the Mapper has a target for it.
func (w *workflow) label(n *yaml.Node, job, field string) bool {
	t, why := w.mapper.resolve(n.Value)
	if t.Label == "" {
		switch why.kind {
		case missUnknown, missGeneric:
			w.note(n, job, NoteUnknown, why.reason+"; left unchanged. Map it with --map "+n.Value+"=<profile>")
		case missNoTarget:
			w.note(n, job, NoteNoProfile, why.reason+"; left unchanged")
		}
		return false
	}
	if !w.replaceScalar(n, job, field, n.Value, t) {
		return false
	}
	if t.Source == SourceMap && w.mapper.KnowsRegistered() && !w.mapper.Registered(t.Label) {
		w.note(n, job, NoteUnregistered, fmt.Sprintf("%s is not a Profile registered in the control plane; jobs sent to it will queue until one is", t.Label))
	}
	return true
}

func (w *workflow) replaceScalar(n *yaml.Node, job, field, from string, t Target) bool {
	if other := w.sharedWith(n); other != "" {
		w.note(n, job, NoteAlias, fmt.Sprintf("%s carries a YAML anchor that %s also reads; rewriting it would change that value too, so it is left unchanged. Give %s its own value, then run this again", field, other, field))
		return false
	}
	start, end, ok := w.scalarSpan(n)
	if !ok {
		w.note(n, job, NoteInPlace, fmt.Sprintf("could not find %q in the source to edit it in place; change it to %s by hand", from, t.Label))
		return false
	}
	w.edits = append(w.edits, edit{start, end, t.Label})
	w.want[n] = t.Label
	w.changes = append(w.changes, Change{Line: n.Line, Column: n.Column, Job: job, Field: field, From: from, Target: t})
	return true
}

// sharedWith names a path where n is also read through an anchor and its
// alias, other than a job's runs-on; "" when there is none. An anchored label
// that other jobs alias as their runs-on moves with them, which is what those
// jobs ask for. One that an env value or an input also reads would change
// that value too.
func (w *workflow) sharedWith(n *yaml.Node) string {
	for i, p := range w.paths[n] {
		if i > 0 && !isRunsOnPath(p) {
			return showPath(p)
		}
	}
	return ""
}

// wantByPath turns the value each edited node must hold into the paths the
// node is read under, for verify.
func (w *workflow) wantByPath() map[string]string {
	out := map[string]string{}
	for n, value := range w.want {
		for _, p := range w.paths[n] {
			out[firstDocument(p)] = value
		}
	}
	return out
}

func aliasNote(field string, alias *yaml.Node) string {
	if alias.Alias == nil {
		return field + " is a YAML alias; edit the anchor it points to"
	}
	return fmt.Sprintf("%s is the YAML alias *%s; it changes only with its anchor on line %d", field, alias.Value, alias.Alias.Line)
}

func (w *workflow) noteExpression(job string, jobNode, n *yaml.Node, routers map[string]bool) {
	value := strings.TrimSpace(n.Value)
	if refs := matrixReference.FindAllStringSubmatch(value, -1); refs != nil {
		matrix := mapGet(mapGet(jobNode, "strategy"), "matrix")
		var hosted []string
		for _, ref := range refs {
			for _, entry := range matrixValues(matrix, ref[1]) {
				if t, _ := w.mapper.resolve(entry); t.Label != "" {
					hosted = append(hosted, entry+" -> "+t.Label)
				}
			}
		}
		msg := fmt.Sprintf("runs-on is the matrix expression %s; left unchanged, because the matrix value may also be used outside runs-on", value)
		if len(hosted) > 0 {
			msg += "; the matrix lists " + strings.Join(unique(hosted), ", ")
		}
		w.note(n, job, NoteMatrix, msg)
		return
	}
	if m := needsOutput.FindStringSubmatch(value); m != nil && routers[m[1]] {
		w.note(n, job, NoteRouted, fmt.Sprintf("runs-on is the answer of the /runs-on router in job %q, which names the Profile at run time", m[1]))
		return
	}
	if refs := inputReference.FindAllStringSubmatch(value, -1); refs != nil && w.callable {
		if shared := sharedInputs(w.inputs, refs); len(shared) > 0 {
			w.note(n, job, NoteInputShared, fmt.Sprintf("runs-on is %s, an input of this reusable workflow that it also reads other than as a runs-on label (%s); renaming the label would change what those reads see, so its default and the calls in this repository are left unchanged. Rename them by hand where those reads allow it", value, strings.Join(shared, "; ")))
			return
		}
		w.note(n, job, NoteInput, fmt.Sprintf("runs-on is %s, an input of this reusable workflow; its default and the calls in this repository are rewritten instead", value))
		return
	}
	w.note(n, job, NoteExpression, fmt.Sprintf("runs-on is the expression %s; left unchanged", value))
}

var (
	matrixReference = regexp.MustCompile(`\bmatrix\.([A-Za-z_][A-Za-z0-9_-]*)`)
	needsOutput     = regexp.MustCompile(`\bneeds\.([A-Za-z_][A-Za-z0-9_-]*)\.outputs\.`)
)

// matrixValues lists the scalar values a matrix key takes, from its list and
// from include: entries.
func matrixValues(matrix *yaml.Node, key string) []string {
	var out []string
	if matrix == nil || matrix.Kind != yaml.MappingNode {
		return out
	}
	for _, n := range scalarsUnder(mapGet(matrix, key)) {
		out = append(out, n.Value)
	}
	if include := mapGet(matrix, "include"); include != nil && include.Kind == yaml.SequenceNode {
		for _, entry := range include.Content {
			for _, n := range scalarsUnder(mapGet(entry, key)) {
				out = append(out, n.Value)
			}
		}
	}
	return out
}

// rewriteCall follows a job that calls a reusable workflow. A local one
// (./.github/workflows/x.yml) is in this repository: the with: values it
// takes runs-on from are labels too. A remote one is another repository's.
func (w *workflow) rewriteCall(job string, jobNode, uses *yaml.Node, callees map[string]map[string]inputUse) {
	target := strings.TrimSpace(uses.Value)
	if !strings.Contains(target, ".github/workflows/") {
		return // a step action never sits at job level, but be safe
	}
	if !strings.HasPrefix(target, "./") {
		w.note(uses, job, NoteRemote, fmt.Sprintf("calls %s; that workflow's runs-on lives in its own repository, so run this command there", target))
		return
	}
	inputs := callees[path.Clean(strings.TrimPrefix(target, "./"))]
	if len(inputs) == 0 {
		return
	}
	forEachPair(mapGet(jobNode, "with"), func(key, value *yaml.Node) {
		use, ok := inputs[key.Value]
		if !ok || value.Kind != yaml.ScalarNode {
			return
		}
		if isExpression(value.Value) {
			w.note(value, job, NoteExpression, fmt.Sprintf("with.%s, the runs-on of %s, is the expression %s; left unchanged", key.Value, target, strings.TrimSpace(value.Value)))
			return
		}
		if use.elsewhere != "" {
			msg := fmt.Sprintf("with.%s is the runs-on of %s, which also reads inputs.%s other than as a runs-on label, in %s; left unchanged, because renaming the label would change what that read sees", key.Value, target, key.Value, use.elsewhere)
			if t, _ := w.mapper.resolve(value.Value); t.Label != "" {
				msg += fmt.Sprintf(". Its Profile would be %s", t.Label)
			}
			w.note(value, job, NoteInputShared, msg)
			return
		}
		w.label(value, job, "with."+key.Value)
	})
}

// rewriteInputDefaults renames the default of each runs-on input that nothing
// else in the workflow reads; noteExpression explains the ones left alone.
func (w *workflow) rewriteInputDefaults(inputs map[string]inputUse) {
	if len(inputs) == 0 {
		return
	}
	declared := mapGet(mapGet(mapGet(w.root, "on"), "workflow_call"), "inputs")
	forEachPair(declared, func(key, spec *yaml.Node) {
		if use, ok := inputs[key.Value]; !ok || use.elsewhere != "" {
			return
		}
		if def := mapGet(spec, "default"); def != nil && def.Kind == yaml.ScalarNode && !isExpression(def.Value) {
			w.label(def, "", "on.workflow_call.inputs."+key.Value+".default")
		}
	})
}

// routerCall is a request to the control plane's /runs-on endpoint: the path
// ends there, before a query, a quote, a space or the end of the script. A
// file path such as .github/runs-on.yml does not match.
var routerCall = regexp.MustCompile(`/runs-on(?:[?"'\s]|$)`)

// isRouterJob recognises the /runs-on router docs/workflows.md documents: a job that publishes
// outputs for other jobs to run on, with a step whose script calls the
// endpoint and names what it asks about (profile=, or the older labels=).
func isRouterJob(job *yaml.Node) bool {
	if outputs := mapGet(job, "outputs"); outputs == nil || outputs.Kind != yaml.MappingNode || len(outputs.Content) == 0 {
		return false
	}
	for _, step := range seqItems(mapGet(job, "steps")) {
		run := mapGet(step, "run")
		if run == nil || run.Kind != yaml.ScalarNode {
			continue
		}
		if routerCall.MatchString(run.Value) && (strings.Contains(run.Value, "profile=") || strings.Contains(run.Value, "labels=")) {
			return true
		}
	}
	return false
}

// rewriteRouter leaves the router's own runs-on alone, since it must start
// when the fleet is full, and renames the Profile it asks about: in an env
// variable whose name says PROFILE, and in a literal profile= query.
func (w *workflow) rewriteRouter(job string, jobNode *yaml.Node) {
	if runsOn := mapGet(jobNode, "runs-on"); runsOn != nil {
		w.note(runsOn, job, NoteRouter, "this is the /runs-on router job; it stays on a GitHub-hosted runner so it can answer when the fleet has no room")
	}
	w.rewriteEnv(mapGet(jobNode, "env"), job)
	for _, step := range seqItems(mapGet(jobNode, "steps")) {
		w.rewriteEnv(mapGet(step, "env"), job)
		if run := mapGet(step, "run"); run != nil && run.Kind == yaml.ScalarNode {
			w.rewriteProfileQuery(run, job)
		}
	}
}

func (w *workflow) rewriteEnv(env *yaml.Node, job string) {
	forEachPair(env, func(key, value *yaml.Node) {
		if !strings.Contains(strings.ToUpper(key.Value), "PROFILE") || value.Kind != yaml.ScalarNode || isExpression(value.Value) {
			return
		}
		t, _ := w.mapper.resolve(value.Value)
		if t.Label != "" {
			w.replaceScalar(value, job, "env."+key.Value, value.Value, t)
		}
	})
}

var profileQuery = regexp.MustCompile(`profile=([A-Za-z0-9][A-Za-z0-9._-]*)`)

// rewriteProfileQuery edits profile=<name> inside a run: script. A script is
// usually a block scalar, so the edit searches the script's own source bytes:
// from the scalar's start to the next node's.
func (w *workflow) rewriteProfileQuery(run *yaml.Node, job string) {
	start, ok := w.offset(run.Line, run.Column)
	if !ok {
		return
	}
	want := profileQuery.ReplaceAllStringFunc(run.Value, func(m string) string {
		if t, _ := w.mapper.resolve(strings.TrimPrefix(m, "profile=")); t.Label != "" {
			return "profile=" + t.Label
		}
		return m
	})
	if want == run.Value {
		return
	}
	if other := w.sharedWith(run); other != "" {
		w.note(run, job, NoteAlias, fmt.Sprintf("this run: script carries a YAML anchor that %s also reads; left unchanged, so rename the Profile in it by hand", other))
		return
	}
	w.want[run] = want
	end := len(w.file.Content)
	if i := sort.SearchInts(w.starts, start+1); i < len(w.starts) {
		end = w.starts[i]
	}
	src := w.file.Content[start:end]
	for _, m := range profileQuery.FindAllSubmatchIndex(src, -1) {
		name := string(src[m[2]:m[3]])
		t, _ := w.mapper.resolve(name)
		if t.Label == "" {
			continue
		}
		line, col := w.position(start + m[2])
		w.edits = append(w.edits, edit{start + m[2], start + m[3], t.Label})
		w.changes = append(w.changes, Change{Line: line, Column: col, Job: job, Field: "run", From: name, Target: t})
	}
}

// scalarSpan finds the bytes of a label scalar's text, inside its quotes if it
// has any. It refuses anything it cannot match exactly, so an edit can never
// land on the wrong bytes.
func (w *workflow) scalarSpan(n *yaml.Node) (int, int, bool) {
	i, ok := w.offset(n.Line, n.Column)
	if !ok {
		return 0, 0, false
	}
	src := w.file.Content
	// An anchor or a tag comes before the value.
	for i < len(src) && (src[i] == '&' || src[i] == '!') {
		for i < len(src) && src[i] != ' ' && src[i] != '\t' {
			i++
		}
		for i < len(src) && (src[i] == ' ' || src[i] == '\t') {
			i++
		}
	}
	value := []byte(n.Value)
	if i < len(src) && (src[i] == '"' || src[i] == '\'') {
		quote := src[i]
		start, end := i+1, i+1+len(value)
		if end < len(src) && bytes.Equal(src[start:end], value) && src[end] == quote {
			return start, end, true
		}
		return 0, 0, false
	}
	end := i + len(value)
	if end > len(src) || !bytes.Equal(src[i:end], value) {
		return 0, 0, false
	}
	if end < len(src) && !bytes.ContainsRune([]byte(" \t,]}#"), rune(src[end])) && breakWidth(src, end) == 0 {
		return 0, 0, false
	}
	return i, end, true
}

// offset turns the parser's line and column (1-based, counted in characters)
// into a byte offset.
func (w *workflow) offset(line, column int) (int, bool) {
	if line < 1 || line > len(w.lines) || column < 1 {
		return 0, false
	}
	i := w.lines[line-1]
	src := w.file.Content
	for c := 1; c < column; c++ {
		if i >= len(src) || breakWidth(src, i) > 0 {
			return 0, false
		}
		_, size := utf8.DecodeRune(src[i:])
		i += size
	}
	return i, true
}

func (w *workflow) position(off int) (int, int) {
	line := sort.Search(len(w.lines), func(i int) bool { return w.lines[i] > off })
	return line, utf8.RuneCount(w.file.Content[w.lines[line-1]:off]) + 1
}

func (w *workflow) note(n *yaml.Node, job, kind, message string) {
	line := 0
	if n != nil {
		line = n.Line
	}
	w.notes = append(w.notes, Note{Line: line, Job: job, Kind: kind, Message: message})
}

func (w *workflow) result() FileResult {
	out := append([]byte(nil), w.file.Content...)
	sort.Slice(w.edits, func(i, j int) bool { return w.edits[i].start > w.edits[j].start })
	last := len(out) + 1
	for _, e := range w.edits {
		if e.end > last {
			continue // overlapping: the later edit already covers it
		}
		out = append(out[:e.start], append([]byte(e.text), out[e.end:]...)...)
		last = e.start
	}
	if len(w.edits) > 0 {
		if err := verify(w.file.Content, out, w.wantByPath()); err != nil {
			w.notes = append(w.notes, Note{Kind: NoteVerify, Message: fmt.Sprintf(
				"read back, the rewritten file was not the original with only its labels renamed: %v. Nothing in this file was changed; rename its %d label(s) by hand",
				err, len(w.changes))})
			w.changes = nil
			out = append([]byte(nil), w.file.Content...)
		}
	}
	sort.SliceStable(w.changes, func(i, j int) bool {
		if w.changes[i].Line != w.changes[j].Line {
			return w.changes[i].Line < w.changes[j].Line
		}
		return w.changes[i].Column < w.changes[j].Column
	})
	sort.SliceStable(w.notes, func(i, j int) bool { return w.notes[i].Line < w.notes[j].Line })
	changes, notes := w.changes, w.notes
	if changes == nil {
		changes = []Change{}
	}
	if notes == nil {
		notes = []Note{}
	}
	return FileResult{Path: w.file.Path, Changes: changes, Notes: notes, Original: w.file.Content, Updated: out}
}

func isExpression(s string) bool { return strings.Contains(s, "${{") }

func mapGet(n *yaml.Node, key string) *yaml.Node {
	if n == nil || n.Kind != yaml.MappingNode {
		return nil
	}
	for i := 0; i+1 < len(n.Content); i += 2 {
		if n.Content[i].Value == key {
			return n.Content[i+1]
		}
	}
	return nil
}

func forEachPair(n *yaml.Node, fn func(key, value *yaml.Node)) {
	if n == nil || n.Kind != yaml.MappingNode {
		return
	}
	for i := 0; i+1 < len(n.Content); i += 2 {
		fn(n.Content[i], n.Content[i+1])
	}
}

func seqItems(n *yaml.Node) []*yaml.Node {
	if n == nil || n.Kind != yaml.SequenceNode {
		return nil
	}
	return n.Content
}

// scalarsUnder is a scalar itself, or the scalar items of a sequence.
func scalarsUnder(n *yaml.Node) []*yaml.Node {
	if n == nil {
		return nil
	}
	switch n.Kind {
	case yaml.ScalarNode:
		return []*yaml.Node{n}
	case yaml.SequenceNode:
		var out []*yaml.Node
		for _, c := range n.Content {
			if c.Kind == yaml.ScalarNode {
				out = append(out, c)
			}
		}
		return out
	case yaml.MappingNode:
		return scalarsUnder(mapGet(n, "labels"))
	}
	return nil
}

func unique(items []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range items {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}
