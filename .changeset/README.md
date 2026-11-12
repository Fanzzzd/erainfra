# Changesets

Every pull request that changes a released package carries a changeset: a small Markdown file here that names the packages and the bump, and says in one or two sentences what changed for the people who run EraInfra. `changeset version` turns the pending files into CHANGELOG entries and the next version. CI fails a pull request that changes a released package without one.

```bash
pnpm changeset          # pick packages and bump, write the summary
pnpm changeset --empty  # the change has nothing to tell users (tests, CI, refactors)
```

## Which package to name

The product packages share one version and are always released together (`fixed` in `config.json`):

- `@erainfra/agent`
- `@erainfra/controller`
- `@erainfra/runtime`
- `@erainfra/backend`
- `@erainfra/dashboard`

Name the one closest to the change. Naming any of them bumps all of them, and the release copies the version to the root `package.json`, the mesh crate, the agent lockfile and `AGENT_RELEASE.version`. Code without its own package (`apps/infra-agent`, `apps/mesh`, `apps/cache-service`, `apps/erainfra-cli`, `deploy/`, `images/`) ships in the product, so name the closest product package for it too: `@erainfra/runtime` for host and guest work, `@erainfra/agent` for Node and Worker work.

Internal tooling (`@erainfra/release`, `@erainfra/typescript-config`) is ignored.

## Bump

The product is in `rc` prerelease mode (`pre.json`), so every bump produces the next `0.2.0-rc.N`. Choose the bump the change would deserve after 0.2.0: `patch` for fixes, `minor` for features, `major` for breaking changes to an installed Worker, Node or controller. Exiting prerelease mode (`pnpm changeset pre exit`) is a release decision.

## Writing the summary

Write for an operator reading the CHANGELOG, in the repository's plain style: what changed and what they will notice, with the issue number if there is one. One changeset per user-visible change; a pull request may carry several.

```markdown
---
"@erainfra/agent": patch
---

Stopping or upgrading a Worker agent waits for its running jobs instead of killing them (#284).
```

## Releasing

The release branch runs `GITHUB_TOKEN=$(gh auth token) pnpm release:version`, which runs `changeset version` and then `packages/release/bin/sync-product-version.ts`. The token lets the changelog link each entry to its pull request. [docs/releases.md](../docs/releases.md) covers the rest of the release process.
