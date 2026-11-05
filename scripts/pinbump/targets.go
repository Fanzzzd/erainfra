package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

// Every file a pin lives in. A pin added somewhere else has to be added here
// too, and the real-tree test fails until it is.
const (
	dockerfilePath    = "images/ubuntu-24.04-js/Dockerfile"
	smokePath         = "images/ubuntu-24.04-js/smoke.sh"
	readmePath        = "README.md"
	goModPath         = "go.mod"
	provisionMacPath  = "apps/action-runner-agent/provisioners/provision-mac.sh"
	provisionLinuxSh  = "apps/action-runner-agent/provisioners/provision-linux.sh"
	buildImagePath    = "apps/action-runner-agent/provisioners/build-image.ps1"
	provisionersTest  = "apps/action-runner-agent/tests/provisioners.test.ts"
	catalogPath       = "packages/backend/convex/catalog.ts"
	netprobePath      = ".github/bench/netprobe.sh"
	workflowsRoot     = ".github"
	runnerImageRepo   = "actions/actions-runner"
	golangImageRepo   = "library/golang"
	golangImageSuffix = "-bookworm"
)

// pinChange is one pin that moved, for the pull request body.
type pinChange struct {
	pin, from, to, source string
}

type outcome struct {
	changes []pinChange
	notes   []string
}

func (o *outcome) moved(pin, from, to, source string) {
	if from != to {
		o.changes = append(o.changes, pinChange{pin, from, to, source})
	}
}

func (o *outcome) note(format string, args ...any) {
	o.notes = append(o.notes, fmt.Sprintf(format, args...))
}

type bumper struct {
	up   upstream
	tree *tree
	// verifyNode checks SHASUMS256.txt against its detached signature.
	verifyNode func(ctx context.Context, data, signature []byte) error
	cache      map[string][]byte
}

func (b *bumper) fetch(ctx context.Context, url string) ([]byte, error) {
	if raw, ok := b.cache[url]; ok {
		return raw, nil
	}
	raw, err := b.up.get(ctx, url)
	if err != nil {
		return nil, err
	}
	b.cache[url] = raw
	return raw, nil
}

func (b *bumper) fetchJSON(ctx context.Context, url string, v any) error {
	raw, err := b.fetch(ctx, url)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(raw, v); err != nil {
		return fmt.Errorf("%s: %w", url, err)
	}
	return nil
}

var (
	hex64 = regexp.MustCompile(`^[0-9a-f]{64}$`)
	hex40 = regexp.MustCompile(`^[0-9a-f]{40}$`)
)

type githubRelease struct {
	TagName    string `json:"tag_name"`
	Draft      bool   `json:"draft"`
	Prerelease bool   `json:"prerelease"`
	Body       string `json:"body"`
	Assets     []struct {
		Name   string `json:"name"`
		Digest string `json:"digest"`
		URL    string `json:"browser_download_url"`
	} `json:"assets"`
}

func (r *githubRelease) assetDigest(name string) (digest string, found bool) {
	for _, a := range r.Assets {
		if a.Name == name {
			return strings.TrimPrefix(a.Digest, "sha256:"), true
		}
	}
	return "", false
}

func (b *bumper) latestRelease(ctx context.Context, repo string) (*githubRelease, string, error) {
	var rel githubRelease
	if err := b.fetchJSON(ctx, "https://api.github.com/repos/"+repo+"/releases/latest", &rel); err != nil {
		return nil, "", err
	}
	if rel.Draft || rel.Prerelease {
		return nil, "", fmt.Errorf("%s: releases/latest returned a draft or pre-release (%s)", repo, rel.TagName)
	}
	v := strings.TrimPrefix(rel.TagName, "v")
	if _, err := parseVersion(v); err != nil {
		return nil, "", fmt.Errorf("%s: latest tag %q: %w", repo, rel.TagName, err)
	}
	return &rel, v, nil
}

func (b *bumper) dockerfileArg(name string) (string, bool, error) {
	df, err := b.tree.read(dockerfilePath)
	if err != nil {
		return "", false, err
	}
	v, ok := argValue(df, name)
	return v, ok, nil
}

func (b *bumper) setDockerfileArg(name, value string) error {
	return b.tree.replaceOne(dockerfilePath,
		regexp.MustCompile(`(?m)^(ARG `+regexp.QuoteMeta(name)+`=)\S+$`), "${1}"+value)
}

func (b *bumper) setArchSHAs(arg, shaVar string, byArch map[string]string) error {
	df, err := b.tree.read(dockerfilePath)
	if err != nil {
		return err
	}
	out, err := setArchSHAs(df, arg, shaVar, byArch)
	if err != nil {
		return fmt.Errorf("%s: %w", dockerfilePath, err)
	}
	b.tree.write(dockerfilePath, out)
	return nil
}

// --- actions/runner ---------------------------------------------------------

// runnerPlatforms are the release assets something in this repository
// installs: the image (both Linux architectures), Tart and Hyper-V.
var runnerPlatforms = []string{"linux-x64", "linux-arm64", "osx-arm64", "win-x64"}

// bumpRunner moves actions/runner everywhere it is pinned. GitHub stops
// queueing jobs to a runner that has not taken a release within 30 days of it
// being published, and every Runner here registers with auto-update disabled,
// so this pin is the one with a deadline.
func (b *bumper) bumpRunner(ctx context.Context) (*outcome, error) {
	cur, ok, err := b.dockerfileArg("RUNNER_VERSION")
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, fmt.Errorf("%s declares no ARG RUNNER_VERSION", dockerfilePath)
	}
	rel, v, err := b.latestRelease(ctx, "actions/runner")
	if err != nil {
		return nil, err
	}
	if err := checkNotOlder("actions/runner", cur, v); err != nil {
		return nil, err
	}

	// Two independent statements of each checksum: the digest GitHub computed
	// for the uploaded asset, and the table the runner's release pipeline
	// writes into the release body. They must agree.
	sha := map[string]string{}
	for _, platform := range runnerPlatforms {
		ext := ".tar.gz"
		if strings.HasPrefix(platform, "win-") {
			ext = ".zip"
		}
		name := fmt.Sprintf("actions-runner-%s-%s%s", platform, v, ext)
		digest, found := rel.assetDigest(name)
		if !found {
			return nil, fmt.Errorf("actions/runner v%s has no asset %s", v, name)
		}
		if !hex64.MatchString(digest) {
			return nil, fmt.Errorf("actions/runner v%s: asset %s carries no sha256 digest", v, name)
		}
		table := regexp.MustCompile(`<!-- BEGIN SHA ` + regexp.QuoteMeta(platform) + ` -->([0-9a-f]{64})<!-- END SHA ` + regexp.QuoteMeta(platform) + ` -->`).FindStringSubmatch(rel.Body)
		if table == nil {
			return nil, fmt.Errorf("actions/runner v%s: the release body lists no SHA-256 for %s", v, platform)
		}
		if table[1] != digest {
			return nil, fmt.Errorf("actions/runner v%s: %s asset digest %s disagrees with the release body's %s", v, platform, digest, table[1])
		}
		sha[platform] = digest
	}
	imageDigest, err := b.up.imageDigest(ctx, "ghcr.io", runnerImageRepo, v)
	if err != nil {
		return nil, err
	}
	imageRef := "ghcr.io/" + runnerImageRepo + ":" + v + "@" + imageDigest
	catalog, err := b.tree.read(catalogPath)
	if err != nil {
		return nil, err
	}
	priorRef := runnerImagePattern.FindString(catalog)

	t := b.tree
	steps := []func() error{
		func() error { return b.setDockerfileArg("RUNNER_VERSION", v) },
		func() error {
			return b.setArchSHAs("RUNNER_VERSION", "runner_sha", map[string]string{"amd64": sha["linux-x64"], "arm64": sha["linux-arm64"]})
		},
		func() error {
			return t.replaceOne(provisionMacPath, regexp.MustCompile(`(?m)^(RC_RUNNER_VERSION_DEFAULT=")[^"]+(")$`), "${1}"+v+"${2}")
		},
		func() error {
			return t.replaceOne(provisionMacPath, regexp.MustCompile(`(?m)^(RC_RUNNER_SHA256_DEFAULT=")[0-9a-f]{64}(")$`), "${1}"+sha["osx-arm64"]+"${2}")
		},
		func() error {
			return t.replaceOne(provisionMacPath, regexp.MustCompile(`(https://github\.com/actions/runner/releases/tag/v)[0-9.]+`), "${1}"+v)
		},
		func() error {
			return t.replaceOne(buildImagePath, regexp.MustCompile(`(\[string\] \$RunnerVersion = ')[^']+(')`), "${1}"+v+"${2}")
		},
		func() error {
			return t.replaceOne(buildImagePath, regexp.MustCompile(`(\[string\] \$RunnerSha256 = ')[0-9a-fA-F]{64}(')`), "${1}"+sha["win-x64"]+"${2}")
		},
		func() error {
			return t.replaceOne(provisionersTest, regexp.MustCompile(`(const PINNED_RUNNER_VERSION = ")[^"]+(")`), "${1}"+v+"${2}")
		},
		func() error {
			return t.replaceOne(provisionersTest, regexp.MustCompile(`(const PINNED_RUNNER_SHA256 = ")[0-9a-f]{64}(")`), "${1}"+sha["win-x64"]+"${2}")
		},
		// The Docker executor's image, by tag for the reader and by digest
		// for Docker: a tag on ghcr.io can be re-pushed.
		func() error { return t.replaceOne(provisionLinuxSh, runnerImagePattern, imageRef) },
		func() error { return t.replaceOne(catalogPath, runnerImagePattern, imageRef) },
		func() error {
			return t.replaceOne(netprobePath, regexp.MustCompile(`(actions/runner/releases/download/v)[0-9.]+(/actions-runner-linux-x64-)[0-9.]+(\.tar\.gz)`), "${1}"+v+"${2}"+v+"${3}")
		},
		func() error { return t.replaceToken(readmePath, cur, v, 0) },
	}
	if err := runAll(steps); err != nil {
		return nil, err
	}
	o := &outcome{}
	o.moved("actions/runner", cur, v, "release asset digest, cross-checked against the release body's SHA-256 table")
	o.moved("ghcr.io/actions/actions-runner", strings.TrimPrefix(priorRef, "ghcr.io/"+runnerImageRepo+":"), v+"@"+imageDigest, "ghcr.io manifest digest")
	return o, nil
}

var runnerImagePattern = regexp.MustCompile(`ghcr\.io/actions/actions-runner:[0-9][0-9.]*(@sha256:[0-9a-f]{64})?`)

func runAll(steps []func() error) error {
	for _, step := range steps {
		if err := step(); err != nil {
			return err
		}
	}
	return nil
}

// --- Node.js ----------------------------------------------------------------

// nodePin is one place a Node.js version is pinned. Each follows the newest
// LTS patch release of the major it is already on; moving a major is a
// decision about compatibility, not a pin bump.
type nodePin struct {
	name     string
	file     string
	label    string         // how the pin reads in the file, for messages
	pattern  *regexp.Regexp // group 1 is the version
	optional bool           // a pin that may not exist in this tree
	// onMove is added to the pull request when this pin moves.
	onMove string
	// artifacts maps a key apply understands to the SHASUMS256.txt file name,
	// with %s standing for the version.
	artifacts map[string]string
	apply     func(b *bumper, old, new string, sums map[string]string) error
}

var nodePins = []nodePin{
	{
		name:      "Node.js (image default)",
		file:      dockerfilePath,
		label:     "ARG NODE_VERSION",
		pattern:   regexp.MustCompile(`(?m)^ARG NODE_VERSION=(\S+)$`),
		artifacts: map[string]string{"amd64": "node-v%s-linux-x64.tar.xz", "arm64": "node-v%s-linux-arm64.tar.xz"},
		apply:     imageNodeApply("NODE_VERSION"),
	},
	{
		// The second, tool-cache-only Node of images/ubuntu-24.04-js. Not every
		// tree carries it, so its absence is a note rather than a failure.
		name:     "Node.js 24 (image tool cache)",
		file:     dockerfilePath,
		label:    "ARG NODE_24_VERSION",
		pattern:  regexp.MustCompile(`(?m)^ARG NODE_24_VERSION=(\S+)$`),
		optional: true,
		onMove: "setup-node takes a version from the tool cache only on an exact match, and this Node exists " +
			"for consumers that pin Node 24 exactly (Payable's workflows do). Move their node-version to the " +
			"same release when this merges, or their jobs download Node again.",
		artifacts: map[string]string{"amd64": "node-v%s-linux-x64.tar.xz", "arm64": "node-v%s-linux-arm64.tar.xz"},
		apply:     imageNodeApply("NODE_24_VERSION"),
	},
	{
		name:      "Node.js (Windows image builder)",
		file:      buildImagePath,
		label:     "$NodeVersion",
		pattern:   regexp.MustCompile(`\[string\] \$NodeVersion = '([^']+)'`),
		artifacts: map[string]string{"msi": "node-v%s-x64.msi"},
		apply: func(b *bumper, _, v string, sums map[string]string) error {
			t := b.tree
			return runAll([]func() error{
				func() error {
					return t.replaceOne(buildImagePath, regexp.MustCompile(`(\[string\] \$NodeVersion = ')[^']+(')`), "${1}"+v+"${2}")
				},
				func() error {
					return t.replaceOne(buildImagePath, regexp.MustCompile(`(\[string\] \$NodeSha256 = ')[0-9a-fA-F]{64}(')`), "${1}"+sums["msi"]+"${2}")
				},
				func() error {
					return t.replaceOne(provisionersTest, regexp.MustCompile(`(const PINNED_NODE_VERSION = ")[^"]+(")`), "${1}"+v+"${2}")
				},
				func() error {
					return t.replaceOne(provisionersTest, regexp.MustCompile(`(const PINNED_NODE_SHA256 = ")[0-9a-f]{64}(")`), "${1}"+sums["msi"]+"${2}")
				},
			})
		},
	},
}

func imageNodeApply(arg string) func(b *bumper, old, new string, sums map[string]string) error {
	return func(b *bumper, old, v string, sums map[string]string) error {
		return runAll([]func() error{
			func() error { return b.setDockerfileArg(arg, v) },
			func() error { return b.setArchSHAs(arg, "node_sha", sums) },
			// smoke.sh asserts the version the image shipped.
			func() error { return b.tree.replaceToken(smokePath, old, v, 1) },
			func() error { return b.tree.replaceToken(readmePath, old, v, 0) },
		})
	}
}

type nodeRelease struct {
	Version string `json:"version"`
	// LTS is false for a Current release and the codename string for LTS.
	LTS any `json:"lts"`
}

func (b *bumper) bumpNode(ctx context.Context, pin nodePin) (*outcome, error) {
	content, err := b.tree.read(pin.file)
	if err != nil {
		return nil, err
	}
	m := pin.pattern.FindStringSubmatch(content)
	if m == nil {
		if pin.optional {
			o := &outcome{}
			o.note("%s: not pinned in this tree (%s declares no %s), nothing to check.", pin.name, pin.file, pin.label)
			return o, nil
		}
		return nil, fmt.Errorf("%s: %s no longer declares %s", pin.name, pin.file, pin.label)
	}
	cur := m[1]
	curV, err := parseVersion(cur)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", pin.name, err)
	}

	var index []nodeRelease
	if err := b.fetchJSON(ctx, "https://nodejs.org/dist/index.json", &index); err != nil {
		return nil, err
	}
	var best version
	for _, r := range index {
		if lts, isBool := r.LTS.(bool); isBool && !lts {
			continue
		}
		rv, err := parseVersion(r.Version)
		if err != nil || rv.at(0) != curV.at(0) {
			continue
		}
		if best == nil || rv.compare(best) > 0 {
			best = rv
		}
	}
	if best == nil {
		return nil, fmt.Errorf("%s: nodejs.org lists no LTS release of Node.js %d", pin.name, curV.at(0))
	}
	v := best.String()
	if err := checkNotOlder(pin.name, cur, v); err != nil {
		return nil, err
	}

	base := "https://nodejs.org/dist/v" + v + "/"
	shasums, err := b.fetch(ctx, base+"SHASUMS256.txt")
	if err != nil {
		return nil, err
	}
	signature, err := b.fetch(ctx, base+"SHASUMS256.txt.sig")
	if err != nil {
		return nil, err
	}
	if err := b.verifyNode(ctx, shasums, signature); err != nil {
		return nil, fmt.Errorf("verifying SHASUMS256.txt for Node.js v%s: %w", v, err)
	}
	all := parseChecksumFile(shasums)
	sums := map[string]string{}
	for key, format := range pin.artifacts {
		name := fmt.Sprintf(format, v)
		sum, ok := all[name]
		if !ok {
			return nil, fmt.Errorf("SHASUMS256.txt for Node.js v%s lists no %s", v, name)
		}
		sums[key] = sum
	}
	if err := pin.apply(b, cur, v, sums); err != nil {
		return nil, err
	}
	o := &outcome{}
	o.moved(pin.name, cur, v, "SHASUMS256.txt, its signature verified against nodejs/release-keys")
	if cur != v && pin.onMove != "" {
		o.note("%s: %s", pin.name, pin.onMove)
	}
	return o, nil
}

// parseChecksumFile reads `<sha256>  <name>` lines, the format of both Node's
// SHASUMS256.txt and gh's checksums.txt. Lines that are not that are ignored.
func parseChecksumFile(raw []byte) map[string]string {
	out := map[string]string{}
	scanner := bufio.NewScanner(bytes.NewReader(raw))
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) == 2 && hex64.MatchString(fields[0]) {
			out[strings.TrimPrefix(fields[1], "*")] = fields[0]
		}
	}
	return out
}

// --- Go ---------------------------------------------------------------------

type goRelease struct {
	Version string `json:"version"`
	Stable  bool   `json:"stable"`
	Files   []struct {
		Filename string `json:"filename"`
		SHA256   string `json:"sha256"`
	} `json:"files"`
}

// bumpGo moves Go to the newest patch of the minor go.mod is on. The image's
// tool-cache Go, the builder stage that compiles runner-center-guest, and the
// module's go directive are one version on purpose (see the Dockerfile), so
// they move together.
func (b *bumper) bumpGo(ctx context.Context) (*outcome, error) {
	cur, ok, err := b.dockerfileArg("GO_VERSION")
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, fmt.Errorf("%s declares no ARG GO_VERSION", dockerfilePath)
	}
	mod, err := b.tree.read(goModPath)
	if err != nil {
		return nil, err
	}
	modGo := regexp.MustCompile(`(?m)^go (\S+)$`).FindStringSubmatch(mod)
	if modGo == nil {
		return nil, fmt.Errorf("%s has no go directive", goModPath)
	}
	if modGo[1] != cur {
		return nil, fmt.Errorf("%s says go %s but %s pins GO_VERSION=%s; they are meant to be one version", goModPath, modGo[1], dockerfilePath, cur)
	}
	curV, err := parseVersion(cur)
	if err != nil {
		return nil, err
	}

	var releases []goRelease
	if err := b.fetchJSON(ctx, "https://go.dev/dl/?mode=json&include=all", &releases); err != nil {
		return nil, err
	}
	var best, newest version
	var bestRelease goRelease
	for _, r := range releases {
		if !r.Stable {
			continue
		}
		rv, err := parseVersion(strings.TrimPrefix(r.Version, "go"))
		if err != nil {
			continue
		}
		if newest == nil || rv.compare(newest) > 0 {
			newest = rv
		}
		if rv.at(0) == curV.at(0) && rv.at(1) == curV.at(1) && (best == nil || rv.compare(best) > 0) {
			best, bestRelease = rv, r
		}
	}
	if best == nil {
		return nil, fmt.Errorf("go.dev lists no stable Go %d.%d release", curV.at(0), curV.at(1))
	}
	v := best.String()
	if err := checkNotOlder("Go", cur, v); err != nil {
		return nil, err
	}
	sums := map[string]string{}
	for arch, dist := range map[string]string{"amd64": "linux-amd64", "arm64": "linux-arm64"} {
		name := "go" + v + "." + dist + ".tar.gz"
		for _, f := range bestRelease.Files {
			if f.Filename == name {
				sums[arch] = f.SHA256
			}
		}
		if !hex64.MatchString(sums[arch]) {
			return nil, fmt.Errorf("go.dev lists no sha256 for %s", name)
		}
	}
	builderDigest, err := b.up.imageDigest(ctx, "docker.io", golangImageRepo, v+golangImageSuffix)
	if err != nil {
		return nil, err
	}

	builderPattern := regexp.MustCompile(`(FROM docker\.io/library/golang:)([0-9.]+` + golangImageSuffix + `@sha256:[0-9a-f]{64})`)
	df, err := b.tree.read(dockerfilePath)
	if err != nil {
		return nil, err
	}
	priorBuilder := ""
	if m := builderPattern.FindStringSubmatch(df); m != nil {
		priorBuilder = m[2]
	}
	builder := v + golangImageSuffix + "@" + builderDigest

	t := b.tree
	if err := runAll([]func() error{
		func() error { return t.replaceOne(goModPath, regexp.MustCompile(`(?m)^(go )\S+$`), "${1}"+v) },
		func() error { return b.setDockerfileArg("GO_VERSION", v) },
		func() error { return t.replaceOne(dockerfilePath, builderPattern, "${1}"+builder) },
		func() error { return b.setArchSHAs("GO_VERSION", "go_sha", sums) },
		func() error { return t.replaceToken(smokePath, cur, v, 1) },
		func() error { return t.replaceToken(readmePath, cur, v, 0) },
	}); err != nil {
		return nil, err
	}
	o := &outcome{}
	o.moved("Go (go.mod, image tool cache)", cur, v, "go.dev/dl JSON sha256")
	o.moved("golang builder image", priorBuilder, builder, "Docker Hub manifest digest")
	if newest != nil && (newest.at(0) != best.at(0) || newest.at(1) != best.at(1)) {
		o.note("Go %s is out: this repository is on Go %d.%d and Go supports only its two newest minor releases. Moving go.mod to a new minor is a deliberate change, so the bump does not make it.", newest, best.at(0), best.at(1))
	}
	return o, nil
}

// --- GitHub CLI -------------------------------------------------------------

func (b *bumper) bumpGH(ctx context.Context) (*outcome, error) {
	cur, ok, err := b.dockerfileArg("GH_VERSION")
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, fmt.Errorf("%s declares no ARG GH_VERSION", dockerfilePath)
	}
	rel, v, err := b.latestRelease(ctx, "cli/cli")
	if err != nil {
		return nil, err
	}
	if err := checkNotOlder("gh", cur, v); err != nil {
		return nil, err
	}
	checksumsName := "gh_" + v + "_checksums.txt"
	var checksumsURL string
	for _, a := range rel.Assets {
		if a.Name == checksumsName {
			checksumsURL = a.URL
		}
	}
	if checksumsURL == "" {
		return nil, fmt.Errorf("cli/cli v%s has no %s", v, checksumsName)
	}
	raw, err := b.fetch(ctx, checksumsURL)
	if err != nil {
		return nil, err
	}
	all := parseChecksumFile(raw)
	sums := map[string]string{}
	for _, arch := range []string{"amd64", "arm64"} {
		name := "gh_" + v + "_linux_" + arch + ".tar.gz"
		sum, found := all[name]
		if !found {
			return nil, fmt.Errorf("cli/cli v%s: %s lists no %s", v, checksumsName, name)
		}
		// The asset digest is GitHub's own hash of the upload; when it is
		// there it must agree with the file the gh release pipeline wrote.
		if digest, found := rel.assetDigest(name); found && digest != "" && digest != sum {
			return nil, fmt.Errorf("cli/cli v%s: %s asset digest %s disagrees with %s's %s", v, name, digest, checksumsName, sum)
		}
		sums[arch] = sum
	}
	t := b.tree
	if err := runAll([]func() error{
		func() error { return b.setDockerfileArg("GH_VERSION", v) },
		func() error { return b.setArchSHAs("GH_VERSION", "gh_sha", sums) },
		func() error { return t.replaceToken(smokePath, cur, v, 1) },
		func() error { return t.replaceToken(readmePath, cur, v, 0) },
	}); err != nil {
		return nil, err
	}
	o := &outcome{}
	o.moved("GitHub CLI", cur, v, checksumsName+", cross-checked against the release asset digests")
	return o, nil
}

// --- Actions seeded in the image's action-archive cache --------------------

// seedPattern finds the action archives the image pre-downloads. The
// directory is the runner's own cache key, owner_repo, so the action's
// identity comes from the Dockerfile rather than from a list kept here.
var seedPattern = regexp.MustCompile(`/opt/action-cache/([A-Za-z0-9.-]+)_([A-Za-z0-9._-]+)/([0-9a-f]{40})\.tar\.gz`)

type gitRef struct {
	Object struct {
		SHA  string `json:"sha"`
		Type string `json:"type"`
	} `json:"object"`
}

// bumpSeededActions moves the Actions whose archives images/ubuntu-24.04-js
// pre-downloads. They are excluded from Dependabot because a bump has to
// change the workflows and the Dockerfile's archive and checksum in one
// commit: packages/release/tests/image-contract.test.ts fails a pull request
// that moves only one of them.
func (b *bumper) bumpSeededActions(ctx context.Context) (*outcome, error) {
	df, err := b.tree.read(dockerfilePath)
	if err != nil {
		return nil, err
	}
	workflows, err := b.tree.glob(workflowsRoot, ".yml", ".yaml")
	if err != nil {
		return nil, err
	}
	o := &outcome{}
	seen := map[string]bool{}
	for _, m := range seedPattern.FindAllStringSubmatch(df, -1) {
		owner, repo, pinned := m[1], m[2], m[3]
		slug := owner + "/" + repo
		if seen[slug] {
			continue
		}
		seen[slug] = true
		cacheDir := owner + "_" + repo

		// The major comes from the version comment workflows carry beside
		// the SHA, the same comment Dependabot reads and rewrites.
		usesPattern := regexp.MustCompile(`uses: ` + regexp.QuoteMeta(slug) + `@` + pinned + ` # v(\d+)\S*`)
		major := ""
		for _, wf := range workflows {
			content, err := b.tree.read(wf)
			if err != nil {
				return nil, err
			}
			if mm := usesPattern.FindStringSubmatch(content); mm != nil {
				major = mm[1]
				break
			}
		}
		if major == "" {
			return nil, fmt.Errorf("%s seeds %s@%s but no workflow under %s uses that commit with a version comment", dockerfilePath, slug, pinned, workflowsRoot)
		}

		var releases []githubRelease
		if err := b.fetchJSON(ctx, "https://api.github.com/repos/"+slug+"/releases?per_page=100", &releases); err != nil {
			return nil, err
		}
		var best, newest version
		bestTag := ""
		for _, r := range releases {
			if r.Draft || r.Prerelease {
				continue
			}
			rv, err := parseVersion(r.TagName)
			if err != nil || !strings.HasPrefix(r.TagName, "v") {
				continue
			}
			if newest == nil || rv.compare(newest) > 0 {
				newest = rv
			}
			if fmt.Sprint(rv.at(0)) == major && (best == nil || rv.compare(best) > 0) {
				best, bestTag = rv, r.TagName
			}
		}
		if best == nil {
			return nil, fmt.Errorf("%s has no v%s.x release", slug, major)
		}
		if newest != nil && fmt.Sprint(newest.at(0)) != major {
			o.note("%s %s is out; the workflows stay on v%s, because a new major is a change to review, not a pin bump.", slug, "v"+newest.String(), major)
		}

		commit, err := b.tagCommit(ctx, slug, bestTag)
		if err != nil {
			return nil, err
		}
		if commit == pinned {
			continue
		}
		// GitHub publishes no checksum for a source archive, so this one is
		// measured here, once, and the image build then refuses any archive
		// that hashes differently.
		tarball, err := b.fetch(ctx, "https://api.github.com/repos/"+slug+"/tarball/"+commit)
		if err != nil {
			return nil, err
		}
		archiveSHA := sha256Hex(tarball)

		t := b.tree
		if err := runAll([]func() error{
			func() error {
				return t.replaceOne(dockerfilePath,
					regexp.MustCompile(`(?m)^(\s*)[0-9a-f]{64}( \\\n\s*/opt/action-cache/`+regexp.QuoteMeta(cacheDir)+`/)`+pinned+`(\.tar\.gz)`),
					"${1}"+archiveSHA+"${2}"+commit+"${3}")
			},
			func() error { return t.replaceToken(dockerfilePath, pinned, commit, 2) },
			func() error { return t.replaceToken(smokePath, pinned, commit, 0) },
			func() error {
				total := 0
				repin := regexp.MustCompile(`(uses: ` + regexp.QuoteMeta(slug) + `@)` + pinned + `( # )\S+`)
				for _, wf := range workflows {
					n, err := t.replace(wf, repin, "${1}"+commit+"${2}"+bestTag, 0, -1)
					if err != nil {
						return err
					}
					total += n
				}
				if total == 0 {
					return fmt.Errorf("no workflow uses %s@%s", slug, pinned)
				}
				return nil
			},
		}); err != nil {
			return nil, err
		}
		o.moved(slug+" (workflows and image action cache)", pinned[:12], bestTag+" "+commit[:12], "tag resolved through the GitHub API; archive SHA-256 measured from api.github.com")
	}
	if len(seen) == 0 {
		return nil, fmt.Errorf("%s seeds no action archives under /opt/action-cache", dockerfilePath)
	}
	return o, nil
}

// tagCommit resolves a tag to the commit it names, peeling annotated tags.
func (b *bumper) tagCommit(ctx context.Context, slug, tag string) (string, error) {
	var ref gitRef
	if err := b.fetchJSON(ctx, "https://api.github.com/repos/"+slug+"/git/ref/tags/"+tag, &ref); err != nil {
		return "", err
	}
	for i := 0; i < 4 && ref.Object.Type == "tag"; i++ {
		sha := ref.Object.SHA
		ref = gitRef{}
		if err := b.fetchJSON(ctx, "https://api.github.com/repos/"+slug+"/git/tags/"+sha, &ref); err != nil {
			return "", err
		}
	}
	if ref.Object.Type != "commit" || !hex40.MatchString(ref.Object.SHA) {
		return "", fmt.Errorf("%s tag %s does not resolve to a commit", slug, tag)
	}
	return ref.Object.SHA, nil
}
