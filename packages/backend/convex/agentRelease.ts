export type AgentRelease = {
  /** `owner/name` of the repository whose releases carry the packaged agent. */
  repo: string;
  /** Product version, without the leading `v` of the git tag. */
  version: string;
  /** SHA-256 of `runner-center-agent-<version>.tar.gz`. */
  sha256: string;
};

/**
 * The agent build this deployment installs.
 *
 * Runner Center ships as one product: tagging `v<version>` publishes an
 * immutable `runner-center-agent-<version>.tar.gz` asset, and machines install
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
 */
export const AGENT_RELEASE: AgentRelease = {
  repo: "Fanzzzd/runner-center",
  version: "0.1.1",
  sha256: "f175c517574e201db6f8e918d706809e014c96d8eb6fb1e2ac1184a949952676",
};
