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
  version: "0.2.0-rc.20",
  // Filled at v0.2.0-rc.11, the first release to publish erainfra-mesh, from the sidecars the
  // release workflow's mesh jobs wrote after building each target twice and comparing.
  mesh: {
    "linux-x86_64": "b4df7649d0cdb5a675122c092ccf5281457ae2fc81ee682c99b1f6647393fb81",
    "linux-arm64": "9fb5f1a6967c7667197ceec743c1b75cd86ed41f1a0c7ed26ef5434fa14520fb",
    "darwin-x86_64": "44a541158417d4e763150292db6499fda55e0d9ec3a235440a6b24b3e756e6c3",
    "darwin-arm64": "885085902edb18a601d3d3509ad76100123dc930f13ee26d0e2bd832dab6fddf",
    "windows-x86_64": "54f59ecb6d74ce932918c53a3a25f1de6a3d4ac9a363a78dd0708903e95f8a3c",
  },
  sha256: "3344d77425c2a1be635202e6ac893346fce1a55135cf2d5b488c2764a4d41b22",
  infraAgent: {
    "linux-x86_64": "1978472d69f32e31685954b06a892e4df6b998f03de9f7e6e86fc4948dd60760",
    "linux-arm64": "ee8d87e565d1126ac2452d1f25c1c6acc4a36c69d385015d47d85e2910144ca3",
    "darwin-x86_64": "9a3694997f4f1b1f46ead2639798e565bfae8f2ca48cf6d37790021d1e71c475",
    "darwin-arm64": "59c385817d43e711720e57192f2d3cd4fe755dca85cc75be9fa3fe4e52913e07",
    "windows-x86_64": "1f9cc7c8e40d18f3691b9a49950da777e61f31621a116591e0c3d0b81f6f870e",
  },
  // Populated at v0.2.0-rc.9, the first release to publish the cache-service binary (ADR 0009),
  // exactly as `infraAgent` was filled at v0.2.0-rc.6. Version-only, so the digest is a pure
  // function of source and version, not the release commit it is written into.
  cacheService: {
    "linux-x86_64": "421598c47bce8020770312f95f0d50feedf314dbb4501b011312aa5bd0120087",
  },
  // Filled at v0.2.0-rc.11, the first release to build the controller version-only (rc.10 and
  // earlier stamped -X main.commitSHA, so no digest of theirs can be pinned), exactly as
  // `infraAgent` was at rc.6 and `cacheService` at rc.9.
  controller: {
    "linux-x86_64": "76da4e63e7a716bf963f7f7788a81340a568704b0b78ef870b9fdfd22911d696",
    "linux-arm64": "ec5c1053f7816d66a70b755aea7ad4d703682c26785a6d2842aa82d29d77643b",
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
