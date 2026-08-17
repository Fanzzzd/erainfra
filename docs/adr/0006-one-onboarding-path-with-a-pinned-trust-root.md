# ADR 0006: One onboarding path, with a pinned trust root

- Status: Accepted
- Date: 2026-08-17
- Owners: EraInfra

## Context

[ADR 0004](0004-portless-is-a-feature-not-a-second-product.md) requires the infrastructure-management
surface to converge on the platform's guarantees. Onboarding is where the two surfaces diverge most,
and the divergence is a real security gap rather than a cosmetic one.

**Worker onboarding today.** The dashboard's _Machines → Add machine_ generates a command. The
control plane serves the script at `/install` (`convex/http.ts:261`), rendered with `AGENT_RELEASE`
so the version and SHA-256 are baked into the script itself. The bytes come from the GitHub Release
(`convex/installScript.ts:329`). The installer verifies SHA-256 against both the published and the
deployment-pinned value and refuses to install on mismatch.

**Node onboarding today.** `curl https://<hub>/agent.sh | sudo sh` downloads
`$HOSTBASE/agent-bin/portless-agent-<target>` from the customer's own hub, then `chmod +x` and runs
it. There is **no integrity check of any kind** — grepping `deploy/agent.sh` for
`sha256`/`shasum`/`checksum` returns nothing. The binary is cross-compiled ad hoc on the hub box by
`deploy/build-agents.sh`, so it is not reproducible, not attested, and has no rollback. The systemd
unit it installs has no `User=`, so this unverified binary runs as root.

`deploy/build-agents.sh` states an intentional design goal that must be preserved: "Self-hosted: the
hub serves these — no Docker Hub, no third-party release host." Air-gapped and self-contained
installs are a feature, not an accident.

## Decision

**For the payload, the trust root is the pinned SHA-256, not the transport.** Once the checksum is
pinned in the control plane and the installer refuses on mismatch, the byte source does not need to
be trusted. Unifying the onboarding path and preserving self-contained distribution are therefore
not in conflict.

**That claim covers the payload only, and the scope matters.** The digest cannot protect the
`/install` script itself, because the script is what carries the digest and runs the verification.
A tampered script can drop the check, or execute anything at all, before a single byte of the
archive is fetched — and it runs under `sudo`. So the bootstrap has a second trust root that has to
be named rather than implied:

- **TLS to the control plane's own origin is a requirement, not a detail.** `/install` is served
  from the deployment's origin (`http.ts:261`) over HTTPS, and the installer must be fetched that
  way. `curl` without `-f`, over plain HTTP, or through a redirect to another host is not the
  supported path.
- **`--source` moves the payload's origin, never the script's.** An air-gapped install still
  bootstraps from a script obtained over TLS (or copied deliberately by an operator); pointing
  `--source` at a hub mirror or a local file is safe precisely because the verification logic
  arrived by the trusted path and the expected digest is baked into it.
- **This asymmetry is the same one the Worker path already lives with**, so it is not a regression
  introduced here — but the Worker path never wrote it down either. Signing the installer, or
  publishing a separately pinned verifier that the one-liner fetches first, is the way to remove the
  asymmetry rather than document it. That is deliberately out of scope here and worth its own ADR;
  what is in scope is not overstating what the digest buys.

One onboarding path:

- **One surface.** The dashboard's _Add machine_ flow onboards both machine kinds, with the role
  selected there. The separate Node-add flow in the old Portless web app is absorbed.
- **One endpoint.** `/install` serves both roles (`--role`), rendered with the pinned version and
  checksum for both agents.
- **One trust root.** `AGENT_RELEASE` extends to cover both agents' artifacts. Both move together,
  which is what the one-product-version rule already requires.

  **Per-role artifacts, not one combined archive.** The two agents are shaped differently and
  combining them would be worse for both: the Action Runner Agent is one
  `erainfra-agent-<version>.tar.gz` that every Worker installs identically with `npm install`, while
  the Infra Agent is a single static Go binary that must be selected per platform —
  `infra-agent-<os>-<arch>[.exe]`, five targets including `windows/amd64`, which the existing
  `agent.ps1` path already requires. One combined archive would make every Node download four
  binaries it cannot run.

  So `AgentRelease` keeps its existing scalar `sha256` for the archive and gains a **map** keyed by
  target for the binaries. The extension is additive, which is what lets the entire Worker path —
  `release.yml`'s verification block, `http.ts`, `installScript.ts` and its tests — keep working
  untouched:

  ```ts
  export type AgentRelease = {
    repo: string;
    version: string;
    /** SHA-256 of `erainfra-agent-<version>.tar.gz` — the Action Runner Agent. */
    sha256: string;
    /** SHA-256 of `infra-agent-<os>-<arch>[.exe]`, keyed by target. */
    infraAgent: Record<string, string>;
  };
  ```

  `--role worker` selects the archive and verifies against `sha256`; `--role node` resolves the
  host's target, selects that binary, and verifies against `infraAgent[target]`. Both paths must be
  covered by tests, including the refusal case — a verification path whose failure branch is untested
  is a verification path nobody has seen work.

- **Pluggable bytes.** GitHub Release by default; a hub mirror or a local file via an explicit
  source override for air-gapped installs. Verification is identical in every case.

Retired: unverified download, and ad-hoc hub-side compilation as the _only_ source of the binary.

**Correction.** An earlier version of this ADR stated that retiring hub-side compilation also
retires the `docker run -v "$REPO":/srv/portless` bind mount. That is only half true. The mount has
two jobs, and dropping the build only removes one of them: `deploy/hub.sh:71-74` starts the Hub with
`-w /srv/portless … node --experimental-strip-types apps/api/src/server.ts`, so the Hub process
**runs from the mounted source tree**. Removing the mount therefore requires packaging the Hub as a
self-contained bundle or image, which is required work rather than a free consequence of this ADR.

Preserved: the one-command `curl … | sh` experience, and the hub's ability to serve the bytes.

## Consequences

- **Do not proxy release binaries through Convex.** #32 and #39 brought `tryAssign`,
  `pendingAttempts` and `reconcile.run` from GB-scale to MB-scale
  (`docs/runbooks/deploy-control-plane.md:51`). Serving a multi-megabyte binary per install through
  Convex would reintroduce exactly that cost. `@convex-dev/static-hosting`
  (`convex/convex.config.ts:7`) is wired for the dashboard SPA and is not a release-artifact CDN.
  The control plane serves the script and the checksum; it does not serve the payload.
- Emergency Node fixes now require a release rather than a `build-agents.sh` run on the hub. This is
  the price of verifiability, and it is the same price the Worker path already pays.
- The Infra Agent binary must be built by CI and published in the release. This also repairs the
  asymmetry ADR 0004 identified: the release currently gates on Portless while shipping none of it.
- Ordering is load-bearing: **the new verified path must work before any part of `deploy/` is
  removed.** A stage that deletes the old installer before the new one is provable would leave no
  way to onboard a Node.
- Running the Infra Agent as root is out of scope here but now visible: adding `User=` is a separate
  change that needs its own evaluation, since host operations such as `systemctl` currently assume
  root.

## Alternatives considered

**Keep the hub as the sole distributor and just add a checksum.** Smaller change, and it preserves
air-gap trivially. Rejected as the end state because the checksum would attest a binary the hub
compiled itself, which proves integrity of transport but not provenance of the build — the Worker
path's reproducible double-build and attestation are the property worth extending.

**Proxy binaries through the control plane so there is literally one host.** Rejected on the
bandwidth grounds above. It also makes the control plane a hard dependency for every install, which
is worse for air-gapped operation than the pluggable-source design.
