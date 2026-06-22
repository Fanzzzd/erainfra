# Portless — Handover

_Last updated: 2026-06-22_

Dashboard-first **private PaaS for machines with no public IP** (Cloudflare Tunnel ingress,
WireGuard/Netmaker fabric, Nomad/Consul, Go node-agent, shadcn dashboard).

- **Location:** `~/code/personal/portless` (flattened 2026-06-22 from the old `portless-pack/portless`
  zip-extraction nesting).
- **Not a git repo yet.** `git init` when you want history.

---

## Run it

```bash
cd ~/code/personal/portless
pnpm install      # first time
pnpm dev          # turbo: API (:8787) + dashboard (Vite :5173) in parallel
```

Open the dashboard, e.g. **http://localhost:5173**. In dev mode the client auto-uses the bundled
`owner-dev-token`, so it shows **"API connected"**.

**Run it in your own terminal** — background servers spawned by an AI tool get reaped in this
environment (SIGTERM 143/144); only a plainly-launched process stays up.

Port note: Vite defaults to **:5173**, which collides with other Vite apps (e.g. the freight-optimizer
work project). Run one at a time, or `pnpm --filter @portless/web dev -- --port 4173`.

---

## Tooling — pnpm + turborepo

- pnpm workspace (`pnpm@9.15.0`, `pnpm-workspace.yaml` = `apps/*`, `packages/*`). Members:
  `@portless/api`, `@portless/web`, `@portless/core`. The Go agent (`agents/node-agent`) is **not** a
  pnpm member.
- **turbo 2.9.18** (`turbo.json`). Root scripts:
  - `pnpm dev` → `turbo run dev` (api `node … server.ts` + web `vite`, parallel; `core` has no dev)
  - `pnpm build` → `turbo run build` (web → `dist/**`, cached)
  - `pnpm typecheck` → `turbo run typecheck` (api + web `tsc --noEmit`)
  - `pnpm test` → `turbo run test` (api + core node tests, after typecheck) **+** `go test ./...`

---

## Current state (verified)

- **92 hermetic API tests + core tests + Go agent tests** green; api+web typecheck + web build clean.
- Dashboard pages (all render clean, 0 console errors): **Overview, Projects, Apps, Orchestrate,
  Cloudflare, Machines, Fabric**. Nav is URL-hash based (reload-safe, deep-linkable: `#projects/<id>`).
- **Projects** = declarative spec + topology (master-detail). Add/remove **domains**; optionally
  auto-route a domain via a real Cloudflare tunnel (confirm-gated). `project.delete` (confirm+audited).
- **Apps** = real local processes (LocalRuntime): deploy → serves HTTP → logs → stop → **clear**
  (`local.forget`). Dogfooded end-to-end.
- **Machines** = enroll without roles (name+region+real WG pubkey), assign roles after (multi-role);
  real `NetmakerNetworkProvider` allocates `10.88.0.x` + `10.210.x.0/24`.
- **Cloudflare** = real `cloudflared` wrapper (reuses `~/.cloudflared/cert.pem`); lists tunnels,
  create tunnel / route DNS gated by type-to-confirm.
- **Orchestrate** = run local `codex` / `claude` CLIs (plan safe, execute type-to-confirmed, audited).
- Persistence: imported projects + enrolled machines survive an API restart (atomic writes; tests stay
  hermetic via a `--test` execArgv guard). Real RBAC + bearer auth + durable audit + dangerous-op envelope.

---

## Known gaps / deliberately deferred

- **Full session/cookie auth** — dashboard uses a browser bearer token (dev posture; the prod bundle
  ships **no** token and fails closed). Real session auth is a design decision, not in-flight work.
- **Infra-gated milestones** — Nomad/Temporal/real Netmaker/WireGuard/Postgres are interface+mock by
  design (can't stand up on a laptop). Seams exist (`NetworkProvider`, `NomadProvider`, etc.).
- `project.delete` / `removeDomain` do **not** tear down the Cloudflare DNS a domain routed (deliberate —
  harder to undo; left to the user).
- Re-serializing a spec on domain add/remove canonicalizes it (drops YAML comments + unmodeled keys —
  already inert since Zod strips unknown keys at import).

---

## Gotchas (read before editing)

- **`vite preview` serves the PROD build, which ships no auth token** → "API offline". For a local
  prod-like server, build with `VITE_PORTLESS_TOKEN=owner-dev-token vite build`. The **dev** server
  (`vite`) auto-uses the token. Proxy is wired for both (`server.proxy` + `preview.proxy`).
- **`codex exec` / `claude -p` hang on an open stdin** → always redirect `< /dev/null`.
- **TS parameter properties** (`constructor(private x)`) break `node --experimental-strip-types` —
  use explicit fields.
- **Do NOT live-test Cloudflare create/routeDns** — they mutate the user's real CF account. The
  tunnel-verify path only *reads* (`tunnels()`); verify gates by rejecting a bogus tunnel name.
- Tests are **hermetic** (in-memory stores, no Postgres/Nomad). Keep them zero-infra.
- Review substantive changes with **Codex** (`codex exec --skip-git-repo-check --sandbox read-only …`).

---

## Suggested next steps

1. `git init` + first commit (no history yet).
2. Pin web `dev` to a non-5173 port if you routinely run it alongside other Vite apps.
3. Decide on real auth (session/cookie) — the one substantive deferred feature.
4. Wire live infra adapters (Nomad/Consul/Netmaker/WG) when an environment exists.
