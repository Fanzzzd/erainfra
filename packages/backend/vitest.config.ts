import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // convex-test runs functions in a Convex-like isolate; the edge runtime is
    // the closest match to the Convex default runtime.
    environment: "edge-runtime",
    include: ["tests/**/*.test.ts"],
    server: { deps: { inline: ["convex-test"] } },
  },
});
