package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// The fixtures in testdata are upstream responses for releases newer than
// anything pinned: actions/runner 2.339.0, Node.js 22.99.0 and 24.99.1, Go
// 1.27.99, gh 2.199.0, actions/setup-node v7.2.0, pnpm/action-setup v6.2.0.
// Every checksum in them is sha256(<file name>), so a test can say which
// artifact's checksum landed where.
func fixtureSHA(name string) string { return sha256Hex([]byte(name)) }

const (
	runnerV       = "2.339.0"
	runnerDigest  = "sha256:1111111111111111111111111111111111111111111111111111111111111111"
	golangDigest  = "sha256:2222222222222222222222222222222222222222222222222222222222222222"
	setupNodeSHA  = "027d1249de242b08892673ebda9a7785eabc5c19"
	pnpmSetupSHA  = "abcd234586cc9cb50fe35fb3f73ec23428e717bb"
	oldSetupNode  = "e51e5fe84fc33b4c73ebe40526b2694712b5b858"
	oldPnpmSetup  = "0977fd99725f1db4007ccb2928dbb4e90d06cc86"
	checkoutSHA   = "3d3c42e5aac5ba805825da76410c181273ba90b1"
	nodeKeyringOK = "signature ok"
)

// golangNextDigest is the builder image of Go 1.28.1, the newer minor the
// fixture lists, which only -go-line moves to.
const golangNextDigest = "sha256:3333333333333333333333333333333333333333333333333333333333333333"

type fakeUpstream struct {
	routes  map[string][]byte
	digests map[string]string
}

func (f *fakeUpstream) get(_ context.Context, url string) ([]byte, error) {
	body, ok := f.routes[url]
	if !ok {
		return nil, fmt.Errorf("unexpected GET %s (tests never use the network)", url)
	}
	return body, nil
}

func (f *fakeUpstream) imageDigest(_ context.Context, registry, repository, tag string) (string, error) {
	d, ok := f.digests[registry+"/"+repository+":"+tag]
	if !ok {
		return "", fmt.Errorf("unexpected manifest lookup %s/%s:%s", registry, repository, tag)
	}
	return d, nil
}

func tarballBody(slug, commit string) []byte {
	return []byte("source archive of " + slug + "@" + commit)
}

func newFakeUpstream(t *testing.T) *fakeUpstream {
	t.Helper()
	read := func(name string) []byte {
		raw, err := os.ReadFile(filepath.Join("testdata", name))
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}
	f := &fakeUpstream{
		routes: map[string][]byte{
			"https://api.github.com/repos/actions/runner/releases/latest":                    read("runner-release.json"),
			"https://nodejs.org/dist/index.json":                                             read("node-index.json"),
			"https://nodejs.org/dist/v22.99.0/SHASUMS256.txt":                                read("node-v22.99.0-SHASUMS256.txt"),
			"https://nodejs.org/dist/v22.99.0/SHASUMS256.txt.sig":                            []byte(nodeKeyringOK),
			"https://nodejs.org/dist/v24.99.1/SHASUMS256.txt":                                read("node-v24.99.1-SHASUMS256.txt"),
			"https://nodejs.org/dist/v24.99.1/SHASUMS256.txt.sig":                            []byte(nodeKeyringOK),
			"https://go.dev/dl/?mode=json&include=all":                                       read("go-dl.json"),
			"https://api.github.com/repos/cli/cli/releases/latest":                           read("gh-release.json"),
			"https://github.com/cli/cli/releases/download/v2.199.0/gh_2.199.0_checksums.txt": read("gh-checksums.txt"),
			"https://api.github.com/repos/actions/setup-node/tarball/" + setupNodeSHA:        tarballBody("actions/setup-node", setupNodeSHA),
			"https://api.github.com/repos/pnpm/action-setup/tarball/" + pnpmSetupSHA:         tarballBody("pnpm/action-setup", pnpmSetupSHA),
		},
		digests: map[string]string{
			"ghcr.io/actions/actions-runner:" + runnerV: runnerDigest,
			"docker.io/library/golang:1.27.99-bookworm": golangDigest,
			"docker.io/library/golang:1.28.1-bookworm":  golangNextDigest,
		},
	}
	var actions map[string]json.RawMessage
	if err := json.Unmarshal(read("actions.json"), &actions); err != nil {
		t.Fatal(err)
	}
	for url, body := range actions {
		f.routes[url] = body
	}
	return f
}

// fakeVerify stands in for gpgv: it accepts exactly the fixture signature.
func fakeVerify(_ context.Context, _, signature []byte) error {
	if string(signature) != nodeKeyringOK {
		return errors.New("BAD signature")
	}
	return nil
}

// pinnedFiles is every file the bump may edit, copied out of this checkout so
// the tests run the location table against the real tree: a pin that moves
// to a line the table does not match fails here before it fails on a
// schedule.
func pinnedFiles(t *testing.T) []string {
	t.Helper()
	files := []string{
		dockerfilePath, smokePath, readmePath, goModPath, provisionMacPath, provisionLinuxSh,
		buildImagePath, provisionersTest, catalogPath, netprobePath,
	}
	root := repoRoot(t)
	err := filepath.WalkDir(filepath.Join(root, workflowsRoot), func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() && (strings.HasSuffix(path, ".yml") || strings.HasSuffix(path, ".yaml")) {
			rel, err := filepath.Rel(root, path)
			if err != nil {
				return err
			}
			files = append(files, filepath.ToSlash(rel))
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return files
}

func repoRoot(t *testing.T) string {
	t.Helper()
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, goModPath)); err != nil {
		t.Fatalf("repository root not found from %s: %v", root, err)
	}
	return root
}

// copyTree copies the pinned files into a fresh directory and returns it.
func copyTree(t *testing.T) string {
	t.Helper()
	src, dst := repoRoot(t), t.TempDir()
	for _, rel := range pinnedFiles(t) {
		raw, err := os.ReadFile(filepath.Join(src, filepath.FromSlash(rel)))
		if err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(dst, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, raw, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dst
}

func bumpTree(t *testing.T, dir string, up upstream, verify func(context.Context, []byte, []byte) error, only ...string) result {
	t.Helper()
	b := &bumper{up: up, tree: newTree(dir), verifyNode: verify, cache: map[string][]byte{}}
	sel := map[string]bool{}
	for _, g := range only {
		sel[g] = true
	}
	res := run(context.Background(), b, sel, nil)
	if err := b.tree.flush(); err != nil {
		t.Fatal(err)
	}
	return res
}

// bumpGoLine runs only the Go target, as `-only go -go-line <line>` does.
func bumpGoLine(t *testing.T, dir, line string) result {
	t.Helper()
	b := &bumper{up: newFakeUpstream(t), tree: newTree(dir), verifyNode: fakeVerify, cache: map[string][]byte{}, goLine: line}
	res := run(context.Background(), b, map[string]bool{"go": true}, nil)
	if err := b.tree.flush(); err != nil {
		t.Fatal(err)
	}
	return res
}

func readFile(t *testing.T, dir, rel string) string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(rel)))
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func mustContain(t *testing.T, dir, rel string, wants ...string) {
	t.Helper()
	content := readFile(t, dir, rel)
	for _, want := range wants {
		if !strings.Contains(content, want) {
			t.Errorf("%s does not contain %q", rel, want)
		}
	}
}

func TestBumpsEveryPinInTheRealTree(t *testing.T) {
	dir := copyTree(t)
	before := map[string]string{}
	for _, rel := range pinnedFiles(t) {
		before[rel] = readFile(t, dir, rel)
	}
	oldRunner, _ := argValue(before[dockerfilePath], "RUNNER_VERSION")
	oldNode, _ := argValue(before[dockerfilePath], "NODE_VERSION")
	oldNode24, _ := argValue(before[dockerfilePath], "NODE_24_VERSION")
	oldGo, _ := argValue(before[dockerfilePath], "GO_VERSION")
	oldGH, _ := argValue(before[dockerfilePath], "GH_VERSION")

	res := bumpTree(t, dir, newFakeUpstream(t), fakeVerify)
	if len(res.failed) > 0 {
		t.Fatalf("failures: %v", res.failed)
	}

	// actions/runner: every platform's checksum lands where that platform is
	// installed, and the Docker executor's image is pinned by digest.
	runnerAsset := func(platform, ext string) string {
		return fixtureSHA("actions-runner-" + platform + "-" + runnerV + ext)
	}
	mustContain(t, dir, dockerfilePath,
		"ARG RUNNER_VERSION="+runnerV,
		"runner_arch=x64; runner_sha="+runnerAsset("linux-x64", ".tar.gz"),
		"runner_arch=arm64; runner_sha="+runnerAsset("linux-arm64", ".tar.gz"))
	mustContain(t, dir, provisionMacPath,
		`RC_RUNNER_VERSION_DEFAULT="`+runnerV+`"`,
		`RC_RUNNER_SHA256_DEFAULT="`+runnerAsset("osx-arm64", ".tar.gz")+`"`,
		"releases/tag/v"+runnerV+" ")
	mustContain(t, dir, buildImagePath,
		"$RunnerVersion = '"+runnerV+"'",
		"$RunnerSha256 = '"+runnerAsset("win-x64", ".zip")+"'")
	mustContain(t, dir, provisionersTest,
		`PINNED_RUNNER_VERSION = "`+runnerV+`"`,
		`PINNED_RUNNER_SHA256 = "`+runnerAsset("win-x64", ".zip")+`"`)
	image := "ghcr.io/actions/actions-runner:" + runnerV + "@" + runnerDigest
	mustContain(t, dir, provisionLinuxSh, image)
	mustContain(t, dir, catalogPath, image)
	mustContain(t, dir, netprobePath, "download/v"+runnerV+"/actions-runner-linux-x64-"+runnerV+".tar.gz")

	// Node.js: each pin follows its own major's newest LTS patch, never the
	// Current line above it.
	mustContain(t, dir, dockerfilePath,
		"ARG NODE_VERSION=22.99.0",
		"node_arch=x64; node_sha="+fixtureSHA("node-v22.99.0-linux-x64.tar.xz"),
		"node_arch=arm64; node_sha="+fixtureSHA("node-v22.99.0-linux-arm64.tar.xz"))
	mustContain(t, dir, smokePath, "'v22.99.0'")
	// The tool-cache Node 24 shares its block's variable name (node_sha) with
	// the default Node, so its edit has to find the block by its ARG.
	mustContain(t, dir, dockerfilePath,
		"ARG NODE_24_VERSION=24.99.1",
		"node_arch=x64; node_sha="+fixtureSHA("node-v24.99.1-linux-x64.tar.xz"),
		"node_arch=arm64; node_sha="+fixtureSHA("node-v24.99.1-linux-arm64.tar.xz"))
	mustContain(t, dir, smokePath, "/node/24.99.1/", "'v24.99.1'")
	mustContain(t, dir, buildImagePath,
		"$NodeVersion = '24.99.1'",
		"$NodeSha256 = '"+fixtureSHA("node-v24.99.1-x64.msi")+"'")
	mustContain(t, dir, provisionersTest,
		`PINNED_NODE_VERSION = "24.99.1"`,
		`PINNED_NODE_SHA256 = "`+fixtureSHA("node-v24.99.1-x64.msi")+`"`)

	// Go: the newest patch of go.mod's minor, in go.mod, the builder stage
	// and the tool cache together; the newer minor is reported, not taken.
	mustContain(t, dir, goModPath, "\ngo 1.27.99\n")
	mustContain(t, dir, dockerfilePath,
		"FROM docker.io/library/golang:1.27.99-bookworm@"+golangDigest+" AS guest",
		"ARG GO_VERSION=1.27.99",
		"go_dist=amd64; go_sha="+fixtureSHA("go1.27.99.linux-amd64.tar.gz"),
		"go_dist=arm64; go_sha="+fixtureSHA("go1.27.99.linux-arm64.tar.gz"))
	mustContain(t, dir, smokePath, `go1\.27\.99 `, "/opt/hostedtoolcache/go/1.27.99/")

	// gh.
	mustContain(t, dir, dockerfilePath,
		"ARG GH_VERSION=2.199.0",
		"gh_arch=amd64; gh_sha="+fixtureSHA("gh_2.199.0_linux_amd64.tar.gz"),
		"gh_arch=arm64; gh_sha="+fixtureSHA("gh_2.199.0_linux_arm64.tar.gz"))
	mustContain(t, dir, smokePath, `2\.199\.0( |$)`)

	// The seeded Actions move in the workflows and the image's archive cache
	// in one edit, with the archive's measured checksum beside its path.
	mustContain(t, dir, ".github/workflows/ci.yml",
		"actions/setup-node@"+setupNodeSHA+" # v7.2.0",
		"pnpm/action-setup@"+pnpmSetupSHA+" # v6.2.0",
		"actions/checkout@"+checkoutSHA+" # v7.0.1")
	df := readFile(t, dir, dockerfilePath)
	for slug, commit := range map[string]string{"actions/setup-node": setupNodeSHA, "pnpm/action-setup": pnpmSetupSHA} {
		cacheDir := strings.Replace(slug, "/", "_", 1)
		pair := regexp.MustCompile(sha256Hex(tarballBody(slug, commit)) + ` \\\n\s*/opt/action-cache/` + cacheDir + `/` + commit + `\.tar\.gz`)
		if !pair.MatchString(df) {
			t.Errorf("the Dockerfile does not pair %s@%s with its archive checksum", slug, commit)
		}
		if !strings.Contains(df, "/tarball/"+commit) {
			t.Errorf("the Dockerfile still downloads the old %s archive", slug)
		}
	}
	mustContain(t, dir, smokePath, "/actions_setup-node/"+setupNodeSHA+".tar.gz")

	// Nothing old is left where it was pinned.
	for rel, old := range map[string][]string{
		dockerfilePath:   {"ARG NODE_24_VERSION=" + oldNode24, oldRunner, oldNode, oldGo, oldGH, oldSetupNode, oldPnpmSetup},
		smokePath:        {oldNode, oldNode24, oldGo, strings.ReplaceAll(oldGo, ".", `\.`), strings.ReplaceAll(oldGH, ".", `\.`), oldSetupNode},
		readmePath:       {oldNode, oldNode24, oldGH},
		provisionMacPath: {oldRunner},
		catalogPath:      {"actions-runner:" + oldRunner},
		goModPath:        {"go " + oldGo},
	} {
		content := readFile(t, dir, rel)
		for _, o := range old {
			if _, n := replaceStandalone(content, o, "x"); n > 0 {
				t.Errorf("%s still carries %s", rel, o)
			}
		}
	}

	notes := strings.Join(res.notes, "\n")
	for _, want := range []string{"Go 1.28.1 is out", "-go-line 1.28", "actions/checkout v8.0.0 is out", "Payable's workflows"} {
		if !strings.Contains(notes, want) {
			t.Errorf("notes miss %q:\n%s", want, notes)
		}
	}

	// A second run against the same upstream finds nothing to do.
	again := bumpTree(t, dir, newFakeUpstream(t), fakeVerify)
	if len(again.failed) > 0 || len(again.files) > 0 || len(again.changes) > 0 {
		t.Fatalf("second run was not a no-op: changes=%v files=%v failed=%v", again.changes, again.files, again.failed)
	}
}

func TestRunnerChecksumsMustAgreeWithTheReleaseBody(t *testing.T) {
	up := newFakeUpstream(t)
	arm := fixtureSHA("actions-runner-linux-arm64-" + runnerV + ".tar.gz")
	up.routes["https://api.github.com/repos/actions/runner/releases/latest"] = []byte(
		strings.Replace(string(up.routes["https://api.github.com/repos/actions/runner/releases/latest"]),
			"BEGIN SHA linux-arm64 -->"+arm, "BEGIN SHA linux-arm64 -->"+strings.Repeat("0", 64), 1))
	dir := copyTree(t)
	before := readFile(t, dir, dockerfilePath)

	res := bumpTree(t, dir, up, fakeVerify, "runner", "gh")

	if len(res.failed) != 1 || !strings.Contains(res.failed[0], "disagrees with the release body") {
		t.Fatalf("want one runner failure about the release body, got %v", res.failed)
	}
	after := readFile(t, dir, dockerfilePath)
	if v, _ := argValue(after, "RUNNER_VERSION"); v == runnerV {
		t.Error("the runner moved although its checksums disagree")
	}
	// The failure is the runner's alone; gh still moves.
	if v, _ := argValue(after, "GH_VERSION"); v != "2.199.0" {
		t.Errorf("gh did not move after an unrelated failure (GH_VERSION=%s)", v)
	}
	if strings.Count(before, "runner_sha=") != strings.Count(after, "runner_sha=") {
		t.Error("the runner block was rewritten")
	}
}

func TestABadNodeSignatureLeavesNodeAlone(t *testing.T) {
	up := newFakeUpstream(t)
	up.routes["https://nodejs.org/dist/v22.99.0/SHASUMS256.txt.sig"] = []byte("forged")
	dir := copyTree(t)
	oldNode, _ := argValue(readFile(t, dir, dockerfilePath), "NODE_VERSION")

	res := bumpTree(t, dir, up, fakeVerify, "node")

	if len(res.failed) != 1 || !strings.Contains(res.failed[0], "BAD signature") {
		t.Fatalf("want one signature failure, got %v", res.failed)
	}
	if v, _ := argValue(readFile(t, dir, dockerfilePath), "NODE_VERSION"); v != oldNode {
		t.Errorf("NODE_VERSION moved to %s on a bad signature", v)
	}
	// The Windows pin is on 24, whose SHASUMS256.txt verified, so it moves.
	mustContain(t, dir, buildImagePath, "$NodeVersion = '24.99.1'")
}

// The tool-cache Node 24 is optional: a tree without it is reported, not
// failed, so the bump keeps working on a branch from before it existed.
func TestAMissingNode24PinIsANoteNotAFailure(t *testing.T) {
	dir := copyTree(t)
	df := regexp.MustCompile(`(?m)^ARG NODE_24_VERSION=\S+\n`).ReplaceAllString(readFile(t, dir, dockerfilePath), "")
	if err := os.WriteFile(filepath.Join(dir, dockerfilePath), []byte(df), 0o644); err != nil {
		t.Fatal(err)
	}

	res := bumpTree(t, dir, newFakeUpstream(t), fakeVerify, "node")

	if len(res.failed) > 0 {
		t.Fatalf("failures: %v", res.failed)
	}
	if !strings.Contains(strings.Join(res.notes, "\n"), "Node.js 24 (image tool cache): not pinned in this tree") {
		t.Errorf("notes: %v", res.notes)
	}
	if v, _ := argValue(readFile(t, dir, dockerfilePath), "NODE_VERSION"); v != "22.99.0" {
		t.Errorf("NODE_VERSION=%s, want 22.99.0", v)
	}
}

func TestRefusesToDowngrade(t *testing.T) {
	up := newFakeUpstream(t)
	url := "https://api.github.com/repos/cli/cli/releases/latest"
	up.routes[url] = []byte(strings.ReplaceAll(string(up.routes[url]), "2.199.0", "2.1.0"))
	dir := copyTree(t)

	res := bumpTree(t, dir, up, fakeVerify, "gh")

	if len(res.failed) != 1 || !strings.Contains(res.failed[0], "refusing to downgrade") {
		t.Fatalf("want a downgrade refusal, got %v", res.failed)
	}
	if len(res.files) != 0 {
		t.Errorf("a refused downgrade changed %v", res.files)
	}
}

func TestGoModAndTheImageMustAgree(t *testing.T) {
	dir := copyTree(t)
	mod := regexp.MustCompile(`(?m)^go \S+$`).ReplaceAllString(readFile(t, dir, goModPath), "go 1.25.1")
	if err := os.WriteFile(filepath.Join(dir, goModPath), []byte(mod), 0o644); err != nil {
		t.Fatal(err)
	}
	res := bumpTree(t, dir, newFakeUpstream(t), fakeVerify, "go")
	if len(res.failed) != 1 || !strings.Contains(res.failed[0], "meant to be one version") {
		t.Fatalf("want a go.mod/image disagreement, got %v", res.failed)
	}
}

func TestGoLineMovesEveryGoPinToTheNewMinor(t *testing.T) {
	dir := copyTree(t)
	oldGo, _ := argValue(readFile(t, dir, dockerfilePath), "GO_VERSION")

	res := bumpGoLine(t, dir, "1.28")

	if len(res.failed) > 0 {
		t.Fatalf("failures: %v", res.failed)
	}
	mustContain(t, dir, goModPath, "\ngo 1.28.1\n")
	mustContain(t, dir, dockerfilePath,
		"FROM docker.io/library/golang:1.28.1-bookworm@"+golangNextDigest+" AS guest",
		"ARG GO_VERSION=1.28.1",
		"go_dist=amd64; go_sha="+fixtureSHA("go1.28.1.linux-amd64.tar.gz"),
		"go_dist=arm64; go_sha="+fixtureSHA("go1.28.1.linux-arm64.tar.gz"))
	mustContain(t, dir, smokePath, `go1\.28\.1 `, "/opt/hostedtoolcache/go/1.28.1/")
	mustContain(t, dir, readmePath, "Go 1.28.1")
	for _, rel := range []string{dockerfilePath, smokePath, readmePath, goModPath} {
		if _, n := replaceStandalone(readFile(t, dir, rel), oldGo, "x"); n > 0 {
			t.Errorf("%s still carries Go %s", rel, oldGo)
		}
	}
	// On the newest minor there is nothing newer to report.
	if notes := strings.Join(res.notes, "\n"); strings.Contains(notes, "is out") {
		t.Errorf("unexpected note after moving to the newest minor:\n%s", notes)
	}
}

func TestGoLineRefusesALineGoNoLongerSupports(t *testing.T) {
	dir := copyTree(t)
	// The fixture's newest stable minor is 1.28 (1.29rc1 does not count), so
	// 1.27 and 1.28 are supported and 1.26 is not, although go.dev lists it.
	for line, want := range map[string]string{
		"1.26":   "no longer supported",
		"1.28.1": "not a MAJOR.MINOR Go line",
		"1.30":   "no stable Go 1.30 release",
	} {
		res := bumpGoLine(t, dir, line)
		if len(res.failed) != 1 || !strings.Contains(res.failed[0], want) {
			t.Errorf("-go-line %s: want a failure mentioning %q, got %v", line, want, res.failed)
		}
		if len(res.files) != 0 {
			t.Errorf("-go-line %s changed %v", line, res.files)
		}
	}
}

func TestReplaceStandaloneLeavesLongerVersionsAlone(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{"Go 1.25.3+", "Go 1.25.9+"},
		{"go1.25.3 ", "go1.25.9 "},
		{"v1.25.3.", "v1.25.9."},
		{"11.25.3", "11.25.3"},
		{"1.25.30", "1.25.30"},
		{"1.25.3.1", "1.25.3.1"},
		{"/go/1.25.3/x 1.25.3", "/go/1.25.9/x 1.25.9"},
	} {
		if got, _ := replaceStandalone(tc.in, "1.25.3", "1.25.9"); got != tc.want {
			t.Errorf("replaceStandalone(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
	if got, _ := replaceStandalone(`go1\.25\.3\.1 go1\.25\.3 `, `1\.25\.3`, `1\.25\.9`); got != `go1\.25\.3\.1 go1\.25\.9 ` {
		t.Errorf("escaped form: got %q", got)
	}
}

func TestSetArchSHAsWantsExactlyOneBlock(t *testing.T) {
	block := "RUN case x in \\\n  amd64) a_sha=" + strings.Repeat("a", 64) + " ;; \\\n  arm64) a_sha=" + strings.Repeat("b", 64) + " ;; \\\n  esac && curl ${V}\n"
	if _, err := setArchSHAs(block+block, "V", "a_sha", map[string]string{"amd64": strings.Repeat("c", 64)}); err == nil {
		t.Error("two blocks using ${V} were accepted")
	}
	if _, err := setArchSHAs(block, "W", "a_sha", map[string]string{"amd64": strings.Repeat("c", 64)}); err == nil {
		t.Error("no block using ${W} was accepted")
	}
	out, err := setArchSHAs(block, "V", "a_sha", map[string]string{"amd64": strings.Repeat("c", 64), "arm64": strings.Repeat("d", 64)})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "amd64) a_sha="+strings.Repeat("c", 64)) || !strings.Contains(out, "arm64) a_sha="+strings.Repeat("d", 64)) {
		t.Errorf("checksums not rewritten:\n%s", out)
	}
}

func TestUnknownGroupIsAUsageError(t *testing.T) {
	var stderr strings.Builder
	if code := realMain([]string{"-only", "python"}, &strings.Builder{}, &stderr); code != 2 {
		t.Fatalf("exit %d, want 2", code)
	}
	if !strings.Contains(stderr.String(), "unknown group") {
		t.Errorf("stderr: %s", stderr.String())
	}
}
