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
  version: "0.2.0-rc.26",
  // Filled at v0.2.0-rc.11, the first release to publish erainfra-mesh, from the sidecars the
  // release workflow's mesh jobs wrote after building each target twice and comparing.
  mesh: {
    "linux-x86_64": "da0a70f0547b066407fed877739ce10ec52d28594a0a95f637dbfae43499dbd4",
    "linux-arm64": "45fd81e78ec4d7830e6b1fd4c4b51ebe5e1387fedc1b526c460859da94bad82e",
    "darwin-x86_64": "159d9caaef982d18b34c3a4d72ff6ae6ef1c59d821a0943f398721545cce23c1",
    "darwin-arm64": "f2fd64e2582ccead786b867d76199500560b11e981f95d3db7a76e96f0a8ddea",
    "windows-x86_64": "a6883be901b203c6979f425c347d59a66ef1bd81d97c49fe0cf8b3c55fc833a6",
  },
  sha256: "fe2dbdc960ea29ce046b12b93730a242f7aa8bbce45f76eb39e92bf219d40942",
  infraAgent: {
    "linux-x86_64": "bb2d3adcbb51b8fb6922179eb216c6766a257856df84e150c05838a5f59790fb",
    "linux-arm64": "506b0524280f9d081b6bfc7d9a26844941c3f9631c73797e88013de6fd02ddd8",
    "darwin-x86_64": "e150adfc149217589851e5332054cdbc722f69b584b5ef6969416f44a5af51ed",
    "darwin-arm64": "f8f98627591c78831a4a41b3775d042f91cab734eba3b579e2e05e88758dd9ef",
    "windows-x86_64": "c09b4fb8c5161822e5def0d0c6858492483b833d503ec079e1f61237ce0b437d",
  },
  // Populated at v0.2.0-rc.9, the first release to publish the cache-service binary (ADR 0009),
  // exactly as `infraAgent` was filled at v0.2.0-rc.6. Version-only, so the digest is a pure
  // function of source and version, not the release commit it is written into.
  cacheService: {
    "linux-x86_64": "32a99cbbb1f66f743aa8cd6b1cb387c84b7df8ae93ec985ff718aca758a7c192",
  },
  // Filled at v0.2.0-rc.11, the first release to build the controller version-only (rc.10 and
  // earlier stamped -X main.commitSHA, so no digest of theirs can be pinned), exactly as
  // `infraAgent` was at rc.6 and `cacheService` at rc.9.
  controller: {
    "linux-x86_64": "c82999cb3b7e88b2957d5762e6cb2b43767edeea424b941dda6ce09c1c9a21a7",
    "linux-arm64": "4eb72a262918b7112a49069a4275df2edab51995304070fe0029fa49543e2a31",
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
