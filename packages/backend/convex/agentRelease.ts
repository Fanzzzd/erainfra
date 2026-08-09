export type AgentRelease = {
  /** `owner/name` of the repository whose releases carry the packaged agent. */
  repo: string;
  /** Product version, without the leading `v` of the git tag. */
  version: string;
  /** SHA-256 of `runner-center-agent-<version>.tar.gz`, or "" until published. */
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
 * This constant is the fleet's rollout pointer, and publishing a release does
 * not move it. Once the release exists, set `version` and `sha256` to the
 * published values and run `pnpm deploy`; rolling the fleet back is the same
 * edit with the previous values. Because the install script is served by this
 * deployment over TLS, `sha256` is a trust root outside the release itself, so
 * an archive that matches the release but not this pin is rejected.
 *
 * `sha256` may be empty only before its release has been published; installs
 * then fall back to the checksum published beside the asset.
 */
export const AGENT_RELEASE: AgentRelease = {
  repo: "Fanzzzd/runner-center",
  version: "0.1.0",
  sha256: "",
};
