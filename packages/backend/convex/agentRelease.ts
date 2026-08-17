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
 * Agent's unverified download. It is empty here because no published release carries those
 * binaries yet: the first tag cut after they are built in CI is what fills it in, generated from
 * the sidecars with `pnpm --filter @erainfra/backend print-infra-agent-pin` rather than typed by
 * hand, and the release workflow refuses to publish a tag whose pin disagrees with the bytes it
 * just built. Until then the installer refuses `--role node` rather than installing something it
 * cannot check.
 */
export const AGENT_RELEASE: AgentRelease = {
  repo: "Fanzzzd/erainfra",
  version: "0.2.0-rc.5",
  sha256: "ea39b72d559c81f9e74864472f92f736b49184d4f992db1b56249bb7bc31c1f1",
  infraAgent: {},
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
