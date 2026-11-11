# Releases

How a maintainer versions, tags and publishes EraInfra, and what each release contains. Released
versions are on the [releases page](https://github.com/Fanzzzd/erainfra/releases).

EraInfra is one product version: root, Agent, Controller, Runtime and `apps/mesh/Cargo.toml`
versions must match. Nobody edits them by hand. Pull requests carry changesets
([.changeset/README.md](../.changeset/README.md)), and the release branch runs
`GITHUB_TOKEN=$(gh auth token) pnpm release:version`. That runs `changeset version`, which bumps the
fixed product group and writes the CHANGELOGs, then copies the version to the root `package.json`,
the mesh crate, the agent lockfile and `AGENT_RELEASE.version`. Tagging `v<version>` runs the release workflow, revalidates the JavaScript and
Go surfaces (including both Linux architectures), rebuilds the agent archive, the Infra Agent
binaries and the `erainfra-mesh` binaries twice byte-for-byte, checks the deployment pin, attests
the artifacts, and publishes:

- `erainfra-agent-<version>.tar.gz` plus SHA-256;
- Controller binaries and SHA-256 sidecars for Linux/macOS x64/ARM64;
- Runtime binaries and SHA-256 sidecars for Linux x64/ARM64, plus the runtime and controller
  systemd units;
- `infra-agent-<os>-<arch>` binaries and SHA-256 sidecars for Linux and macOS x64/ARM64 and
  Windows x64, the five targets a Node can be;
- `erainfra-cache-service-linux-x86_64` and its SHA-256 sidecar: the cache service (ADR 0009),
  one Linux target because it is a server an operator deploys, not a binary every Node runs;
- `erainfra-<os>-<arch>` binaries and SHA-256 sidecars, the operator CLI, for the same five targets
  as the Infra Agent;
- `erainfra-mesh-<os>-<arch>` binaries and SHA-256 sidecars for the same five targets as the
  Infra Agent: the Node-to-Node sidecar on iroh that replaces dumbpipe (ADR 0016,
  [apps/mesh/README.md](../apps/mesh/README.md)). Linux builds are static musl binaries. Services
  require both fleet membership and explicit per-exposure `allowed_peers` grants; omitted or
  empty grants deny access. Nodes opt in with `/install --role node --mesh`. `AGENT_RELEASE.mesh`
  stays empty until the next authorized release, so that path refuses today. Until every Node has
  it, a link with an end that lacks the sidecar stays on legacy dumbpipe, which `portless links`
  marks `legacy-dumbpipe (unauthenticated)`; links move to the mesh as their Nodes upgrade, and
  `ERAINFRA_MESH_REQUIRE=true` on the Hub refuses the rest. See
  [docs/runbooks/secure-node-mesh.md](runbooks/secure-node-mesh.md).

A version containing a hyphen is published as a GitHub prerelease. Release assets are never
overwritten; a correction is a new version.

The other four parts of `AGENT_RELEASE` are pinned on the release commit, before the tag: `sha256` from
the deterministic archive, and `infraAgent`, `cacheService` and `controller` from
`pnpm --filter @erainfra/release build-go-assets` followed by
`pnpm --filter @erainfra/backend print-infra-agent-pin`,
`pnpm --filter @erainfra/backend print-cache-service-pin` and
`pnpm --filter @erainfra/backend print-controller-pin`, which read the digests out of the sidecars so
nobody transcribes them by hand. The workflow refuses to publish a tag whose pin disagrees with the
bytes it just built, or whose Infra Agent, cache-service or controller pin covers only some of its
targets. The controller pin covers the two Linux targets the installer serves; the macOS controller
binaries are published but not pinned. Pinned binaries are stamped with the version only, never the
commit, so a digest does not depend on the commit it is written into.

`AGENT_RELEASE.mesh` is pinned the same way, with one difference: the macOS and Windows sidecars
build on their own runners, so no single machine can produce all five. Run the release workflow by
hand (Actions, EraInfra release, Run workflow) on the commit you are about to pin. That run builds
the five `erainfra-mesh` assets and publishes nothing. The pin commit itself changes no sidecar
source, so its digests carry over to the tag; any change under `apps/mesh` between that run and
the tag invalidates them. The run's artifacts expire after a day. Collect them in one directory
and print the pin:

```bash
gh run download <run-id> --pattern 'mesh-*' --dir dist/mesh-pin
mv dist/mesh-pin/mesh-*/* dist/mesh-pin/
pnpm --filter @erainfra/backend print-mesh-pin dist/mesh-pin
```

The tag run rebuilds the sidecars and refuses to publish if any digest differs from the pin or a
target is missing. On main the map is empty, and `/install --role node --mesh` refuses until a
release pins it.
