// convex-test runs scheduled functions and crons can name the real `github` actions, which reach
// Octokit and the network. This stand-in keeps those tests hermetic.
export async function githubMock() {
  const { v } = await import("convex/values");
  const { internalAction } = await import("../../convex/_generated/server");

  return {
    // Referenced by crons.ts. The real one fetches the actions/runner release list; parsing and
    // the expiry rule are tested directly in tests/runnerReleases.test.ts, and the credential it
    // reads with in tests/githubAuth.test.ts.
    refreshRunnerReleases: internalAction({
      args: {},
      returns: v.null(),
      handler: async () => null,
    }),
  };
}
