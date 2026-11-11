// The PowerShell copy of the dual-name read, in provision-win.ps1.
//
// PowerShell is not a dependency of this repository, so the executed half runs
// only where `pwsh` is on PATH (CI's runner image ships it) and skips
// elsewhere. The static half runs everywhere.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { PROVISION_WIN } from "./helpers/harness.ts";

const SOURCE = readFileSync(PROVISION_WIN, "utf8");
const HELPER = /^function Resolve-DualEnv\(\[string\] \$Name\) \{\n[\s\S]*?\n\}\n/m.exec(
  SOURCE,
)?.[0];

const located = spawnSync("sh", ["-c", "command -v pwsh"], { encoding: "utf8" });
const PWSH = located.status === 0 ? located.stdout.trim() : undefined;

describe("provision-win.ps1 Resolve-DualEnv", () => {
  it("is defined, and resolves every RC_ variable the script reads before reading it", () => {
    assert.ok(HELPER, "provision-win.ps1 has no Resolve-DualEnv");
    const resolved = /foreach \(\$dualName in @\(([^)]*)\)\)/.exec(SOURCE);
    assert.ok(resolved, "provision-win.ps1 never calls Resolve-DualEnv");
    const names = new Set([...resolved[1].matchAll(/'(RC_[A-Z0-9_]+)'/g)].map((match) => match[1]));
    const read = [
      ...SOURCE.matchAll(
        /Get-(?:EnvOrDefault|TimeoutEnv|PositiveIntEnv|RequiredEnv) '(RC_[A-Z0-9_]+)'/g,
      ),
    ].map((match) => match[1]);
    assert.ok(read.length >= 3, `found only ${read.length} RC_ reads`);
    for (const name of read) {
      assert.ok(names.has(name), `${name} is read but never passed to Resolve-DualEnv`);
      assert.ok(
        SOURCE.indexOf(resolved[0]) < SOURCE.indexOf(`'${name}'`, SOURCE.indexOf(resolved[0]) + 1),
        `${name} is resolved after it is read`,
      );
    }
  });

  const run = (env: Record<string, string>) => {
    const script = `$ErrorActionPreference = 'Stop'\n${HELPER}\nResolve-DualEnv 'RC_HOME'\n[Console]::Out.Write([Environment]::GetEnvironmentVariable('RC_HOME'))`;
    const result = spawnSync(
      PWSH ?? "pwsh",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
        encoding: "utf8",
      },
    );
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  };

  const cases: { name: string; env: Record<string, string>; want?: string; conflict?: true }[] = [
    { name: "only the legacy name", env: { RC_HOME: "C:\\old" }, want: "C:\\old" },
    { name: "only the new name", env: { ERAINFRA_HOME: "C:\\new" }, want: "C:\\new" },
    {
      name: "both, equal",
      env: { ERAINFRA_HOME: "C:\\same", RC_HOME: "C:\\same" },
      want: "C:\\same",
    },
    {
      name: "both, different",
      env: { ERAINFRA_HOME: "C:\\value-under-new", RC_HOME: "C:\\value-under-old" },
      conflict: true,
    },
    // -ne would call these equal.
    {
      name: "differ only in case",
      env: { ERAINFRA_HOME: "C:\\Work", RC_HOME: "C:\\work" },
      conflict: true,
    },
    {
      name: "new blank, legacy set",
      env: { ERAINFRA_HOME: " ", RC_HOME: "C:\\old" },
      want: "C:\\old",
    },
    { name: "neither", env: {}, want: "" },
  ];
  for (const testCase of cases) {
    it(testCase.name, { skip: PWSH === undefined && "pwsh is not on PATH" }, () => {
      const result = run(testCase.env);
      if (testCase.conflict) {
        assert.notEqual(result.code, 0);
        assert.match(result.stderr + result.stdout, /ERAINFRA_HOME and RC_HOME are both set/);
        assert.doesNotMatch(result.stderr + result.stdout, /value-under/);
        return;
      }
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout, testCase.want);
    });
  }
});
