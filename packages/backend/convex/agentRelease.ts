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
  version: "0.2.0-rc.12",
  // Filled at v0.2.0-rc.11, the first release to publish erainfra-mesh, from the sidecars the
  // release workflow's mesh jobs wrote after building each target twice and comparing.
  mesh: {
    "linux-x86_64": "860a2178352ae8e93a49403b52cce2ad2a18d21c71191977605ddf0f263cf64d",
    "linux-arm64": "9eb778f610bd474bfbefac78e5d65c175f5f324545c4cfc37210fea40b034925",
    "darwin-x86_64": "1d72bd442e53f43018900eebb1ad1bf61d8782cd1f851bdbcc42f4465684da52",
    "darwin-arm64": "c62caadce59a580e17297d8c6aed8a6ca6e6529083d59d5609ef3a1fb8055229",
    "windows-x86_64": "6029a9c1520c29def3f1a0c910f0a768e548ff4b6fd5aa0e998016558f100d3b",
  },
  sha256: "f3c6f990f61b033ffc455b233bebff40236c9c8c7048219a1bb51f00dda7fa4a",
  infraAgent: {
    "linux-x86_64": "c8edc5219eaf5f276f091df9f42c1cc48756d020a55c454bba4cde99a35130ab",
    "linux-arm64": "c7c8a1268dad63df6e95e142308c9b6e39b121e565e7c78620214e2cae5306f7",
    "darwin-x86_64": "abee078c985346e8709c82919b1b5a5eb23bf8d8547d0b243491bee4029844b6",
    "darwin-arm64": "3d58d2147e5a4c1e8ff626b7b75b26fc0a2bc247b3f3e417f02f3717c6c6f33c",
    "windows-x86_64": "c9c01df32a455f9e42b9da58b0ef7919a59f83ed18e5a1312d39f43b777f2b9c",
  },
  // Populated at v0.2.0-rc.9, the first release to publish the cache-service binary (ADR 0009),
  // exactly as `infraAgent` was filled at v0.2.0-rc.6. Version-only, so the digest is a pure
  // function of source and version, not the release commit it is written into.
  cacheService: {
    "linux-x86_64": "1c220dba0a3af9a9c6005a5184a106a23466f744175b3a0689ac8bfb5ef0892c",
  },
  // Filled at v0.2.0-rc.11, the first release to build the controller version-only (rc.10 and
  // earlier stamped -X main.commitSHA, so no digest of theirs can be pinned), exactly as
  // `infraAgent` was at rc.6 and `cacheService` at rc.9.
  controller: {
    "linux-x86_64": "6bf35de0b50a767efc712b4e11613aebaefd5258b771d8c9f5ec23306492b8cc",
    "linux-arm64": "af74f62958392773f4e1667b35852468f9dcb697f27747476cafee9897b18955",
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
