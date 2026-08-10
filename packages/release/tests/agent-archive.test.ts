import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import {
  archiveName,
  buildAgentArchive,
  checksumLine,
  collectAgentFiles,
  readProductVersion,
} from "../src/agent-archive.ts";

const workspaces: string[] = [];

after(() => {
  for (const directory of workspaces) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** A stand-in for `apps/agent` after a build, so tests never read the real tree. */
function agentFixture(overrides: Record<string, string | null> = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "rc-agent-"));
  workspaces.push(root);
  const files: Record<string, string | null> = {
    "package.json": '{"name":"@runner-center/agent","version":"1.2.3"}\n',
    "package-lock.json": '{"lockfileVersion":3}\n',
    "tsconfig.json": "{}\n",
    "index.ts": "// source, not shipped\n",
    "dist/index.js": "console.log('agent');\n",
    "dist/index.js.map": '{"version":3}\n',
    "dist/config.js": "export const config = {};\n",
    "provisioners/provision-linux.sh": "#!/usr/bin/env bash\n",
    "provisioners/provision-win.ps1": "Write-Output 'hi'\n",
    ...overrides,
  };
  for (const [relativePath, contents] of Object.entries(files)) {
    if (contents === null) {
      continue;
    }
    const target = path.join(root, relativePath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  return root;
}

function runtimeFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "rc-runtime-"));
  workspaces.push(root);
  for (const platform of ["linux-x86_64", "linux-arm64"]) {
    const target = path.join(root, platform, "runner-center-runtime");
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, `runtime for ${platform}\n`);
  }
  return root;
}

describe("collectAgentFiles", () => {
  it("ships the runtime, the lockfile, and the provisioners, and nothing else", () => {
    const entries = collectAgentFiles(agentFixture());
    const files = entries.filter((entry) => !entry.path.endsWith("/")).map((entry) => entry.path);

    assert.deepEqual(files, [
      "agent/dist/config.js",
      "agent/dist/index.js",
      "agent/package-lock.json",
      "agent/package.json",
      "agent/provisioners/provision-linux.sh",
      "agent/provisioners/provision-win.ps1",
    ]);
  });

  it("emits parent directories before their children", () => {
    const paths = collectAgentFiles(agentFixture()).map((entry) => entry.path);
    assert.deepEqual(paths, paths.toSorted());
    assert.ok(paths.indexOf("agent/") < paths.indexOf("agent/dist/"));
    assert.ok(paths.indexOf("agent/dist/") < paths.indexOf("agent/dist/index.js"));
  });

  it("marks shell provisioners executable and everything else read-only", () => {
    const modes = new Map(collectAgentFiles(agentFixture()).map((e) => [e.path, e.mode]));
    assert.equal(modes.get("agent/provisioners/provision-linux.sh"), 0o755);
    assert.equal(modes.get("agent/provisioners/provision-win.ps1"), 0o644);
    assert.equal(modes.get("agent/package.json"), 0o644);
    assert.equal(modes.get("agent/dist/"), 0o755);
  });

  it("refuses to package an agent that has not been built", () => {
    const root = agentFixture({ "dist/index.js": null });
    assert.throws(() => collectAgentFiles(root), /dist\/index\.js is missing/);
  });

  it("can include both immutable Linux runtime binaries", () => {
    const entries = collectAgentFiles(agentFixture(), runtimeFixture());
    const runtimeEntries = entries.filter((entry) => entry.path.includes("/runtime/"));
    assert.deepEqual(
      runtimeEntries.filter((entry) => !entry.path.endsWith("/")).map((entry) => entry.path),
      [
        "agent/runtime/linux-arm64/runner-center-runtime",
        "agent/runtime/linux-x86_64/runner-center-runtime",
      ],
    );
    assert.ok(runtimeEntries.every((entry) => entry.mode === 0o755));
  });
});

describe("buildAgentArchive", () => {
  it("is reproducible across runs and across source trees with the same contents", () => {
    const first = buildAgentArchive(collectAgentFiles(agentFixture()));
    const second = buildAgentArchive(collectAgentFiles(agentFixture()));

    assert.equal(first.sha256, second.sha256);
    assert.deepEqual(first.archive, second.archive);
    assert.match(first.sha256, /^[0-9a-f]{64}$/);
  });

  it("changes the checksum when any shipped byte changes", () => {
    const baseline = buildAgentArchive(collectAgentFiles(agentFixture()));
    const changed = buildAgentArchive(
      collectAgentFiles(agentFixture({ "dist/index.js": "console.log('tampered');\n" })),
    );

    assert.notEqual(baseline.sha256, changed.sha256);
  });

  it("ignores changes to files that are not shipped", () => {
    const baseline = buildAgentArchive(collectAgentFiles(agentFixture()));
    const changed = buildAgentArchive(
      collectAgentFiles(agentFixture({ "index.ts": "// edited source\n" })),
    );

    assert.equal(baseline.sha256, changed.sha256);
  });
});

describe("release naming", () => {
  it("names the asset after the product version", () => {
    assert.equal(archiveName("1.2.3"), "runner-center-agent-1.2.3.tar.gz");
  });

  it("writes a checksum line that sha256sum and shasum can verify", () => {
    const line = checksumLine("a".repeat(64), "runner-center-agent-1.2.3.tar.gz");
    assert.equal(line, `${"a".repeat(64)}  runner-center-agent-1.2.3.tar.gz\n`);
  });
});

describe("readProductVersion", () => {
  function repoFixture(rootVersion: string, agentVersion: string) {
    const root = mkdtempSync(path.join(tmpdir(), "rc-repo-"));
    workspaces.push(root);
    writeFileSync(path.join(root, "package.json"), `{"version":"${rootVersion}"}`);
    mkdirSync(path.join(root, "apps", "agent"), { recursive: true });
    writeFileSync(
      path.join(root, "apps", "agent", "package.json"),
      `{"version":"${agentVersion}"}`,
    );
    for (const app of ["controller", "runtime"]) {
      mkdirSync(path.join(root, "apps", app), { recursive: true });
      writeFileSync(path.join(root, "apps", app, "package.json"), `{"version":"${rootVersion}"}`);
    }
    return root;
  }

  it("returns the single version the whole product shares", () => {
    assert.equal(readProductVersion(repoFixture("2.0.0", "2.0.0")), "2.0.0");
  });

  it("refuses to package when the agent version has drifted from the root", () => {
    assert.throws(() => readProductVersion(repoFixture("2.0.0", "1.9.0")), /Version drift/);
  });

  it("keeps the real repository in sync", () => {
    const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
    assert.match(readProductVersion(repoRoot), /^\d+\.\d+\.\d+/);
  });
});
