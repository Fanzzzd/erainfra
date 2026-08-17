import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// The nineteen harnesses under scripts/verify are the only coverage the fresh-box, multi-node, WSL,
// Windows and failover paths have, and they reach the Hub by relative path rather than by package
// name. That makes them silently breakable by exactly the kind of directory move this file was added
// alongside: nothing runs them in CI (they need docker and real machines), so an orphaned import
// surfaces months later as a harness that will not start.
//
// The design for this move wanted `scripts` in tsconfig's `include`, so that `pnpm typecheck` would
// be what notices. It is not there yet, and the reason is worth writing down: adding it turns up
// forty errors in eight of the nineteen, none of them caused by the move. verify-mesh.ts imports
// MeshManager from src/runtime/mesh.ts, a module that no longer exists anywhere in the Hub — that
// harness outlived its subject. The other seven call upload.deploy with its pre-async shape: the
// procedure now takes { buildId, app, port, buildNode, node, confirm } and returns a deployId to
// poll via apps.status, and they still pass `name`/`deployNode` and read `.ok`/`.stage`/`.error`
// off the reply. Rewriting the success condition of an end-to-end test that needs docker and real
// machines is authoring new assertions, not moving a file, so the `include` lands with that repair.
//
// This check is what covers all nineteen in the meantime, for the one property a directory move can
// break on its own: every relative import resolves to a file that exists.
const VERIFY_DIR = join(import.meta.dirname, "../scripts/verify");

// verify-mesh.ts is not drift, it is a harness that outlived its subject: src/runtime/mesh.ts was
// removed from the Hub and nothing replaced it. Recorded here rather than deleted, because deleting
// an end-to-end harness is a decision with an owner. The assertion below is deliberately two-sided —
// if the module comes back, this entry has to go, and the suite says so.
const OUTLIVED_ITS_SUBJECT = new Map([["verify-mesh.ts", "../../src/runtime/mesh.ts"]]);

const RELATIVE_IMPORT = /(?:^|\n)\s*(?:import|export)[^\n]*?from\s+["'](\.[^"']+)["']/g;

test("every relative import in scripts/verify resolves", () => {
  const files = readdirSync(VERIFY_DIR).filter((f) => f.endsWith(".ts"));
  assert.ok(files.length > 0, `no harnesses found in ${VERIFY_DIR}`);

  const broken: string[] = [];
  for (const file of files) {
    const source = readFileSync(join(VERIFY_DIR, file), "utf8");
    for (const [, specifier] of source.matchAll(RELATIVE_IMPORT)) {
      const known = OUTLIVED_ITS_SUBJECT.get(file);
      const target = resolve(dirname(join(VERIFY_DIR, file)), specifier);
      if (existsSync(target)) {
        assert.notEqual(
          specifier,
          known,
          `${file}: ${specifier} resolves again — drop its OUTLIVED_ITS_SUBJECT entry`,
        );
        continue;
      }
      if (specifier === known) continue;
      broken.push(`${file} → ${specifier}`);
    }
  }
  assert.deepEqual(broken, [], `harness imports that no longer resolve:\n  ${broken.join("\n  ")}`);
});
