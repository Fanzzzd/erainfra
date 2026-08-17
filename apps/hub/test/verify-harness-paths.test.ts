import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// The harnesses under scripts/verify are the only coverage the fresh-box, multi-node, WSL, Windows
// and failover paths have, and they reach the Hub by relative path rather than by package name.
// That makes them silently breakable by exactly the kind of directory move this file was added
// alongside: nothing runs them in CI (they need docker and real machines), so an orphaned import
// surfaces months later as a harness that will not start.
//
// scripts/verify is now inside apps/hub/tsconfig.json's `include`, so `pnpm typecheck` is what
// notices a broken import — which was the whole point of issue #62. This check is kept anyway
// because it is cheap and it is not the same check: tsc reads the eighteen files the project
// resolves, while this reads every .ts file in the directory and asserts the specifier text
// resolves to something on disk. A file that tsc skips for any reason still gets read here.
const VERIFY_DIR = join(import.meta.dirname, "../scripts/verify");

// verify-mesh.ts was deleted, not repaired, because its subject was gone: it drove a MeshManager
// that ran dumbpipe/iroh sidecars inside the Hub, and the mesh moved OUT of the Hub onto the Node.
// The Hub brokers links now (agents.linkService → the agent's meshShare/meshConnect, healed by
// appdeploy.ts) and verify-meshlink.ts covers that path end to end.
//
// The assertion below is the two-sided half of that decision, and it is why this constant outlives
// the file it names: the delete was justified by src/runtime/mesh.ts being gone, so if that module
// ever comes back, the justification is void and this suite says so — a harness deleted on a
// premise has to come back with the premise.
const DELETED_WITH_THEIR_SUBJECT = new Map([["verify-mesh.ts", "src/runtime/mesh.ts"]]);

const RELATIVE_IMPORT = /(?:^|\n)\s*(?:import|export)[^\n]*?from\s+["'](\.[^"']+)["']/g;

test("every relative import in scripts/verify resolves", () => {
  const files = readdirSync(VERIFY_DIR).filter((f) => f.endsWith(".ts"));
  assert.ok(files.length > 0, `no harnesses found in ${VERIFY_DIR}`);

  const broken: string[] = [];
  for (const file of files) {
    const source = readFileSync(join(VERIFY_DIR, file), "utf8");
    for (const [, specifier] of source.matchAll(RELATIVE_IMPORT)) {
      const target = resolve(dirname(join(VERIFY_DIR, file)), specifier);
      if (!existsSync(target)) broken.push(`${file} → ${specifier}`);
    }
  }
  assert.deepEqual(broken, [], `harness imports that no longer resolve:\n  ${broken.join("\n  ")}`);
});

test("a harness deleted because its subject was gone stays gone only while its subject is", () => {
  const hubRoot = join(import.meta.dirname, "..");
  for (const [harness, subject] of DELETED_WITH_THEIR_SUBJECT) {
    // Side one: the record must describe a file that is actually deleted. A stale entry here would
    // quietly assert nothing, which is the failure mode a map like this has.
    assert.equal(
      existsSync(join(VERIFY_DIR, harness)),
      false,
      `${harness} exists again — drop its DELETED_WITH_THEIR_SUBJECT entry`,
    );
    // Side two: the subject must still be gone. If it returns, the reason for deleting the harness
    // has evaporated and the harness owes us a decision again.
    assert.equal(
      existsSync(join(hubRoot, subject)),
      false,
      `${subject} is back — ${harness} was deleted because it was not, so reinstate the harness ` +
        `(git show 5545eb1:apps/hub/scripts/verify/${harness}) or record why it is no longer wanted`,
    );
  }
});
