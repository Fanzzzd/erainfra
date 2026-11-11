// Runs the backend's test suite on the Cloudflare platform runtime instead of convex-test
// (ADR 0019). `pnpm test:platform`.
import { fileURLToPath } from "node:url";

import { defineConfig, mergeConfig } from "vitest/config";

import base from "./vitest.config.ts";

export default mergeConfig(
  base,
  defineConfig({
    test: {
      // node:sqlite needs Node, not the edge runtime.
      environment: "node",
      alias: {
        "convex-test": fileURLToPath(
          new URL("../platform/src/testing/convexTest.ts", import.meta.url),
        ),
      },
    },
  }),
);
