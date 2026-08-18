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
  version: "0.2.0-rc.7",
  sha256: "eb01df92153f385c729391932261bfed198d64ac8cb6ba5e82fbc75163fedc8b",
  infraAgent: {
    "linux-x86_64": "9ebfef5696545956c37a1a1b8539df42e5bec6f08f214ef0b9490409535862bf",
    "linux-arm64": "0c8827106dc07c990f9bea0ae1b5f345a505c7c72708e6d7e6409d3b55bd9f9d",
    "darwin-x86_64": "ebd72e99008633b63835f81a63cc631d1401b1cbaf4a646b553a81b7312ebf82",
    "darwin-arm64": "9d18807eab987342bbb95416f30d33a6547d22c1329194aee37974c36c49a90b",
    "windows-x86_64": "10ccf5e44ef9406ba317589496398de5c235f44958a1dd6c53568360fdcf391d",
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
