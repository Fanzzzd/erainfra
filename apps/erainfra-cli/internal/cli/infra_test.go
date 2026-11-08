package cli

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
)

// capture records the method, path, query and JSON body of every request a route receives.
type capture struct {
	mu       sync.Mutex
	requests []captured
}
type captured struct {
	method, path, query, auth string
	body                      map[string]any
	raw                       []byte
}

func (c *capture) route(status int, reply string) func(http.ResponseWriter, *http.Request) {
	return c.sequence([]int{status}, []string{reply})
}

// sequence answers the nth request with the nth reply, repeating the last.
func (c *capture) sequence(statuses []int, replies []string) func(http.ResponseWriter, *http.Request) {
	return func(w http.ResponseWriter, r *http.Request) {
		var raw []byte
		if r.Body != nil {
			raw, _ = io.ReadAll(r.Body)
		}
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		c.mu.Lock()
		n := len(c.requests)
		c.requests = append(c.requests, captured{r.Method, r.URL.Path, r.URL.RawQuery, r.Header.Get("Authorization"), body, raw})
		c.mu.Unlock()
		if n >= len(replies) {
			n = len(replies) - 1
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(statuses[min(n, len(statuses)-1)])
		_, _ = io.WriteString(w, replies[n])
	}
}

func (c *capture) last(t *testing.T) captured {
	t.Helper()
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.requests) == 0 {
		t.Fatal("no request reached the route")
	}
	return c.requests[len(c.requests)-1]
}

func TestNodesListShowsTransportAndMeshProof(t *testing.T) {
	h := newHarness(t).loggedIn()
	h.api.on("GET /api/v1/nodes", 200, `{"nodes":[
	  {"name":"edge-1","transport":"convex","online":true,"lastSeenAt":"2026-11-05T11:59:30Z","infraAgentVersion":"0.3.0",
	   "endpoint":{"id":"abcdef0123456789","proven":true},"placementRoles":["gateway"],"liveCredentials":1},
	  {"name":"edge-2","transport":"convex","online":true,"lastSeenAt":"2026-11-05T11:59:30Z","infraAgentVersion":"0.3.1",
	   "endpoint":{"id":null,"proven":false},"liveCredentials":1,
	   "commands":{"blocked":"journal_full","blockedSince":"2026-11-05T11:00:00Z","journalKeys":10000,"journalKeyLimit":10000}},
	  {"name":"old-box","transport":"hub","online":false,"lastSeenAt":null,"infraAgentVersion":null,
	   "endpoint":{"id":null,"proven":false},"liveCredentials":0}]}`)
	h.expect(ExitOK, "nodes", "list")
	out := h.stdout.String()
	for _, want := range []string{"TRANSPORT", "edge-1", "convex", "online", "30s ago", "proven abcdef0123…", "gateway", "online, blocked: journal_full", "old-box", "hub", "offline", "none"} {
		if !strings.Contains(out, want) {
			t.Errorf("nodes list lacks %q:\n%s", want, out)
		}
	}
	h.expect(ExitOK, "nodes", "list", "--json")
	if !strings.Contains(h.stdout.String(), `"transport": "convex"`) {
		t.Errorf("json is not the API's body: %s", h.stdout.String())
	}
}

func TestNodesEnrollPrintsTheCredentialOnceOnStdout(t *testing.T) {
	h := newHarness(t).loggedIn()
	var c capture
	h.api.routes["POST /api/v1/nodes"] = c.route(201, `{"node":{"id":"n1","name":"edge-1"},"credential":"erainfra_node_`+strings.Repeat("a", 64)+`"}`)
	h.expect(ExitOK, "nodes", "enroll", "edge-1")
	if got := h.stdout.String(); got != "erainfra_node_"+strings.Repeat("a", 64)+"\n" {
		t.Errorf("stdout should be the credential alone, got %q", got)
	}
	if !strings.Contains(h.stderr.String(), "not shown again") {
		t.Errorf("stderr = %q", h.stderr.String())
	}
	if req := c.last(t); req.body["name"] != "edge-1" {
		t.Errorf("body = %v", req.body)
	}
	h.expect(ExitUsage, "nodes", "enroll", "../admin")

	reader := newHarness(t)
	reader.env["ERAINFRA_URL"], reader.env["ERAINFRA_TOKEN"] = deployment, readToken
	reader.api.routes = h.api.routes
	reader.expect(ExitAuth, "nodes", "enroll", "edge-1")
	if !strings.Contains(reader.stderr.String(), "admin token") {
		t.Errorf("a read token should be told it needs admin: %q", reader.stderr.String())
	}
}

func TestNodesRevokeAndResetEndpoint(t *testing.T) {
	h := newHarness(t).loggedIn()
	var revoke, reset capture
	h.api.routes["POST /api/v1/nodes/edge-1/revoke"] = revoke.route(200, `{"node":"edge-1","revoked":["erainfra_node_abcd1234"]}`)
	h.api.routes["POST /api/v1/nodes/edge-1/endpoint/reset"] = reset.route(200, `{"node":"edge-1"}`)
	h.expect(ExitOK, "nodes", "revoke", "edge-1", "--credential", "erainfra_node_abcd1234")
	if revoke.last(t).body["credential"] != "erainfra_node_abcd1234" || !strings.Contains(h.stdout.String(), "revoked erainfra_node_abcd1234") {
		t.Errorf("revoke: %v %q", revoke.last(t).body, h.stdout.String())
	}
	h.expect(ExitOK, "nodes", "revoke", "edge-1")
	if _, has := revoke.last(t).body["credential"]; has {
		t.Error("revoking every credential sends no credential field")
	}
	h.expect(ExitOK, "nodes", "reset-endpoint", "edge-1")
	if reset.last(t).method != http.MethodPost {
		t.Error("reset-endpoint did not POST")
	}
	h.api.on("POST /api/v1/nodes/ghost/revoke", 404, `{"error":{"code":"not_found","message":"No Node named \"ghost\""}}`)
	h.expect(ExitError, "nodes", "revoke", "ghost")
	if !strings.Contains(h.stderr.String(), `No Node named "ghost" (HTTP 404)`) {
		t.Errorf("stderr = %q", h.stderr.String())
	}
}

func TestNodesSetRolesReplacesOrClears(t *testing.T) {
	h := newHarness(t).loggedIn()
	var roles capture
	h.api.routes["PUT /api/v1/nodes/edge-1/roles"] = roles.route(200, `{"node":"edge-1","placementRoles":["gateway"]}`)
	h.expect(ExitOK, "nodes", "set-roles", "edge-1", "gateway")
	if got := roles.last(t).body["roles"]; len(got.([]any)) != 1 || got.([]any)[0] != "gateway" {
		t.Errorf("roles body = %v", roles.last(t).body)
	}
	if h.stdout.String() != "edge-1 placement roles: gateway\n" {
		t.Errorf("stdout = %q", h.stdout.String())
	}
	h.api.routes["PUT /api/v1/nodes/edge-1/roles"] = roles.route(200, `{"node":"edge-1","placementRoles":[]}`)
	h.expect(ExitOK, "nodes", "set-roles", "edge-1", "--clear")
	if got := roles.last(t).body["roles"]; got == nil || len(got.([]any)) != 0 {
		t.Errorf("--clear must send an empty list, got %v", roles.last(t).body)
	}
	before := len(roles.requests)
	h.expect(ExitUsage, "nodes", "set-roles", "edge-1")
	h.expect(ExitUsage, "nodes", "set-roles", "edge-1", "worker")
	h.expect(ExitUsage, "nodes", "set-roles", "edge-1", "gateway", "--clear")
	if len(roles.requests) != before {
		t.Error("usage errors must not reach the network")
	}
}

func TestEnvSetUnsetAndList(t *testing.T) {
	h := newHarness(t).loggedIn()
	var put, del capture
	h.api.routes["PUT /api/v1/apps/shop/env"] = put.route(200, `{"app":"shop","names":["API_TOKEN","MODE"]}`)
	h.api.routes["DELETE /api/v1/apps/shop/env/MODE"] = del.route(200, `{"app":"shop","name":"MODE","removed":true}`)
	h.api.on("GET /api/v1/apps/shop/env", 200, `{"app":"shop","env":{"app":[{"name":"MODE","preview":"••••••","updatedAt":1762344000000}],
	  "services":{"web":[{"name":"API_TOKEN","preview":"••••••","updatedAt":1762344000000}]}}}`)

	h.stdin = "tok-from-stdin\n"
	h.expect(ExitOK, "env", "set", "shop", "MODE=prod", "API_TOKEN", "--service", "web")
	req := put.last(t)
	vars, _ := req.body["vars"].(map[string]any)
	if vars["MODE"] != "prod" || vars["API_TOKEN"] != "tok-from-stdin" || req.body["service"] != "web" {
		t.Errorf("PUT body = %v", req.body)
	}
	if strings.Contains(h.stdout.String(), "tok-from-stdin") {
		t.Error("a value must never be printed")
	}

	h.expect(ExitOK, "env", "unset", "shop", "MODE", "--service", "web")
	if q := del.last(t).query; q != "service=web" {
		t.Errorf("unset query = %q", q)
	}

	h.expect(ExitOK, "env", "list", "shop")
	for _, want := range []string{"SCOPE", "app", "MODE", "service web", "API_TOKEN", "••••••"} {
		if !strings.Contains(h.stdout.String(), want) {
			t.Errorf("env list lacks %q:\n%s", want, h.stdout.String())
		}
	}

	before := len(h.api.requests)
	for _, args := range [][]string{
		{"env", "set", "shop", "1BAD=x"},
		{"env", "set", "shop", "A=1", "A=2"},
		{"env", "set", "shop", "A", "B"},
		{"env", "set", "shop"},
		{"env", "unset", "shop", "not-a-name"},
	} {
		h.expect(ExitUsage, args...)
	}
	if len(h.api.requests) != before {
		t.Error("usage errors must not reach the network")
	}
}

func TestLinksAddListRemove(t *testing.T) {
	h := newHarness(t).loggedIn()
	var add capture
	h.api.routes["POST /api/v1/links"] = add.route(201, `{"link":{"name":"db","address":"127.0.0.1:15432","replaced":false}}`)
	h.api.on("DELETE /api/v1/links/db", 200, `{"link":{"name":"db"}}`)
	h.api.on("GET /api/v1/links", 200, `{"links":[
	  {"name":"db","kind":"standalone","app":null,"createdBy":"user","provider":"node-a","providerPort":5432,"consumer":"node-b",
	   "localPort":15432,"listen":"127.0.0.1:15432","transport":"mesh","state":"active","reason":null},
	  {"name":"shop-cache","kind":"app","app":"shop","createdBy":"deploy","provider":"node-c","providerPort":62001,"consumer":"node-b",
	   "localPort":62001,"listen":"bridge:62001","transport":"legacy","state":"pending","reason":"node-c has no proven mesh endpoint"}]}`)

	h.expect(ExitOK, "links", "add", "node-a:5432", "node-b:15432", "--name", "db")
	body := add.last(t).body
	if body["provider"] != "node-a" || body["providerPort"] != float64(5432) || body["consumer"] != "node-b" ||
		body["localPort"] != float64(15432) || body["name"] != "db" {
		t.Errorf("POST body = %v", body)
	}
	h.expect(ExitOK, "links", "list")
	for _, want := range []string{"TRANSPORT", "node-a:5432", "node-b @127.0.0.1:15432", "mesh", "active", "legacy", "pending", "app:shop"} {
		if !strings.Contains(h.stdout.String(), want) {
			t.Errorf("links list lacks %q:\n%s", want, h.stdout.String())
		}
	}
	if !strings.Contains(h.stderr.String(), "shop-cache: node-c has no proven mesh endpoint") {
		t.Errorf("a pending link's reason belongs on stderr: %q", h.stderr.String())
	}
	h.expect(ExitOK, "links", "remove", "db")
	h.expect(ExitUsage, "links", "add", "node-a", "node-b")
	h.expect(ExitUsage, "links", "add", "node-a:5432", "node-b:x")
}

func TestAppsListViewAndRemove(t *testing.T) {
	h := newHarness(t).loggedIn()
	h.api.on("GET /api/v1/apps", 200, `{"apps":[{"name":"shop","kind":"app","node":"node-a","status":"running","failover":true,
	  "services":[{"name":"web","node":"node-a","image":"r/shop-web:1","port":62000,"route":"shop","url":"https://shop.example.test","container":"shop-web"},
	              {"name":"worker","node":"node-b","image":"r/shop-worker:1","port":null,"route":null,"url":null,"container":"shop-worker"}],
	  "links":[],"lastDeployment":{"id":"d1","operation":"deploy","stage":"done","detail":"deployed","error":null,"startedAt":"2026-11-05T11:00:00Z","finishedAt":null}}]}`)
	h.api.on("GET /api/v1/apps/shop", 200, `{"app":{"name":"shop","kind":"app","node":"node-a","status":"deploying","failover":false,
	  "services":[{"name":"web","node":"node-a","image":"r/shop-web:1","port":62000,"route":"shop","url":"https://shop.example.test","container":"shop-web"}],
	  "links":[],"lastDeployment":null,"env":{"app":[{"name":"MODE"}],"services":{"web":[{"name":"API_TOKEN"}]}},
	  "deployments":[{"id":"d2","operation":"deploy","stage":"building","detail":"building web","error":null,"startedAt":"2026-11-05T11:59:00Z","finishedAt":null}]}}`)
	var del capture
	h.api.routes["DELETE /api/v1/apps/shop"] = del.route(202, `{"removal":{"app":"shop","containers":[{"node":"node-a","container":"shop-web"}],"routes":["shop"]}}`)

	h.expect(ExitOK, "apps", "list")
	for _, want := range []string{"shop", "running", "node-a,node-b", "done 1h ago", "https://shop.example.test"} {
		if !strings.Contains(h.stdout.String(), want) {
			t.Errorf("apps list lacks %q:\n%s", want, h.stdout.String())
		}
	}
	h.expect(ExitOK, "apps", "view", "shop")
	for _, want := range []string{"shop  deploying", "not failed over automatically", "MODE, web/API_TOKEN", "d2", "building"} {
		if !strings.Contains(h.stdout.String(), want) {
			t.Errorf("apps view lacks %q:\n%s", want, h.stdout.String())
		}
	}
	h.expect(ExitUsage, "apps", "remove", "shop")
	if len(del.requests) != 0 {
		t.Fatal("remove without --yes reached the network")
	}
	h.expect(ExitOK, "apps", "remove", "shop", "--yes")
	if !strings.Contains(h.stderr.String(), "removing shop-web on node-a") {
		t.Errorf("stderr = %q", h.stderr.String())
	}
}

func TestLogsWaitsForTheNodeThenPrintsOnce(t *testing.T) {
	h := newHarness(t).loggedIn()
	var ask, read capture
	h.api.routes["POST /api/v1/logs"] = ask.route(202, `{"logs":{"id":"lt1","state":"pending","node":"node-a"}}`)
	h.api.routes["GET /api/v1/logs/lt1"] = read.sequence([]int{202, 202, 200},
		[]string{`{"logs":{"id":"lt1","state":"pending"}}`, `{"logs":{"id":"lt1","state":"pending"}}`,
			`{"logs":{"id":"lt1","state":"ready","text":"one\ntwo","truncated":true}}`})
	h.expect(ExitOK, "logs", "shop", "--service", "web", "--lines", "20")
	if h.stdout.String() != "one\ntwo\n" {
		t.Errorf("stdout = %q", h.stdout.String())
	}
	if !strings.Contains(h.stderr.String(), "newest 128 KiB") {
		t.Errorf("a truncated tail should say so: %q", h.stderr.String())
	}
	body := ask.last(t).body
	if body["app"] != "shop" || body["service"] != "web" || body["lines"] != float64(20) {
		t.Errorf("POST body = %v", body)
	}
	if len(read.requests) != 3 {
		t.Errorf("polled %d times, want 3", len(read.requests))
	}

	h.api.routes["GET /api/v1/logs/lt1"] = read.route(200, `{"logs":{"id":"lt1","state":"failed","error":"The Node could not read the logs"}}`)
	h.expect(ExitError, "logs", "--node", "node-a", "--unit", "erainfra-mesh.service")
	if b := ask.last(t).body; b["node"] != "node-a" || b["unit"] != "erainfra-mesh.service" {
		t.Errorf("unit request = %v", b)
	}

	for _, args := range [][]string{
		{"logs"},
		{"logs", "shop", "--node", "a", "--unit", "u"},
		{"logs", "--node", "a"},
		{"logs", "--node", "a", "--unit", "u", "--service", "web"},
		{"logs", "shop", "--lines", "5000"},
	} {
		h.expect(ExitUsage, args...)
	}
}

// tarEntries lists the names in a gzipped tarball.
func tarEntries(t *testing.T, archive []byte) []string {
	t.Helper()
	gz, err := gzip.NewReader(bytes.NewReader(archive))
	if err != nil {
		t.Fatal(err)
	}
	tr := tar.NewReader(gz)
	var names []string
	for {
		header, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		names = append(names, header.Name)
	}
	sort.Strings(names)
	return names
}

func deployRoutes(h *harness, final string) (*capture, *capture, *capture) {
	var slot, upload, start capture
	h.api.routes["POST /api/v1/deployments/uploads"] = slot.route(201, `{"uploadUrl":"https://fleet.example.test/storage/upload/abc"}`)
	h.api.routes["POST /storage/upload/abc"] = upload.route(200, `{"storageId":"kg2storage"}`)
	h.api.routes["POST /api/v1/deployments"] = start.route(202, `{"deployment":{"id":"dep1","app":"my-site","stage":"queued","detail":"queued"}}`)
	var status capture
	h.api.routes["GET /api/v1/deployments/dep1"] = status.sequence([]int{200}, []string{
		`{"deployment":{"id":"dep1","app":"my-site","stage":"building","detail":"building web"}}`,
		`{"deployment":{"id":"dep1","app":"my-site","stage":"building","detail":"building web"}}`,
		final,
	})
	return &slot, &upload, &start
}

func TestDeployPacksUploadsStartsAndFollows(t *testing.T) {
	h := newHarness(t).loggedIn()
	_, upload, start := deployRoutes(h, `{"deployment":{"id":"dep1","app":"my-site","stage":"done","detail":"deployed","urls":["https://my-site.example.test"]}}`)
	// The upload URL is a capability on file storage: it is posted without the API token.
	h.api.tokenless = map[string]bool{"/storage/upload/abc": true}

	dir := filepath.Join(t.TempDir(), "My Site")
	for path, content := range map[string]string{
		"Dockerfile":              "FROM scratch\n",
		"src/index.js":            "console.log(1)\n",
		"node_modules/x/index.js": "skipped\n",
		"._Dockerfile":            "appledouble\n",
		".turbo/cache":            "skipped\n",
	} {
		full := filepath.Join(dir, path)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	h.expect(ExitOK, "deploy", dir, "--port", "3000", "--node", "node-a")
	if got := h.stdout.String(); !strings.Contains(got, "deployed my-site") || !strings.Contains(got, "https://my-site.example.test") {
		t.Errorf("stdout = %q", got)
	}
	if !strings.Contains(h.stderr.String(), "building: building web") {
		t.Errorf("stages belong on stderr: %q", h.stderr.String())
	}
	up := upload.last(t)
	if up.auth != "" {
		t.Errorf("the API token was sent to the upload URL: %q", up.auth)
	}
	if got := tarEntries(t, up.raw); strings.Join(got, ",") != "Dockerfile,src/,src/index.js" {
		t.Errorf("archive entries = %v", got)
	}
	body := start.last(t).body
	if body["app"] != "my-site" || body["upload"] != "kg2storage" || body["port"] != float64(3000) || body["node"] != "node-a" {
		t.Errorf("deploy body = %v", body)
	}
}

func TestDeployFailsWithTheRunsErrorAndDeploysARepository(t *testing.T) {
	h := newHarness(t).loggedIn()
	_, upload, start := deployRoutes(h, `{"deployment":{"id":"dep1","app":"my-site","stage":"failed","detail":"building","error":"docker build exited 1"}}`)
	h.expect(ExitOK, "deploy", "--repo", "acme/my-site", "--branch", "release", "--detach")
	if !strings.Contains(h.stdout.String(), "started deployment dep1") {
		t.Errorf("stdout = %q", h.stdout.String())
	}
	if len(upload.requests) != 0 {
		t.Error("a repository deploy uploads nothing")
	}
	if b := start.last(t).body; b["repo"] != "acme/my-site" || b["branch"] != "release" || b["app"] != "my-site" {
		t.Errorf("deploy body = %v", b)
	}
	h.expect(ExitError, "deploy", "--repo", "acme/my-site")
	if !strings.Contains(h.stderr.String(), "docker build exited 1") {
		t.Errorf("stderr = %q", h.stderr.String())
	}
	h.expect(ExitUsage, "deploy", ".", "--repo", "acme/x")
	h.expect(ExitUsage, "deploy", "--branch", "main")
	h.expect(ExitUsage, "deploy", filepath.Join(t.TempDir(), "missing"))
}

func TestDeployAdoptSendsTheContainersToReplace(t *testing.T) {
	h := newHarness(t).loggedIn()
	_, _, start := deployRoutes(h, `{"deployment":{"id":"dep1","app":"my-site","stage":"done","detail":"deployed"}}`)
	h.expect(ExitOK, "deploy", "--repo", "acme/my-site", "--adopt", "my-site-web", "--adopt=my-site-db", "--detach")
	adopt, _ := start.last(t).body["adopt"].([]any)
	if len(adopt) != 2 || adopt[0] != "my-site-web" || adopt[1] != "my-site-db" {
		t.Errorf("deploy body = %v", start.last(t).body)
	}
	// Without --adopt the request carries no adopt field, so an older control plane accepts it.
	h.expect(ExitOK, "deploy", "--repo", "acme/my-site", "--detach")
	if _, ok := start.last(t).body["adopt"]; ok {
		t.Errorf("deploy body = %v", start.last(t).body)
	}
	before := len(start.requests)
	h.expect(ExitUsage, "deploy", "--repo", "acme/my-site", "--adopt", "blog-web")
	if !strings.Contains(h.stderr.String(), "--adopt blog-web: name a container of App my-site, my-site-<service>") {
		t.Errorf("stderr = %q", h.stderr.String())
	}
	if len(start.requests) != before {
		t.Error("a refused --adopt still started a deploy")
	}
	h.expect(ExitOK, "deploy", "--help")
	if !strings.Contains(h.stdout.String(), "--adopt CONTAINER") {
		t.Errorf("deploy --help lacks --adopt:\n%s", h.stdout.String())
	}
}

func TestDeployPacksAGitRepositoryWithGitArchive(t *testing.T) {
	h := newHarness(t).loggedIn()
	var gitCalls [][]string
	h.git = func(_ string, args []string) ([]byte, error) {
		gitCalls = append(gitCalls, args)
		switch args[0] {
		case "rev-parse":
			return []byte("true\n"), nil
		case "status":
			return []byte(" M dirty.go\n"), nil
		case "archive":
			return []byte("gzipped-head"), nil
		}
		return nil, errors.New("unexpected git call")
	}
	_, upload, _ := deployRoutes(h, `{"deployment":{"id":"dep1","app":"repo","stage":"done","detail":"deployed"}}`)
	h.api.tokenless = map[string]bool{"/storage/upload/abc": true}
	h.expect(ExitOK, "deploy", t.TempDir(), "--app", "repo")
	if string(upload.last(t).raw) != "gzipped-head" {
		t.Errorf("uploaded %q", upload.last(t).raw)
	}
	if !strings.Contains(h.stderr.String(), "uncommitted changes are not included") {
		t.Errorf("stderr = %q", h.stderr.String())
	}
	if got := gitCalls[len(gitCalls)-1]; strings.Join(got, " ") != "archive --format=tar.gz HEAD" {
		t.Errorf("git = %v", got)
	}
}
