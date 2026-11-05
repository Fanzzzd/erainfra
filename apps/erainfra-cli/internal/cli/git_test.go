package cli

import (
	"net/http"
	"net/url"
	"strings"
	"testing"
)

const bindingJSON = `{"id":"b1","repo":"acme/shop","branch":"release/1.2","app":"shop","buildNode":"builder","deployNode":"web-1",
  "port":3000,"createdAt":"2026-11-05T11:00:00.000Z",
  "lastStatus":{"at":"2026-11-05T11:58:00.000Z","sha":"0123456789abcdef0123456789abcdef01234567","ok":false,"stage":"build","error":"exit 1"}}`

func TestGitBindingsListsTableAndPassesJSONThrough(t *testing.T) {
	h := newHarness(t).loggedIn()
	h.api.on("GET /api/v1/git/bindings", 200, `{"bindings":[`+bindingJSON+`,
	  {"id":"b2","repo":"acme/api","branch":"main","app":"api","buildNode":null,"deployNode":null,"port":null,
	   "createdAt":"2026-11-05T11:00:00.000Z","lastStatus":null}]}`)
	h.expect(ExitOK, "git", "bindings")
	out := h.stdout.String()
	for _, want := range []string{"REPOSITORY", "acme/shop", "release/1.2", "shop", "builder", "web-1", "3000", "0123456 failed at build 2m ago", "acme/api"} {
		if !strings.Contains(out, want) {
			t.Errorf("git bindings lacks %q:\n%s", want, out)
		}
	}
	h.expect(ExitOK, "git", "bindings", "--format", "json")
	if !strings.Contains(h.stdout.String(), `"branch": "release/1.2"`) {
		t.Errorf("json is not the API's body: %s", h.stdout.String())
	}

	h.api.on("GET /api/v1/git/bindings", 200, `{"bindings":[]}`)
	h.expect(ExitOK, "git", "bindings")
	if h.stdout.Len() != 0 || !strings.Contains(h.stderr.String(), "erainfra git bind") {
		t.Errorf("an empty list should say how to bind, on stderr: %q %q", h.stdout.String(), h.stderr.String())
	}

	// A read token may list.
	reader := newHarness(t)
	reader.env["ERAINFRA_URL"], reader.env["ERAINFRA_TOKEN"] = deployment, readToken
	reader.api.routes = h.api.routes
	reader.expect(ExitOK, "git", "bindings")
}

func TestGitBindSendsNodesByNameAndNeedsAnAdminToken(t *testing.T) {
	h := newHarness(t).loggedIn()
	var bind capture
	h.api.routes["POST /api/v1/git/bindings"] = bind.route(201, `{"binding":`+bindingJSON+`}`)
	h.expect(ExitOK, "git", "bind", "acme/shop", "release/1.2", "--app", "shop", "--build-node", "builder", "--deploy-node", "web-1", "--port", "3000")
	body := bind.last(t).body
	want := map[string]any{"repo": "acme/shop", "branch": "release/1.2", "app": "shop", "buildNode": "builder", "deployNode": "web-1", "port": float64(3000)}
	if len(body) != len(want) {
		t.Errorf("POST body = %v", body)
	}
	for k, v := range want {
		if body[k] != v {
			t.Errorf("POST body[%s] = %v, want %v", k, body[k], v)
		}
	}
	if got := h.stdout.String(); got != "bound acme/shop@release/1.2: a push deploys App shop\n" {
		t.Errorf("stdout = %q", got)
	}

	h.expect(ExitOK, "git", "bind", "acme/shop", "main", "--app", "shop")
	for _, absent := range []string{"buildNode", "deployNode", "port"} {
		if _, has := bind.last(t).body[absent]; has {
			t.Errorf("an unset flag sends no %s", absent)
		}
	}
	h.expect(ExitOK, "git", "bind", "acme/shop", "main", "--app", "shop", "--json")
	if !strings.Contains(h.stdout.String(), `"binding"`) {
		t.Errorf("json is not the API's body: %s", h.stdout.String())
	}

	h.api.on("POST /api/v1/git/bindings", 409, `{"error":{"code":"conflict","message":"Already bound: acme/shop@main"}}`)
	h.expect(ExitError, "git", "bind", "acme/shop", "main", "--app", "shop")
	if !strings.Contains(h.stderr.String(), "Already bound: acme/shop@main (HTTP 409)") {
		t.Errorf("stderr = %q", h.stderr.String())
	}

	reader := newHarness(t)
	reader.env["ERAINFRA_URL"], reader.env["ERAINFRA_TOKEN"] = deployment, readToken
	reader.api.routes = h.api.routes
	reader.expect(ExitAuth, "git", "bind", "acme/shop", "main", "--app", "shop")
	if !strings.Contains(reader.stderr.String(), "admin token") {
		t.Errorf("a read token should be told it needs admin: %q", reader.stderr.String())
	}
}

func TestGitUnbindNamesTheBranchInTheQuery(t *testing.T) {
	h := newHarness(t).loggedIn()
	var unbind capture
	h.api.routes["DELETE /api/v1/git/bindings"] = unbind.route(200, `{"binding":{"repo":"acme/shop","branch":"release/1.2","app":"shop"}}`)
	h.expect(ExitOK, "git", "unbind", "acme/shop", "release/1.2")
	req := unbind.last(t)
	if req.path != "/api/v1/git/bindings" {
		t.Errorf("the branch must not be in the path: %s", req.path)
	}
	q, err := url.ParseQuery(req.query)
	if err != nil || q.Get("repo") != "acme/shop" || q.Get("branch") != "release/1.2" || len(q) != 2 {
		t.Errorf("query = %q", req.query)
	}
	if req.method != http.MethodDelete {
		t.Errorf("method = %s", req.method)
	}
	if got := h.stdout.String(); got != "unbound acme/shop@release/1.2: pushes no longer deploy App shop\n" {
		t.Errorf("stdout = %q", got)
	}
	h.api.on("DELETE /api/v1/git/bindings", 404, `{"error":{"code":"not_found","message":"No binding for acme/shop@nope"}}`)
	h.expect(ExitError, "git", "unbind", "acme/shop", "nope")
	if !strings.Contains(h.stderr.String(), "No binding for acme/shop@nope (HTTP 404)") {
		t.Errorf("stderr = %q", h.stderr.String())
	}
}

func TestGitUsageErrorsStayOffTheNetwork(t *testing.T) {
	h := newHarness(t).loggedIn()
	for _, args := range [][]string{
		{"git", "bind", "acme/shop", "main"},
		{"git", "bind", "shop", "main", "--app", "shop"},
		{"git", "bind", "acme/shop", "--app", "shop"},
		{"git", "bind", "acme/shop", "main", "--app", "../x"},
		{"git", "bind", "acme/shop", "main", "--app", "shop", "--port", "0"},
		{"git", "bind", "acme/shop", "main", "--app", "shop", "--port", "web"},
		{"git", "bind", "acme/shop", "main", "--app", "shop", "--build-node", "a/b"},
		{"git", "unbind", "acme/shop"},
		{"git", "unbind", "acme", "main"},
		{"git", "bindings", "extra"},
	} {
		h.expect(ExitUsage, args...)
	}
	if len(h.api.requests) != 0 {
		t.Fatalf("usage errors sent %d requests", len(h.api.requests))
	}
	h.expect(ExitUsage, "git")
	for _, want := range []string{"bindings", "bind <owner/repo> <branch> --app <app>", "unbind <owner/repo> <branch>"} {
		if !strings.Contains(h.stderr.String(), want) {
			t.Errorf("a bare `erainfra git` should list %q: %q", want, h.stderr.String())
		}
	}
	h.expect(ExitOK, "git", "bind", "--help")
	for _, want := range []string{"--build-node", "--deploy-node", "--port", "ERAINFRA_GH_WEBHOOK_SECRET"} {
		if !strings.Contains(h.stdout.String(), want) {
			t.Errorf("git bind --help lacks %q", want)
		}
	}
}
