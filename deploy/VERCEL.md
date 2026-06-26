# Hosting the mesh installer on Vercel (no domain needed)

You don't need a domain for the mesh. Vercel gives you a stable public URL
(`https://<project>.vercel.app`) and that's all the one-liner needs.

**What runs on Vercel:** only the **installer** (`/mesh-node.sh`) + a small landing page. That's a
pure stateless request→response — a perfect serverless fit.

**What does NOT run on Vercel:** the Portless control-plane API. It spawns and holds long-running
`dumbpipe`/`cloudflared` child processes and keeps on-disk state — impossible on serverless. But
the **mesh itself needs none of that**: links are peer-to-peer over iroh (tickets + relay), so the
installer URL is the whole story. Run the full dashboard/API on a real box only if you want it (see
`deploy/install.sh`).

## Deploy

1. Push this repo to GitHub.
2. Vercel → **Add New Project** → import the repo.
3. **Root Directory = `.`** and **Framework Preset = `Other`**. Vercel may auto-guess "Turborepo"
   from `turbo.json` — that's fine (the root `vercel.json` overrides the build), but selecting
   `Other` avoids any doubt. Don't override the Build/Install commands in the UI; `vercel.json` sets
   them to no-ops on purpose (this is a static + function deploy, **not** a monorepo build).
4. Deploy.

`vercel.json` serves `public/index.html` statically and routes `/{mesh-node,registry,image}.sh` to
the `api/installer.js` function, which returns the matching `deploy/*.sh` with the deployment's base
URL templated into the `<hub>` placeholder (so the commands the scripts print point back at your
Vercel URL — even on a custom domain, because it reads the request Host).

### Verify after deploy

```bash
curl -fsSL https://<project>.vercel.app/mesh-node.sh | head -5   # should be the shell script, not 404
```

### Troubleshooting

- **Build fails right after "Vercel CLI …":** an Install/Build Command has a shell-syntax issue.
  The committed `vercel.json` uses plain no-ops (`echo no build needed`) — don't put parentheses or
  other shell metacharacters in those commands (`echo foo (bar)` is a shell syntax error).
- **`/mesh-node.sh` returns 500 "not available":** the function didn't bundle `deploy/*.sh`. Confirm
  `functions["api/installer.js"].includeFiles` is `"deploy/*.sh"` and the files exist in the repo.
- **Vercel tries to run `turbo build`:** set Framework Preset to `Other` in Project Settings → General.

## Use it

```bash
# on the box with the service:
curl -fsSL https://<project>.vercel.app/mesh-node.sh | sh -s -- share 5432
# on the box that needs it (paste the ticket the line above prints):
curl -fsSL https://<project>.vercel.app/mesh-node.sh | sh -s -- connect <ticket> 15432
```

No domain, no Cloudflare Access, no public IP on either box. Links default to iroh's public relay
(no signup); set `IROH_RELAY_URL` on a node to use your own relay.
