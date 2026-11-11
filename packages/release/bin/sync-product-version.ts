import path from "node:path";
import { syncProductVersion } from "../src/product-version.ts";

// Runs after `changeset version` (root script `release:version`). Changesets bumps the fixed
// product group; this copies that version to the root package.json, the mesh crate, the agent's
// npm lockfile and AGENT_RELEASE.version.
const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const { version, changed } = syncProductVersion(repoRoot);
console.log(`product version ${version}`);
for (const file of changed) console.log(`  updated ${file}`);
