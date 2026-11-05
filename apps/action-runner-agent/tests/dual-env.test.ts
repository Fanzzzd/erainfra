import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertNoDualEnvConflicts,
  childEnvironment,
  dualEnv,
  DualEnvConflictError,
  newName,
  runtimeBinary,
} from "../dual-env.ts";
import { attemptEnvironment, attemptInvocation } from "../provision.ts";

const AGENT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("dualEnv", () => {
  const cases: {
    name: string;
    env: NodeJS.ProcessEnv;
    want?: string;
    conflict?: true;
  }[] = [
    // Every Worker in the field today.
    { name: "only the legacy name", env: { RC_PROFILE: "old" }, want: "old" },
    { name: "only the new name", env: { ERAINFRA_PROFILE: "new" }, want: "new" },
    { name: "both, equal", env: { ERAINFRA_PROFILE: "same", RC_PROFILE: "same" }, want: "same" },
    {
      name: "both, different",
      env: { ERAINFRA_PROFILE: "value-under-new", RC_PROFILE: "value-under-old" },
      conflict: true,
    },
    { name: "neither", env: {}, want: undefined },
    // `process.env.RC_X?.trim() || default` treated empty as unset, so both
    // names still do, and an empty name cannot conflict with a set one.
    {
      name: "new empty, legacy set",
      env: { ERAINFRA_PROFILE: "", RC_PROFILE: "old" },
      want: "old",
    },
    {
      name: "legacy empty, new set",
      env: { ERAINFRA_PROFILE: "new", RC_PROFILE: "" },
      want: "new",
    },
    { name: "both empty", env: { ERAINFRA_PROFILE: "", RC_PROFILE: "" }, want: undefined },
  ];
  for (const testCase of cases) {
    it(testCase.name, () => {
      if (testCase.conflict) {
        assert.throws(
          () => dualEnv("RC_PROFILE", testCase.env),
          (error: unknown) => {
            assert.ok(error instanceof DualEnvConflictError);
            assert.match(error.message, /ERAINFRA_PROFILE and RC_PROFILE/);
            // Some of these variables are secrets.
            assert.doesNotMatch(error.message, /value-under/);
            return true;
          },
        );
        return;
      }
      assert.equal(dualEnv("RC_PROFILE", testCase.env), testCase.want);
    });
  }

  it("refuses a name that is not an RC_ name", () => {
    assert.equal(newName("RC_HOME"), "ERAINFRA_HOME");
    assert.throws(() => newName("RC_"), /not an RC_ variable name/);
    assert.throws(() => newName("HOME" as `RC_${string}`), /not an RC_ variable name/);
  });
});

describe("assertNoDualEnvConflicts", () => {
  it("accepts legacy names, new names and agreeing pairs", () => {
    assertNoDualEnvConflicts({
      RC_HOME: "/home/w/.runner-center",
      ERAINFRA_RUNTIME_BINARY: "/opt/runtime",
      ERAINFRA_PROFILE: "linux",
      RC_PROFILE: "linux",
      ERAINFRA_CACHE_URL: "http://cache.internal",
    });
  });

  it("names every conflicting pair, sorted, without values", () => {
    assert.throws(
      () =>
        assertNoDualEnvConflicts({
          RC_RUNTIME_SOCKET: "/run/a.sock",
          ERAINFRA_RUNTIME_SOCKET: "/run/b.sock",
          RC_HOME: "/a",
          ERAINFRA_HOME: "/b",
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.deepEqual(
          error.message.split("\n").map((line) => line.split(" ").slice(0, 3).join(" ")),
          ["ERAINFRA_HOME and RC_HOME", "ERAINFRA_RUNTIME_SOCKET and RC_RUNTIME_SOCKET"],
        );
        assert.doesNotMatch(error.message, /\/run\/|\/a|\/b/);
        return true;
      },
    );
  });
});

describe("childEnvironment", () => {
  it("drops an inherited ERAINFRA_ twin of every RC_ name the Agent decides", () => {
    // The Agent decided this Attempt is public egress (RC_PROFILE_EGRESS="").
    // An ERAINFRA_PROFILE_EGRESS the Agent itself was started with must not win
    // over that in the runtime's dual read, which treats empty as unset.
    const env = childEnvironment(
      { RC_PROFILE: "linux", RC_PROFILE_EGRESS: "" },
      {
        ERAINFRA_PROFILE: "stale",
        ERAINFRA_PROFILE_EGRESS: '{"mode":"allowlist"}',
        ERAINFRA_HOME: "/kept",
        PATH: "/usr/bin",
      },
    );
    assert.equal(env.RC_PROFILE, "linux");
    assert.equal(env.RC_PROFILE_EGRESS, "");
    assert.equal(env.ERAINFRA_PROFILE, undefined);
    assert.equal(env.ERAINFRA_PROFILE_EGRESS, undefined);
    // Names the Agent did not decide pass through for the child's own read.
    assert.equal(env.ERAINFRA_HOME, "/kept");
    assert.equal(env.PATH, "/usr/bin");
  });

  it("writes the legacy name, which a previous-release child still reads", () => {
    const env = childEnvironment({ RC_VCPUS: "4" }, {});
    assert.deepEqual(env, { RC_VCPUS: "4" });
  });
});

describe("attemptEnvironment", () => {
  it("never lets an inherited ERAINFRA_ name stand in for what the Attempt decided", () => {
    const saved = { ...process.env };
    try {
      process.env.ERAINFRA_PROFILE = "inherited";
      process.env.ERAINFRA_PROFILE_EGRESS = '{"mode":"allowlist","presets":["github"]}';
      process.env.ERAINFRA_EGRESS_RECORD_FILE = "/tmp/inherited.json";
      const { env } = attemptInvocation({
        attemptId: "attempt-1",
        runnerName: "runner-1",
        profile: "linux-js",
        executor: "firecracker",
        imageRelease: `ghcr.io/example/runner@sha256:${"a".repeat(64)}`,
        vcpus: 4,
        memoryMiB: 16384,
      } as Parameters<typeof attemptInvocation>[0]);
      const child = attemptEnvironment(env);
      assert.equal(child.RC_PROFILE, "linux-js");
      assert.equal(child.RC_PROFILE_EGRESS, "");
      assert.equal(child.ERAINFRA_PROFILE, undefined);
      assert.equal(child.ERAINFRA_PROFILE_EGRESS, undefined);
      assert.equal(child.ERAINFRA_EGRESS_RECORD_FILE, undefined);
    } finally {
      for (const name of Object.keys(process.env)) delete process.env[name];
      Object.assign(process.env, saved);
    }
  });
});

describe("runtimeBinary", () => {
  it("prefers the new name and falls back to the installed default", () => {
    assert.equal(runtimeBinary({ ERAINFRA_RUNTIME_BINARY: "/new", RC_RUNTIME_BINARY: "" }), "/new");
    assert.equal(runtimeBinary({ RC_RUNTIME_BINARY: "/old" }), "/old");
    assert.equal(runtimeBinary({}), "runner-center-runtime");
    assert.equal(runtimeBinary({ RC_RUNTIME_BINARY: "  " }), "runner-center-runtime");
  });
});

// The helper protects only the reads that go through it. A raw
// `process.env.RC_X` added to any Agent module reads one name and silently
// ignores the other, and nothing else would notice.
describe("every RC_ read in the Agent", () => {
  it("goes through dual-env.ts", () => {
    const sources = readdirSync(AGENT_DIR).filter(
      (name) => name.endsWith(".ts") && name !== "dual-env.ts",
    );
    assert.ok(sources.length >= 8, `found only ${sources.length} Agent sources in ${AGENT_DIR}`);
    const raw = /process\.env(\.RC_[A-Z0-9_]+|\[\s*["'`]RC_)/g;
    const offenders = sources.flatMap((name) =>
      [...readFileSync(join(AGENT_DIR, name), "utf8").matchAll(raw)].map(
        (match) => `${name}: ${match[0]}`,
      ),
    );
    assert.deepEqual(offenders, []);
  });
});
