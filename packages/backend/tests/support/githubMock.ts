// convex-test runs scheduled functions, so tryAssign/reconcile would otherwise
// drive the real `github` actions into Octokit and the network. These stand-ins
// keep the state-machine tests hermetic; the GitHub calls themselves are
// exercised against a live deployment, not here.
export async function githubMock() {
  const { v } = await import("convex/values");
  const { internalAction } = await import("../../convex/_generated/server");

  return {
    issueJit: internalAction({
      args: {
        commandId: v.id("commands"),
        jobId: v.id("jobs"),
        repo: v.string(),
        githubInstallationId: v.optional(v.number()),
        runnerName: v.string(),
        labels: v.array(v.string()),
      },
      returns: v.null(),
      handler: async () => null,
    }),
    drainRunnerDeletions: internalAction({
      args: {},
      returns: v.object({ deleted: v.number(), failed: v.number() }),
      handler: async () => ({ deleted: 0, failed: 0 }),
    }),
    // Referenced by crons.ts. The real one lists and redelivers over the
    // network; its orchestration is tested directly through runRecovery with
    // injected dependencies in tests/recovery.test.ts.
    recoverLostDeliveries: internalAction({
      args: {},
      returns: v.object({ listed: v.number(), missing: v.number(), requested: v.number() }),
      handler: async () => ({ listed: 0, missing: 0, requested: 0 }),
    }),
  };
}
