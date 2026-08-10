import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // convex-test runs functions in a Convex-like isolate; the edge runtime is
    // the closest match to the Convex default runtime.
    environment: "edge-runtime",
    include: ["tests/**/*.test.ts"],
    server: { deps: { inline: ["convex-test"] } },
    // Installer tests spawn complete shell/service-manager sandboxes. They run
    // in parallel with the Agent lifecycle suite under Turbo, so Vitest's 5s
    // unit-test default is not a meaningful budget on a two-core CI runner.
    testTimeout: 30_000,
  },
});
