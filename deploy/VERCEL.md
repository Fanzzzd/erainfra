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
2. Vercel → **Add New Project** → import the repo. Keep **Root Directory = `.`** (the root
   `vercel.json` drives everything; no framework, no build).
3. Deploy. Done — there's nothing to configure.

`vercel.json` serves `public/index.html` statically and routes `/mesh-node.sh` to the
`api/mesh-node.js` function, which returns `deploy/mesh-node.sh` with the deployment's own URL
templated in (so the `connect` line it prints points back at your Vercel URL).

## Use it

```bash
# on the box with the service:
curl -fsSL https://<project>.vercel.app/mesh-node.sh | sh -s -- share 5432
# on the box that needs it (paste the ticket the line above prints):
curl -fsSL https://<project>.vercel.app/mesh-node.sh | sh -s -- connect <ticket> 15432
```

No domain, no Cloudflare Access, no public IP on either box. Links default to iroh's public relay
(no signup); set `IROH_RELAY_URL` on a node to use your own relay.
