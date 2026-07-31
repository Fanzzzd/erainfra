# runner-center — self-hosted GitHub Actions runner control plane on Convex

Open-source. Machines have NO public IP: they connect OUT to Convex via WebSocket
subscription. GitHub webhooks hit Convex HTTP actions (public). Convex is the
scheduler. Runners are ephemeral via GitHub JIT config — one job, one clean
environment, destroyed after.

## Monorepo layout (pnpm workspace, Node 22, TypeScript everywhere)

```
runner-center/
├── package.json            # thin workspace root: turbo, oxlint, oxfmt
├── turbo.json              # task graph: build, typecheck, codegen, dev, deploy
├── pnpm-workspace.yaml     # packages: ["apps/*", "packages/*"] + dependency catalog
├── .oxlintrc.json          # oxlint config (linting)
├── .oxfmtrc.json           # oxfmt config (formatting)
├── packages/backend/       # @runner-center/backend — the Convex deployment
│   ├── convex.json
│   ├── .env.local          # CONVEX_DEPLOYMENT (untracked)
│   ├── scripts/            # print-install-script.ts
│   └── convex/
│       ├── schema.ts
│       ├── auth.ts         # @convex-dev/auth, Password provider only
│       ├── http.ts         # POST /github/webhook
│       ├── github.ts       # internal action: issueJit (calls GitHub REST)
│       ├── scheduler.ts    # internal mutation: tryAssign
│       ├── machines.ts     # queries/mutations for machines (dashboard + agent)
│       ├── jobs.ts         # queries/mutations for jobs
│       └── agentApi.ts     # agent-facing: pendingCommands query, claim/report mutations, heartbeat
├── packages/typescript-config/  # shared tsconfig presets: base, node, react
├── apps/dashboard/         # Vite + React 19 + TanStack Router + shadcn/ui + convex/react
│                           # imports the API via `@runner-center/backend/api`
└── apps/agent/             # Node daemon: ConvexClient subscription + execa → provisioner
    │                       # standalone on purpose: installed by machines with plain
    │                       # `npm install`, so no workspace:/catalog: protocols here
    └── provisioners/
        ├── provision-linux.sh
        ├── provision-mac.sh      # stub OK for v1 (echo "not implemented" && exit 1)
        └── provision-win.ps1     # stub OK for v1
```

## Schema (packages/backend/convex/schema.ts)

```ts
machines: defineTable({
  name: v.string(),
  os: v.union(v.literal('linux'), v.literal('mac'), v.literal('win')),
  labels: v.array(v.string()),        // e.g. ["self-hosted","rc-linux"]
  maxSlots: v.number(),
  usedSlots: v.number(),
  lastSeen: v.number(),               // Date.now() at heartbeat
  token: v.string(),                  // random 32-hex; agent auth. v1: plaintext is OK.
}).index('by_token', ['token']),

jobs: defineTable({
  ghJobId: v.number(),
  repo: v.string(),                   // "owner/name"
  workflowName: v.string(),
  labels: v.array(v.string()),
  status: v.union(v.literal('queued'), v.literal('assigned'),
                  v.literal('running'), v.literal('done'), v.literal('failed')),
  machineId: v.optional(v.id('machines')),
  runnerName: v.optional(v.string()), // "rc-<machine>-<ghJobId>"
  queuedAt: v.number(), startedAt: v.optional(v.number()), finishedAt: v.optional(v.number()),
  conclusion: v.optional(v.string()),
}).index('by_status', ['status']).index('by_ghJobId', ['ghJobId']),

commands: defineTable({
  machineId: v.id('machines'),
  jobId: v.id('jobs'),
  jitConfig: v.optional(v.string()),  // cleared after agent claims
  runnerName: v.string(),
  status: v.union(v.literal('pending'), v.literal('claimed'), v.literal('finished')),
  exitCode: v.optional(v.number()),
}).index('by_machine_status', ['machineId', 'status']),
```

## Flow

1. **Webhook** `POST /github/webhook` (convex/http.ts, httpAction):
   - Verify `X-Hub-Signature-256` HMAC-SHA256 with env `GITHUB_WEBHOOK_SECRET`
     (use Web Crypto — `crypto.subtle`, available in Convex runtime; timing-safe compare).
   - Only event `workflow_job`. action=queued → insert job (status queued) IF
     labels contain "self-hosted", then schedule tryAssign. action=in_progress →
     match by_ghJobId → status running, startedAt. action=completed → status
     done/failed by conclusion, free machine slot (usedSlots-1), mark command
     finished, schedule tryAssign (a slot freed).
   - Return 200 fast; all logic in mutations via ctx.runMutation.
2. **tryAssign** (internal mutation): for each queued job (oldest first), find
   machine where job.labels ⊆ [..."self-hosted", machine.labels] and
   usedSlots < maxSlots and lastSeen within 120s. If found: usedSlots+1,
   job → assigned, create runnerName `rc-${machine.name}-${ghJobId}`, insert
   command (pending, no jit yet), schedule issueJit action.
3. **issueJit** (internal action, "use node"): octokit
   `POST /repos/{owner}/{repo}/actions/runners/generate-jitconfig` with
   { name: runnerName, runner_group_id: 1, labels: job.labels } using env
   `GITHUB_PAT`. Write encoded_jit_config into the command. On failure:
   revert assignment (job → queued, slot back, command deleted) and log.
4. **Agent** (apps/agent, single index.ts ~150 lines):
   - env/config: CONVEX_URL, MACHINE_TOKEN. Uses `ConvexClient` from "convex/browser".
   - `client.onUpdate(api.agentApi.pendingCommands, { token }, cb)` — for each
     pending command: call claim mutation (returns jitConfig, atomically flips
     status→claimed and clears jitConfig from doc), then spawn
     `provisioners/provision-<os>.sh` with env JIT_CONFIG + RUNNER_NAME via execa,
     await exit, call report mutation (exitCode).
   - Heartbeat mutation every 30s (updates lastSeen). Machine identified by token.
   - Concurrency: run up to (maxSlots) provisions concurrently; simple in-process
     counter is fine.
5. **provision-linux.sh**:
   ```bash
   #!/usr/bin/env bash
   set -euo pipefail
   # Official runner image; pin the tag the implementer verifies exists on ghcr.
   exec docker run --rm --name "$RUNNER_NAME" \
     ghcr.io/actions/actions-runner:2.328.0 \
     ./run.sh --jitconfig "$JIT_CONFIG"
   ```
   (Verify the current tag with `docker manifest inspect` or use a known-good
   recent tag; do NOT use :latest.)

## Dashboard (apps/dashboard)

- Vite + React + TypeScript, TanStack Router (file-based routes), shadcn/ui
  (init with defaults, dark mode class strategy), Tailwind v4.
- Convex Auth (@convex-dev/auth) Password provider; unauthenticated → /login.
- Routes:
  - `/` Machines: table (name, os, labels, slots used/max, online badge by
    lastSeen<120s, current jobs). "Add machine" dialog → creates machine with
    random token, shows token + one-line agent install command once.
  - `/jobs` Jobs: table (repo, workflow, labels, status badge, machine, timing),
    newest first, live via useQuery.
  - `/login`.
- All queries require auth (ctx.auth.getUserIdentity()) EXCEPT agentApi.* which
  auth by machine token arg. Webhook is signature-verified.

## Static hosting (dashboard served BY Convex)

Use the official component `@convex-dev/static-hosting` (v0.2.x):

- `packages/backend/convex/convex.config.ts`: `defineApp({ httpPrefix: "/api" })` +
  `app.use(staticHosting, { httpPrefix: "/" })` — static site owns `/`,
  our http.ts routes are served under `/api`. So the GitHub webhook URL is
  `https://<deployment>.convex.site/api/github/webhook` (http.ts still
  declares path `/github/webhook`).
- `packages/backend` script `deploy` runs `static-hosting deploy` with
  `--dist ../../apps/dashboard/dist`, and builds the dashboard first via
  `--build-command`. `pnpm deploy` at the root forwards to it.
- Dashboard is then live at `https://<deployment>.convex.site`. No GitHub
  Pages / Vercel needed.

## Env vars (Convex deployment)

GITHUB_WEBHOOK_SECRET, GITHUB_PAT (classic, repo scope, must be repo admin).

## Acceptance (implementer must ensure)

- `pnpm install` clean; `pnpm convex dev --once` typechecks & pushes;
  `pnpm build` (turbo: dashboard + agent) and `pnpm check` (oxlint, oxfmt,
  typecheck) pass.
- No `any` leaks in public function args; Convex validators on every function.
- README.md at root: what it is, architecture ASCII diagram, setup steps
  (convex deploy, env vars, GitHub webhook creation, add machine, run agent),
  MIT license file.
- Do NOT invent packages; use: convex, @convex-dev/auth, @auth/core, octokit
  (or @octokit/request), execa, @tanstack/react-router, tailwindcss, shadcn deps.
- Do NOT touch anything outside /Users/fanzhende/code/personal/runner-center.

```

```
