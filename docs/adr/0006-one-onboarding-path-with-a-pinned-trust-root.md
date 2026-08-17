# ADR 0006: One onboarding path, with the checksum as the only trust root

- Status: Accepted
- Date: 2026-08-17
- Owners: EraInfra

## Context

[ADR 0004](0004-portless-is-a-feature-not-a-second-product.md) requires the infrastructure-management
surface to converge on the platform's guarantees. Onboarding is where the two surfaces diverge most,
and the divergence is a real security gap rather than a cosmetic one.

**Worker onboarding today.** The dashboard's *Machines → Add machine* generates a command. The
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

**The trust root is the pinned SHA-256, not the transport.** Once the checksum is pinned in the
control plane and the installer refuses on mismatch, the byte source does not need to be trusted.
Unifying the onboarding path and preserving self-contained distribution are therefore not in
conflict.

One onboarding path:

- **One surface.** The dashboard's *Add machine* flow onboards both machine kinds, with the role
  selected there. The separate Node-add flow in the old Portless web app is absorbed.
- **One endpoint.** `/install` serves both roles (`--role`), rendered with the pinned version and
  checksum for both agents.
- **One trust root.** `AGENT_RELEASE` extends to cover both agents' artifacts. Both move together,
  which is what the one-product-version rule already requires.
- **Pluggable bytes.** GitHub Release by default; a hub mirror or a local file via an explicit
  source override for air-gapped installs. Verification is identical in every case.

Retired: unverified download, and ad-hoc hub-side compilation as the *only* source of the binary.

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
