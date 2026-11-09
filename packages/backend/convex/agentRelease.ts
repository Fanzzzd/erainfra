export type AgentRelease = {
  /** `owner/name` of the repository whose releases carry the packaged agent. */
  repo: string;
  /** Product version, without the leading `v` of the git tag. */
  version: string;
  /** SHA-256 of `erainfra-agent-<version>.tar.gz` — the Action Runner Agent, which a Worker runs. */
  sha256: string;
  /**
   * SHA-256 of `infra-agent-<os>-<arch>[.exe]` — the Infra Agent, which a Node runs — keyed by
   * target: `linux-x86_64`, `linux-arm64`, `darwin-x86_64`, `darwin-arm64`, `windows-x86_64`.
   *
   * Five artifacts rather than one, because a Node is any box a customer owns and one combined
   * archive would make every Node download four binaries it cannot run. A map, not a second
   * scalar, for the same reason.
   */
  infraAgent: Record<string, string>;
  /** SHA-256 of erainfra-mesh-<target>[.exe], one per target; v0.2.0-rc.11 was the first release to publish them. */
  mesh: Record<string, string>;
  /**
   * SHA-256 of `erainfra-cache-service-<target>` — the cache service (ADR 0009), keyed by target:
   * `linux-x86_64`.
   *
   * One target, not the Infra Agent's five: the cache service is a server an operator deploys on
   * infrastructure they control, not a binary that must run on every customer box. Still a map
   * rather than a scalar, so the same coverage and pin-match gates iterate it verbatim, and so a
   * second target (an arm host) is a data change, not a shape change.
   */
  cacheService: Record<string, string>;
  /**
   * SHA-256 of `runner-center-controller-<target>` — the scale-set controller, which
   * `/install --role controller` puts on a controller host or a Worker host — keyed by target:
   * `linux-x86_64`, `linux-arm64`.
   *
   * Linux only, although the release also publishes macOS controller binaries: the installer writes
   * a systemd unit, so a macOS controller is run by hand and nothing here would verify it. Both
   * Linux CPUs, because a small always-on VM is as likely to be an ARM instance as an x86 one.
   */
  controller: Record<string, string>;
};

/**
 * The agent build this deployment installs.
 *
 * EraInfra ships as one product: tagging `v<version>` publishes an immutable
 * `erainfra-agent-<version>.tar.gz` asset, and machines install
 * exactly that asset. Nothing tracks a branch, so a machine installed today and
 * a machine installed next month run identical bytes.
 *
 * This constant is the fleet's rollout pointer. The deterministic packager
 * makes the archive checksum available before tagging, so the release commit
 * pins it here and the tag workflow refuses to publish different bytes. Deploy
 * only after the matching release asset exists; rolling the fleet back is the
 * same edit with the previous release values. Because the install script is
 * served by this deployment over TLS, `sha256` is a trust root outside the
 * release itself, so an archive that matches the release but not this pin is
 * rejected.
 *
 * `infraAgent` is the same pin for the Node side, and the trust root that replaces the Infra
 * Agent's unverified download. v0.2.0-rc.6 was the first release to publish those binaries, and
 * every release since carries the pin: the five digests are generated from the sidecars with
 * `pnpm --filter @erainfra/backend print-infra-agent-pin` rather than typed by hand, and the
 * release workflow refuses to publish a tag whose pin disagrees with the bytes it just built.
 * Every target `INFRA_AGENT_TARGETS` names has to be covered — a pin missing one platform would
 * leave that platform installing bytes nothing vouches for, so the tag gate rejects a partial map
 * rather than an empty one.
 */
export const AGENT_RELEASE: AgentRelease = {
  repo: "Fanzzzd/erainfra",
  version: "0.2.0-rc.13",
  // Filled at v0.2.0-rc.11, the first release to publish erainfra-mesh, from the sidecars the
  // release workflow's mesh jobs wrote after building each target twice and comparing.
  mesh: {
    "linux-x86_64": "3b92d56697c2e401ad280d59029c46f78501151e68a51167e50e6c2ff226ae83",
    "linux-arm64": "23f5ef151a95dd0cf9f56c67a61f301ff0c616b796801284579705212282c2f3",
    "darwin-x86_64": "faf8543ac5779447ae8c0a9ac1ecf9b58bf85a6b077c7fcbde071ab77add48c2",
    "darwin-arm64": "4900fb421c0d4abd09ff7209cc643f04fef8fb0abec1b6b7020a8509795d6a8f",
    "windows-x86_64": "fe8960490eef00295acb238ee2e1f684f56c94d39a2da3af83880de463a34b81",
  },
  sha256: "9fa5e183410358aaba73a63b24a6227c8513c8de07f2cbe2bd36fc8bd7914483",
  infraAgent: {
    "linux-x86_64": "f31774f49c249e1c9138190dd1ed13c17fec6d3f387020b0a7793157e0ebea76",
    "linux-arm64": "16f76fe875b2c3d97bd32560e3e85464d8d16e9528d2f4c74637cf8d958aeb5c",
    "darwin-x86_64": "e9fd63b5f352f818a811974331426a7b274bcffc5f0af01dfa73f47958835875",
    "darwin-arm64": "dcca3c50ac7fcd832fb21418b5af8d7d426a56e607140ce41bf993a517d36a18",
    "windows-x86_64": "78a9990d5083334d2b4ee8dd9f530d020d942a80904805c5df144e37801b2368",
  },
  // Populated at v0.2.0-rc.9, the first release to publish the cache-service binary (ADR 0009),
  // exactly as `infraAgent` was filled at v0.2.0-rc.6. Version-only, so the digest is a pure
  // function of source and version, not the release commit it is written into.
  cacheService: {
    "linux-x86_64": "47bc9aff747fce1edec672b3e378b8bf5bc01e09d508a51eaed6d654dd77446b",
  },
  // Filled at v0.2.0-rc.11, the first release to build the controller version-only (rc.10 and
  // earlier stamped -X main.commitSHA, so no digest of theirs can be pinned), exactly as
  // `infraAgent` was at rc.6 and `cacheService` at rc.9.
  controller: {
    "linux-x86_64": "53c1616546d9a6127f6082371d6c76d19467c3140d8b1c9c482049a4d044c098",
    "linux-arm64": "8ec8fd60fd15f16ea95a5403d1d6b2a9ac810287bbc5a90c2fe122955ead11ed",
  },
};

/** The targets a release publishes an Infra Agent binary for, and `infraAgent` must cover. */
export const INFRA_AGENT_TARGETS = [
  "linux-x86_64",
  "linux-arm64",
  "darwin-x86_64",
  "darwin-arm64",
  "windows-x86_64",
] as const;

/** The published asset name for a target. Windows is the only one that carries an extension. */
export function infraAgentAssetName(target: string) {
  return `infra-agent-${target}${target.startsWith("windows-") ? ".exe" : ""}`;
}

/**
 * The targets a release publishes an `erainfra-mesh` binary for (ADR 0016), the Node-to-Node
 * sidecar that replaces dumbpipe. The same five as the Infra Agent, because every Node runs both.
 *
 * `AgentRelease.mesh` covers these targets; --mesh installation and tag publication reject a
 * missing or incomplete pin.
 */
export const MESH_TARGETS = INFRA_AGENT_TARGETS;

/** The published asset name for a mesh target. Windows is the only one that carries an extension. */
export function meshAssetName(target: string) {
  return `erainfra-mesh-${target}${target.startsWith("windows-") ? ".exe" : ""}`;
}

/** The targets a release publishes a cache-service binary for, and `cacheService` must cover. */
export const CACHE_SERVICE_TARGETS = ["linux-x86_64"] as const;

/** The published asset name for a cache-service target. Linux-only, so never an extension. */
export function cacheServiceAssetName(target: string) {
  return `erainfra-cache-service-${target}`;
}

/** The targets a release publishes a pinned controller binary for, and `controller` must cover. */
export const CONTROLLER_TARGETS = ["linux-x86_64", "linux-arm64"] as const;

/** The published asset name for a controller target. Linux-only here, so never an extension. */
export function controllerAssetName(target: string) {
  return `runner-center-controller-${target}`;
}
