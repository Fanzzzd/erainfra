# The control plane on Cloudflare

This directory runs the backend's unmodified Convex functions on Cloudflare (ADR 0019). One Durable
Object holds the whole control plane in SQLite. A Worker in front serves the dashboard's static
files and sends everything else to the object. `@erainfra/platform` holds the implementation.

Production still runs on Convex. The Cloudflare platform has not run a real Profile yet, and the
dashboard and the Action Runner Agent cannot use it until the client port (phase 3) lands.

## Files

- `worker.ts`: the Worker entry. It passes the backend's modules, schema and `auth.config.ts` to
  `createControlPlane`.
- `modules.generated.ts`: one import per backend module. Workers cannot list files at run time.
  Run `pnpm generate:cloudflare` after adding or removing a file in `convex/`. CI fails when the
  list is stale.
- `wrangler.jsonc`: the Durable Object, the R2 bucket for `ctx.storage`, and the dashboard assets.

## Run it locally

Build the dashboard first (`pnpm --filter @erainfra/dashboard run build`). Then put the secrets in
`cloudflare/.dev.vars`, which Git ignores:

```sh
JWT_PRIVATE_KEY="-----BEGIN PRIVATE KEY----- ..."
JWKS='{"keys":[...]}'
SITE_URL="http://localhost:8799"
BOOTSTRAP_SECRET="..."
```

Quote `JWKS` with single quotes. Wrangler does not unescape `\"` inside double quotes, and the
host then fails to parse the key set. Start the Worker:

```sh
pnpm exec wrangler dev -c cloudflare/wrangler.jsonc --port 8799 --local \
  --var CONVEX_SITE_URL:http://localhost:8799
```

`CONVEX_SITE_URL` is the JWT issuer, so it must match the URL clients use.

## Deploy

`pnpm deploy:cloudflare` needs a Cloudflare account on the Workers Paid plan. Set the same
variables with `wrangler secret put`, and set `CONVEX_SITE_URL` to the Worker's public URL.
