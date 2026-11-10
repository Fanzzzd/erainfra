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
  version: "0.2.0-rc.15",
  // Filled at v0.2.0-rc.11, the first release to publish erainfra-mesh, from the sidecars the
  // release workflow's mesh jobs wrote after building each target twice and comparing.
  mesh: {
    "linux-x86_64": "67a7f8e6a2cf30ec1d71c26f0a86575a9ec0e9098add3dd8db1215cbdf379593",
    "linux-arm64": "e268f1ae4a46522b4cffb688c79dc0557eed654200db93973f525558f36f2ebe",
    "darwin-x86_64": "747acbc630b4ac88fc5a0339af74e489922f12658e6c0e55c5d0a3be3dae3236",
    "darwin-arm64": "81805419de5a2a81ee97d89060752473c2ab93546b85b7d0365f7768c3c3cc8b",
    "windows-x86_64": "f5549ee9b558cc6185b761d9766fffef7ddd150fcfc4bb13302bf2986d3bf290",
  },
  sha256: "fe23709e0c9ec7cdfb5cef9a7a40a1f6ac4e0988ce790dd8486b5678fcb7436e",
  infraAgent: {
    "linux-x86_64": "38196b72702cf81ae1a7dc66124f9ebb6d595f00007a3ff461733d8f4433eeab",
    "linux-arm64": "d6130f986780c7d9876fcab5673ccef8ab33ce1f8e8d09bbb119fd14cbf479ca",
    "darwin-x86_64": "c0a7ac703d6e2a65358fd0b8613df09db08a264b0af6b3696529d81388f32e3c",
    "darwin-arm64": "f50767f52ffc86149741c5e754949d8c86722e63e1cad805f1f2455f8ea1b37d",
    "windows-x86_64": "0423010dad35d127255d072aae194460da84d309535a93c704d17f199a460abb",
  },
  // Populated at v0.2.0-rc.9, the first release to publish the cache-service binary (ADR 0009),
  // exactly as `infraAgent` was filled at v0.2.0-rc.6. Version-only, so the digest is a pure
  // function of source and version, not the release commit it is written into.
  cacheService: {
    "linux-x86_64": "8c669b4948220596f8827246de781ae276e7f0b28e1037d10f33ad6f52f9c2a0",
  },
  // Filled at v0.2.0-rc.11, the first release to build the controller version-only (rc.10 and
  // earlier stamped -X main.commitSHA, so no digest of theirs can be pinned), exactly as
  // `infraAgent` was at rc.6 and `cacheService` at rc.9.
  controller: {
    "linux-x86_64": "4af1cabe03dc6724b8becdec439678e6d13280e63d06b950ebab069aef8cd3fe",
    "linux-arm64": "5e90857ae8fcb259481d28bb037af92ee875931490257c433d094ee4a68946d4",
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
